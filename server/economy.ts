// Everything that moves coins or items on Serble goes through a transaction proposal the user
// approves on serble.net. We record each one, then apply its effect exactly once when Serble
// confirms the outcome (on the user's return, or from the background poller).
import { db, tx, logEvent } from "./db.ts";
import { config, coinsToRaw, rawToCoins } from "./config.ts";
import { serble, SerbleError } from "./serble.ts";
import { GameError, addSeed, bloomView, type BloomRow } from "./game.ts";
import { wildGenome, mulberry32, type Genome } from "../shared/genome.ts";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { iconKey } from "../shared/icons.ts";

// Item icons must live on Serble Files; scripts/make-icons.mjs uploads one per form and colour.
const ICONS: Record<string, string> = JSON.parse(readFileSync(new URL("../shared/icons.json", import.meta.url), "utf8"));
export function iconFor(g: Genome): string | undefined {
  return ICONS[iconKey(g)];
}

const FINAL = new Set(["Approved", "Denied", "Failed", "Expired", "Cancelled"]);

interface ProposalRow {
  id: string; user_id: string; kind: string; payload: string; status: string; consent_url: string;
  applied: number; created_at: number; resolved_at: number | null;
}

const returnUrl = () => `${config.publicUrl}/return`;

function record(id: string, userId: string, kind: string, payload: unknown, consentUrl: string) {
  db.prepare("INSERT INTO proposals (id, user_id, kind, payload, status, consent_url, created_at) VALUES (?, ?, ?, ?, 'Pending', ?, ?)")
    .run(id, userId, kind, JSON.stringify(payload), consentUrl, Date.now());
}

function pendingCount(userId: string) {
  return (db.prepare("SELECT COUNT(*) n FROM proposals WHERE user_id = ? AND status = 'Pending'").get(userId) as { n: number }).n;
}

function guardSpam(userId: string) {
  if (pendingCount(userId) >= 5) throw new GameError("You have several requests waiting on serble.net already. Approve or decline those first.");
}

export function prices() {
  return {
    packet: { coins: config.seedPackPrice, seeds: config.seedPackSize },
    export: { coins: config.exportFee },
  };
}

export async function buyPacket(userId: string) {
  guardSpam(userId);
  const raw = coinsToRaw(config.seedPackPrice);
  const { proposal, consentUrl } = await serble.createProposal({
    user: userId,
    amount: raw.toString(),
    description: `Pollen: a packet of ${config.seedPackSize} premium seeds (better odds of rare traits).`,
    redirectUri: returnUrl(),
  });
  record(proposal.proposalId, userId, "packet", { seeds: config.seedPackSize }, consentUrl);
  logEvent(userId, "packet_proposed");
  return { proposalId: proposal.proposalId, consentUrl };
}

function itemDescription(b: BloomRow) {
  return `A ${b.rarity.toLowerCase()} ${b.species} (generation ${b.generation}) grown in Pollen, a community flower-breeding garden. ` +
    `Import it at ${config.publicUrl} to plant its pollen into new hybrids. Bloom #${b.id}`;
}

export async function exportBloom(userId: string, bloomId: string) {
  guardSpam(userId);
  const b = tx(() => {
    const b = db.prepare("SELECT * FROM blooms WHERE id = ? AND owner_id = ?").get(bloomId, userId) as BloomRow | undefined;
    if (!b) throw new GameError("That flower isn't yours.");
    if (b.state !== "vase") throw new GameError("That flower is already on its way to Serble.");
    db.prepare("UPDATE blooms SET state = 'exporting' WHERE id = ?").run(bloomId);
    return b;
  });
  try {
    let itemId = b.item_id;
    const iconUrl = iconFor(JSON.parse(b.genome)) ?? (config.itemIconBase ? `${config.itemIconBase}${b.id}.png` : undefined);
    // An item minted before icons existed, which never reached a player, is replaced by one with
    // an icon. Once an item has been delivered it is a traded asset, so it keeps its identity.
    if (itemId && iconUrl && !everDelivered(bloomId)) {
      try {
        const existing = await serble.getItem(itemId);
        if (!existing.iconUrl) itemId = null;
      } catch { /* keep the existing item */ }
    }
    if (!itemId) {
      const item = await serble.createItem({
        name: `${b.species}`.slice(0, 128),
        description: itemDescription(b).slice(0, 1024),
        iconUrl,
      });
      itemId = item.id;
      db.prepare("UPDATE blooms SET item_id = ? WHERE id = ?").run(itemId, bloomId);
    }
    const raw = coinsToRaw(config.exportFee);
    const { proposal, consentUrl } = await serble.createProposal({
      user: userId,
      amount: raw.toString(),
      offeredItemIds: [itemId],
      description: `Pollen: send your ${b.rarity} ${b.species} to your Serble inventory so it can be traded.`,
      redirectUri: returnUrl(),
    });
    record(proposal.proposalId, userId, "export", { bloomId, itemId }, consentUrl);
    logEvent(userId, "export_proposed", { rarity: b.rarity });
    return { proposalId: proposal.proposalId, consentUrl };
  } catch (e) {
    db.prepare("UPDATE blooms SET state = 'vase' WHERE id = ? AND state = 'exporting'").run(bloomId);
    throw e;
  }
}

function everDelivered(bloomId: string) {
  return !!db.prepare("SELECT 1 FROM proposals WHERE kind = 'export' AND status = 'Approved' AND json_extract(payload, '$.bloomId') = ?").get(bloomId);
}

/** Items from Pollen in the user's Serble inventory, matched to our blooms. */
export async function serbleInventory(token: string) {
  const items = await serble.userInventory(token, config.clientId);
  const out = [];
  for (const it of items) {
    const b = db.prepare("SELECT * FROM blooms WHERE item_id = ?").get(it.id) as BloomRow | undefined;
    if (!b) continue;
    out.push({ itemId: it.id, name: it.name, bloom: bloomView(b) });
  }
  return out;
}

export async function importItems(userId: string, itemIds: string[]) {
  guardSpam(userId);
  const ids = [...new Set(itemIds)].slice(0, 20);
  if (!ids.length) throw new GameError("Pick at least one flower to bring home.");
  for (const id of ids) {
    const b = db.prepare("SELECT state FROM blooms WHERE item_id = ?").get(id) as { state: string } | undefined;
    if (!b) throw new GameError("One of those items isn't a Pollen flower.");
    if (b.state !== "exported") throw new GameError("One of those flowers is already in a garden.");
  }
  const { proposal, consentUrl } = await serble.createProposal({
    user: userId,
    requestedItemIds: ids,
    description: `Pollen: bring ${ids.length} flower${ids.length > 1 ? "s" : ""} from your Serble inventory into your garden. You can send them back out any time.`,
    redirectUri: returnUrl(),
  });
  record(proposal.proposalId, userId, "import", { itemIds: ids }, consentUrl);
  logEvent(userId, "import_proposed", { n: ids.length });
  return { proposalId: proposal.proposalId, consentUrl };
}

// ------------------------------------------------------------------ settlement

function apply(p: ProposalRow, status: string) {
  tx(() => {
    const cur = db.prepare("SELECT applied FROM proposals WHERE id = ?").get(p.id) as { applied: number };
    if (cur.applied) return;
    const payload = JSON.parse(p.payload);
    if (p.kind === "packet" && status === "Approved") {
      const r = mulberry32(randomInt(0, 2 ** 32 - 1));
      for (let i = 0; i < (payload.seeds ?? config.seedPackSize); i++)
        addSeed(p.user_id, wildGenome(r, config.seedPackLuck) as Genome, "packet", null, 0);
    }
    if (p.kind === "export") {
      if (status === "Approved") db.prepare("UPDATE blooms SET state = 'exported', owner_id = NULL, featured_slot = NULL WHERE id = ?").run(payload.bloomId);
      else db.prepare("UPDATE blooms SET state = 'vase' WHERE id = ? AND state = 'exporting'").run(payload.bloomId);
    }
    if (p.kind === "import" && status === "Approved") {
      for (const itemId of payload.itemIds as string[])
        db.prepare("UPDATE blooms SET state = 'vase', owner_id = ?, pollinated_at = NULL, featured_slot = NULL WHERE item_id = ?").run(p.user_id, itemId);
    }
    db.prepare("UPDATE proposals SET status = ?, applied = 1, resolved_at = ? WHERE id = ?").run(status, Date.now(), p.id);
  });
  logEvent(p.user_id, `${p.kind}_${status.toLowerCase()}`);
}

/** Ask Serble about a proposal and settle it if it's finished. Returns the status. */
export async function settle(id: string): Promise<{ status: string; kind?: string; userId?: string }> {
  const p = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | undefined;
  if (!p) return { status: "Unknown" };
  if (p.applied) return { status: p.status, kind: p.kind, userId: p.user_id };
  let remote;
  try {
    remote = await serble.getProposal(id);
  } catch (e) {
    if (e instanceof SerbleError && e.status === 404) remote = { status: "Expired" } as any;
    else throw e;
  }
  let status = remote.status;
  if (!FINAL.has(status) && Date.now() - p.created_at > 20 * 60_000) {
    // Serble keeps proposals open for 15 minutes; if it still says pending, withdraw it.
    try { await serble.cancelProposal(id); status = "Cancelled"; } catch { /* resolved meanwhile */ }
  }
  if (FINAL.has(status)) apply(p, status);
  return { status, kind: p.kind, userId: p.user_id };
}

export async function cancelProposal(userId: string, id: string) {
  const p = db.prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ?").get(id, userId) as ProposalRow | undefined;
  if (!p) throw new GameError("No such request.");
  if (p.status === "Pending") {
    try { await serble.cancelProposal(id); } catch { /* may have resolved */ }
  }
  return settle(id);
}

export function pendingProposals(userId: string) {
  return (db.prepare("SELECT * FROM proposals WHERE user_id = ? AND status = 'Pending' ORDER BY created_at DESC").all(userId) as unknown as ProposalRow[])
    .map((p) => ({ id: p.id, kind: p.kind, consentUrl: p.consent_url, createdAt: p.created_at }));
}

let polling = false;
export function startPoller() {
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const rows = db.prepare("SELECT id FROM proposals WHERE status = 'Pending' ORDER BY created_at LIMIT 50").all() as { id: string }[];
      for (const r of rows) {
        try { await settle(r.id); } catch (e) { console.warn("settle failed", r.id, (e as Error).message); }
      }
    } finally {
      polling = false;
    }
  }, 30_000).unref();
}

export { rawToCoins };
