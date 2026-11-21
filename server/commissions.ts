// Weekly commissions (#2): breed this week's target and the first three gardeners get coins from
// the app's own balance. Paying is a Serble balance transfer (a gift, so no consent step). Every
// claim is recorded before money moves, and its id goes into the transfer description, so a retry
// can always see whether an earlier attempt actually paid.
import { db, tx, logEvent } from "./db.ts";
import { coinsToRaw, rawToCoins } from "./config.ts";
import { serble } from "./serble.ts";
import { GameError, newId, type BloomRow } from "./game.ts";
import { commissionFor, weekOf, matches, REWARDS } from "../shared/commission.ts";

interface ClaimRow {
  id: string; week: number; user_id: string; bloom_id: string; genome: string; place: number;
  reward_raw: string; status: string; tx_id: string | null; created_at: number; paid_at: number | null;
}

const describeTx = (c: ClaimRow) => `Pollen weekly commission, place ${c.place} (claim ${c.id})`;

export function commissionView(userId: string | null, now = Date.now()) {
  const week = weekOf(now);
  const c = commissionFor(week);
  const claims = db.prepare(`SELECT c.place, c.status, c.bloom_id, c.genome, c.reward_raw, u.username FROM commission_claims c
                             JOIN users u ON u.id = c.user_id WHERE c.week = ? ORDER BY c.place`).all(week) as any[];
  let eligible: string[] = [];
  let mine = null;
  if (userId) {
    mine = db.prepare("SELECT place, status FROM commission_claims WHERE week = ? AND user_id = ?").get(week, userId) as { place: number; status: string } | undefined ?? null;
    const rows = db.prepare("SELECT * FROM blooms WHERE owner_id = ? AND grower_id = ? AND state = 'vase' AND created_at >= ?")
      .all(userId, userId, c.start) as unknown as BloomRow[];
    eligible = rows.filter((b) => matches(c, JSON.parse(b.genome), b.generation)).map((b) => b.id);
  }
  return {
    ...c,
    rewards: REWARDS.map(String),
    claims: claims.map((x) => ({ place: x.place, username: x.username, bloomId: x.bloom_id, genome: JSON.parse(x.genome), reward: rawToCoins(BigInt(x.reward_raw)), status: x.status })),
    mine: mine ? { place: mine.place, status: mine.status } : null,
    eligible,
  };
}

/** Claim this week's commission with a flower you grew this week. */
export async function claimCommission(userId: string, bloomId: string) {
  const now = Date.now();
  const week = weekOf(now);
  const c = commissionFor(week);
  const claim = tx(() => {
    if (db.prepare("SELECT 1 FROM commission_claims WHERE week = ? AND user_id = ?").get(week, userId))
      throw new GameError("You've already claimed this week's commission.");
    const b = db.prepare("SELECT * FROM blooms WHERE id = ? AND owner_id = ? AND state = 'vase'").get(bloomId, userId) as BloomRow | undefined;
    if (!b) throw new GameError("That flower isn't in your vase.");
    if (b.grower_id !== userId || b.created_at < c.start) throw new GameError("It has to be a flower you grew yourself this week.");
    if (!matches(c, JSON.parse(b.genome), b.generation)) throw new GameError("That flower doesn't match this week's commission.");
    const placed = (db.prepare("SELECT COUNT(*) n FROM commission_claims WHERE week = ?").get(week) as { n: number }).n;
    const place = placed + 1;
    const reward = place <= REWARDS.length ? coinsToRaw(String(REWARDS[place - 1])) : 0n;
    const row: ClaimRow = {
      id: newId(), week, user_id: userId, bloom_id: b.id, genome: b.genome, place, reward_raw: reward.toString(),
      status: reward > 0n ? "owed" : "unrewarded", tx_id: null, created_at: now, paid_at: null,
    };
    db.prepare(`INSERT INTO commission_claims (id, week, user_id, bloom_id, genome, place, reward_raw, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, week, userId, b.id, b.genome, place, row.reward_raw, row.status, now);
    return row;
  });
  logEvent(userId, "commission_claim", { place: claim.place });
  if (claim.status === "owed") await payClaim(claim.id);
  const after = db.prepare("SELECT status FROM commission_claims WHERE id = ?").get(claim.id) as { status: string };
  return { place: claim.place, reward: rawToCoins(BigInt(claim.reward_raw)), status: after.status };
}

let paying = false;
/** Pay one owed claim, exactly once. Safe to call repeatedly and concurrently with the poller. */
export async function payClaim(id: string) {
  // Take the claim: only one caller can move it from owed to paying.
  const took = db.prepare("UPDATE commission_claims SET status = 'paying' WHERE id = ? AND status = 'owed'").run(id);
  if (!took.changes) return;
  const c = db.prepare("SELECT * FROM commission_claims WHERE id = ?").get(id) as unknown as ClaimRow;
  try {
    const balance = await serble.appBalance();
    if (BigInt(Math.floor(balance.coins)) < BigInt(c.reward_raw)) {
      db.prepare("UPDATE commission_claims SET status = 'owed' WHERE id = ?").run(id);   // try again when the app can afford it
      return;
    }
    const r = await serble.transfer(c.user_id, c.reward_raw, describeTx(c));
    db.prepare("UPDATE commission_claims SET status = 'paid', tx_id = ?, paid_at = ? WHERE id = ?").run(r.transaction?.id ?? null, Date.now(), id);
    logEvent(c.user_id, "commission_paid", { place: c.place });
  } catch (e) {
    // We don't know whether the transfer happened. Leave it as 'paying' for reconcile() to settle.
    console.warn("commission payment uncertain", id, (e as Error).message);
  }
}

/** Settle claims stuck in 'paying' by checking Serble's ledger, then retry owed ones. */
export async function reconcileCommissions() {
  if (paying) return;
  paying = true;
  try {
    const stuck = db.prepare("SELECT * FROM commission_claims WHERE status = 'paying' AND created_at < ?").all(Date.now() - 60_000) as unknown as ClaimRow[];
    if (stuck.length) {
      const txs = await serble.appTransactions(200);
      for (const c of stuck) {
        const hit = txs.find((t) => (t.description ?? "").includes(`(claim ${c.id})`));
        if (hit) db.prepare("UPDATE commission_claims SET status = 'paid', tx_id = ?, paid_at = ? WHERE id = ?").run(hit.id, Date.now(), c.id);
        else db.prepare("UPDATE commission_claims SET status = 'owed' WHERE id = ? AND status = 'paying'").run(c.id);
      }
    }
    const owed = db.prepare("SELECT id FROM commission_claims WHERE status = 'owed' ORDER BY created_at LIMIT 20").all() as { id: string }[];
    for (const o of owed) await payClaim(o.id);
  } catch (e) {
    console.warn("commission reconcile failed", (e as Error).message);
  } finally {
    paying = false;
  }
}
