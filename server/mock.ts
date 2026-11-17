// An in-memory stand-in for the slice of the Serble API Pollen uses, so the game can be played
// and tested locally with MOCK_SERBLE=1. Mounted under /__mock.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { config, ONE_COIN } from "./config.ts";

const id = () => randomBytes(8).toString("hex");
const balances = new Map<string, bigint>();          // "User:<id>" | "App:<id>"
const items = new Map<string, { id: string; ownerType: string; ownerId: string; creatorAppId: string; name: string; description?: string; dateCreated: string }>();
const proposals = new Map<string, any>();
const codes = new Map<string, string>();
const APP = config.clientId;

const bal = (k: string) => balances.get(k) ?? (k.startsWith("User:") ? 100n * ONE_COIN : 0n);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function principal(req: FastifyRequest): { type: "App" | "User"; id: string } | null {
  const h = String(req.headers.serbleauth ?? "");
  const t = h.replace(/^(ApiKey|App|User) /, "");
  if (t === config.apiKey) return { type: "App", id: APP };
  if (t.startsWith("mock:")) return { type: "User", id: "u-" + t.slice(5) };
  return null;
}

const page = (body: string) => `<!doctype html><meta name="viewport" content="width=device-width"><title>Mock Serble</title>
<body style="font:16px system-ui;max-width:440px;margin:48px auto;padding:0 16px;background:#eef">
<p style="color:#668;font-size:13px">MOCK SERBLE — local testing only</p>${body}</body>`;

export function registerMock(app: FastifyInstance) {
  app.get("/__mock/oauth/authorize", async (req, reply) => {
    const q = req.query as Record<string, string>;
    reply.type("text/html").send(page(`<h2>Sign in to Pollen</h2>
      <form action="/__mock/login" method="post">
      ${["redirect_uri", "state"].map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] ?? "")}">`).join("")}
      <label>Username <input name="username" value="alice" autofocus></label> <button>Continue</button></form>`));
  });
  app.post("/__mock/login", async (req, reply) => {
    const b = req.body as Record<string, string>;
    const code = id();
    codes.set(code, (b.username || "alice").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "alice");
    const u = new URL(b.redirect_uri);
    u.searchParams.set("code", code);
    u.searchParams.set("state", b.state);
    u.searchParams.set("authorized", "true");
    reply.redirect(u.toString());
  });
  app.post("/__mock/api/v1/oauth/token/refresh2", async (req, reply) => {
    const b = req.body as Record<string, string>;
    const name = codes.get(b.code);
    if (!name || b.client_secret !== config.clientSecret) return reply.code(400).send("Invalid authorization code");
    codes.delete(b.code);
    return { access_token: "mock:" + name, refresh_token: "refresh:" + name, expires_in: 87600, token_type: "bearer" };
  });
  app.post("/__mock/api/v1/oauth/token/access2", async (req) => {
    const b = req.body as Record<string, string>;
    return { access_token: b.refresh_token.replace("refresh:", "mock:"), refresh_token: b.refresh_token, expires_in: 1, token_type: "bearer" };
  });
  app.get("/__mock/api/v1/account", async (req, reply) => {
    const p = principal(req);
    if (p?.type !== "User") return reply.code(401).send();
    return { id: p.id, username: p.id.slice(2) };
  });

  app.get("/__mock/api/v1/items/fee", async () => ({ coins: "0", raw: 0 }));
  app.post("/__mock/api/v1/items", async (req, reply) => {
    if (principal(req)?.type !== "App") return reply.code(403).send();
    const b = req.body as any;
    const it = { id: id(), ownerType: "App", ownerId: APP, creatorAppId: APP, name: b.name, description: b.description, dateCreated: new Date().toISOString() };
    items.set(it.id, it);
    return it;
  });
  app.get("/__mock/api/v1/balance", async (req, reply) => {
    const p = principal(req);
    if (!p) return reply.code(401).send();
    // Raw numbers can exceed 2^53 in theory; fine for a mock.
    return reply.type("application/json").send(`{"ownerType":"${p.type}","ownerId":"${p.id}","coins":${bal(`${p.type}:${p.id}`)}}`);
  });
  app.get("/__mock/api/v1/inventory", async (req, reply) => {
    const p = principal(req);
    if (p?.type !== "User") return reply.code(401).send();
    const q = req.query as Record<string, string>;
    return [...items.values()].filter((i) => i.ownerType === "User" && i.ownerId === p.id && (!q.creatorApp || i.creatorAppId === q.creatorApp));
  });
  app.post("/__mock/api/v1/transactions/proposals", async (req, reply) => {
    if (principal(req)?.type !== "App") return reply.code(403).send();
    const b = req.body as any;
    for (const iid of b.offeredItemIds ?? []) {
      const it = items.get(iid);
      if (!it || it.ownerType !== "App") return reply.code(400).send("App does not own offered item.");
    }
    const p = {
      proposalId: id(), status: "Pending", appId: APP, userId: b.user, amount: b.amount ?? 0,
      offeredItemIds: b.offeredItemIds ?? [], requestedItemIds: b.requestedItemIds ?? [],
      description: b.description, redirectUri: b.redirectUri, createdAt: Date.now(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    proposals.set(p.proposalId, p);
    return { proposal: p, consentUrl: `${config.publicUrl}/__mock/consent?proposal=${p.proposalId}` };
  });
  app.get("/__mock/api/v1/transactions/proposals/:id", async (req, reply) => {
    const p = proposals.get((req.params as any).id);
    if (!p) return reply.code(404).send("Proposal not found.");
    if (p.status === "Pending" && Date.now() - p.createdAt > 15 * 60_000) p.status = "Expired";
    return p;
  });
  app.post("/__mock/api/v1/transactions/proposals/:id/cancel", async (req, reply) => {
    const p = proposals.get((req.params as any).id);
    if (!p || p.status !== "Pending") return reply.code(400).send("not pending");
    p.status = "Cancelled";
    return p;
  });

  app.get("/__mock/consent", async (req, reply) => {
    const p = proposals.get((req.query as any).proposal);
    if (!p) return reply.code(404).send("no proposal");
    const coins = Number(BigInt(p.amount) * 100n / ONE_COIN) / 100;
    reply.type("text/html").send(page(`<h2>Approve transaction?</h2><p>${esc(p.description ?? "")}</p>
      <p>Pay: <b>${coins} coins</b> · Give ${p.requestedItemIds.length} item(s) · Receive ${p.offeredItemIds.length} item(s)</p>
      <p>Your balance: ${Number(bal(`User:${p.userId}`) * 100n / ONE_COIN) / 100} coins</p>
      <form method="post" action="/__mock/consent/${p.proposalId}/approve" style="display:inline"><button>Approve</button></form>
      <form method="post" action="/__mock/consent/${p.proposalId}/deny" style="display:inline"><button>Deny</button></form>`));
  });
  app.post("/__mock/consent/:id/:decision", async (req, reply) => {
    const { id: pid, decision } = req.params as any;
    const p = proposals.get(pid);
    if (!p || p.status !== "Pending") return reply.code(400).send("not pending");
    if (decision === "approve") {
      const payer = `User:${p.userId}`;
      const amt = BigInt(p.amount);
      const ok = bal(payer) >= amt && p.requestedItemIds.every((i: string) => items.get(i)?.ownerId === p.userId);
      if (!ok) p.status = "Failed";
      else {
        balances.set(payer, bal(payer) - amt);
        balances.set(`App:${APP}`, bal(`App:${APP}`) + amt);
        for (const i of p.offeredItemIds) Object.assign(items.get(i)!, { ownerType: "User", ownerId: p.userId });
        for (const i of p.requestedItemIds) Object.assign(items.get(i)!, { ownerType: "App", ownerId: APP });
        p.status = "Approved";
        p.transactionId = id();
      }
    } else p.status = "Denied";
    if (!p.redirectUri) return reply.type("text/html").send(page(`Done: ${p.status}`));
    const u = new URL(p.redirectUri);
    u.searchParams.set("proposal", p.proposalId);
    u.searchParams.set("status", p.status);
    reply.redirect(u.toString());
  });

  /** Test helper: move an item between users, as the market would. */
  app.post("/__mock/give", async (req) => {
    const b = req.body as any;
    const it = items.get(b.itemId);
    if (it) Object.assign(it, { ownerType: "User", ownerId: "u-" + b.to });
    return { ok: !!it };
  });
}
