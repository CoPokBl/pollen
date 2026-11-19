import type { FastifyInstance } from "fastify";
import { db } from "./db.ts";
import { config, rawToCoins } from "./config.ts";
import { requireUser, userToken } from "./auth.ts";
import * as game from "./game.ts";
import * as eco from "./economy.ts";
import { serble, SerbleError } from "./serble.ts";
import { renderFlower, validGenome } from "../shared/genome.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : Number(v));

export function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof game.GameError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof SerbleError) {
      req.log.warn({ path: err.path, status: err.status, body: err.body.slice(0, 500) }, "serble error");
      const msg = err.status === 401 || err.status === 403
        ? "Serble didn't accept the request. Try signing out and back in."
        : err.status === 429 ? "Serble is rate limiting us — try again in a moment."
        : "Serble couldn't do that right now.";
      return reply.code(502).send({ error: msg });
    }
    if ((err as any).validation || (err as any).statusCode === 400) return reply.code(400).send({ error: "Bad request." });
    req.log.error(err);
    return reply.code(500).send({ error: "Something went wrong." });
  });

  // ---------------------------------------------------------------- public
  app.get("/api/config", async () => ({
    plots: config.plots,
    prices: eco.prices(),
    marketUrl: config.marketUrl,
    serbleWebsite: config.serbleWebsite,
    appId: config.clientId,
    mock: config.mock,
  }));

  app.get("/api/me", async (req) => {
    if (!req.session) return { user: null };
    db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(Date.now(), req.session.user_id);
    return { user: { id: req.session.user_id, username: req.session.username, admin: config.adminUsers.includes(req.session.username) } };
  });

  app.get("/api/public/blooms", async (req) => {
    const q = req.query as { sort?: string };
    const order = q.sort === "top" ? "score DESC, created_at DESC" : "created_at DESC";
    const rows = db.prepare(`SELECT b.*, u.username AS grower FROM blooms b LEFT JOIN users u ON u.id = b.grower_id
                             ORDER BY ${order} LIMIT 48`).all() as any[];
    return rows.map((b) => ({ ...game.bloomView(b), grower: b.grower }));
  });

  app.get("/api/public/bloom/:id", async (req, reply) => {
    const id = str((req.params as any).id);
    const b = db.prepare(`SELECT b.*, g.username AS grower, o.username AS owner FROM blooms b
                          LEFT JOIN users g ON g.id = b.grower_id LEFT JOIN users o ON o.id = b.owner_id
                          WHERE b.id = ?`).get(id) as any;
    if (!b) return reply.code(404).send({ error: "No such flower." });
    const parents = b.parents ? (JSON.parse(b.parents) as string[]).map((pid) => {
      const p = db.prepare("SELECT * FROM blooms WHERE id = ?").get(pid) as any;
      return p ? game.bloomView(p) : { id: pid, missing: true };
    }) : null;
    const children = (db.prepare("SELECT * FROM blooms WHERE parents LIKE ? ORDER BY created_at DESC LIMIT 12").all(`%"${id}"%`) as any[]).map((c) => game.bloomView(c));
    return { ...game.bloomView(b), grower: b.grower, owner: b.state === "exported" ? null : b.owner, parentBlooms: parents, children };
  });

  app.get("/api/public/stats", async () => {
    const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      gardeners: one("SELECT COUNT(*) n FROM users"),
      blooms: one("SELECT COUNT(*) n FROM blooms"),
      species: one("SELECT COUNT(*) n FROM species"),
      onSerble: one("SELECT COUNT(*) n FROM blooms WHERE state = 'exported'"),
    };
  });

  app.get("/api/public/almanac", async () => {
    return db.prepare(`SELECT s.name, s.rarity, s.count, s.discovered_at AS discoveredAt, u.username AS discoverer, s.first_bloom_id AS bloomId,
                              b.genome FROM species s LEFT JOIN users u ON u.id = s.first_user_id LEFT JOIN blooms b ON b.id = s.first_bloom_id
                       ORDER BY s.discovered_at DESC LIMIT 500`).all().map((r: any) => ({ ...r, genome: r.genome ? JSON.parse(r.genome) : null }));
  });

  app.get("/api/public/leaders", async () => {
    return db.prepare(`SELECT u.username, COUNT(*) AS species FROM species s JOIN users u ON u.id = s.first_user_id
                       GROUP BY s.first_user_id ORDER BY species DESC LIMIT 20`).all();
  });

  /** Image of a bloom: used for sharing, and as an item icon source. */
  app.get("/bloom/:file", async (req, reply) => {
    const file = str((req.params as any).file);
    const m = /^([A-Za-z0-9_-]+)\.svg$/.exec(file);
    if (!m) return reply.callNotFound();
    const b = db.prepare("SELECT genome FROM blooms WHERE id = ?").get(m[1]) as { genome: string } | undefined;
    if (!b) return reply.code(404).send("Not found");
    const g = JSON.parse(b.genome);
    if (!validGenome(g)) return reply.code(500).send("bad genome");
    return reply.type("image/svg+xml").header("Cache-Control", "public, max-age=86400")
      .send(renderFlower(g, { uid: m[1], background: "#f4ecdc", animate: true }));
  });

  // ---------------------------------------------------------------- player
  app.register(async (p) => {
    p.addHook("preHandler", requireUser);
    const uid = (req: any) => req.session.user_id as string;

    p.get("/api/garden", async (req) => ({ ...game.gardenView(uid(req)), pending: eco.pendingProposals(uid(req)) }));
    p.get("/api/vase", async (req) => game.vaseView(uid(req)));
    p.post("/api/seeds/claim", async (req) => ({ claimed: game.claimFreeSeeds(uid(req)) }));
    p.post("/api/plant", async (req) => {
      const b = req.body as any;
      game.plant(uid(req), str(b?.seedId), num(b?.slot));
      return { ok: true };
    });
    p.post("/api/water", async (req) => { game.water(uid(req), num((req.body as any)?.slot)); return { ok: true }; });
    p.post("/api/compost", async (req) => { game.compost(uid(req), num((req.body as any)?.slot)); return { ok: true }; });
    p.post("/api/harvest", async (req) => game.harvest(uid(req), num((req.body as any)?.slot)));
    p.post("/api/pollinate", async (req) => {
      const b = req.body as any;
      return { seedId: game.pollinate(uid(req), str(b?.a), str(b?.b)) };
    });
    p.post("/api/release", async (req) => game.release(uid(req), str((req.body as any)?.bloomId)));
    p.post("/api/compost-blooms", async (req) => {
      const ids = (req.body as any)?.bloomIds;
      return game.compostBlooms(uid(req), Array.isArray(ids) ? ids.map(str) : []);
    });
    p.post("/api/fertilise", async (req) => game.fertilise(uid(req), num((req.body as any)?.slot)));

    p.get("/api/balance", async (req) => {
      const token = await userToken(req);
      if (!token) return { coins: null };
      try {
        const b = await serble.userBalance(token);
        return { coins: rawToCoins(BigInt(Math.round(b.coins))) };
      } catch { return { coins: null }; }
    });

    p.post("/api/shop/packet", async (req) => eco.buyPacket(uid(req)));
    p.post("/api/export", async (req) => eco.exportBloom(uid(req), str((req.body as any)?.bloomId)));
    p.get("/api/serble/inventory", async (req, reply) => {
      const token = await userToken(req);
      if (!token) return reply.code(401).send({ error: "Your Serble sign-in expired. Sign out and back in to see your inventory." });
      return eco.serbleInventory(token);
    });
    p.post("/api/import", async (req) => {
      const ids = (req.body as any)?.itemIds;
      return eco.importItems(uid(req), Array.isArray(ids) ? ids.map(str) : []);
    });
    p.post("/api/proposals/:id/settle", async (req) => {
      const id = str((req.params as any).id);
      const r = db.prepare("SELECT user_id FROM proposals WHERE id = ?").get(id) as { user_id: string } | undefined;
      if (!r || r.user_id !== uid(req)) throw new game.GameError("No such request.", 404);
      return eco.settle(id);
    });
    p.post("/api/proposals/:id/cancel", async (req) => eco.cancelProposal(uid(req), str((req.params as any).id)));

  });

  // Usage overview for maintainers: signed in as an admin, or with an admin's Serble login token
  // in X-Serble-Token (so automated maintenance can read it without a browser).
  const adminCache = new Map<string, { name: string; at: number }>();
  app.get("/api/admin/overview", async (req, reply) => {
    let name = (req as any).session?.username as string | undefined;
    const tok = req.headers["x-serble-token"];
    if (!name && typeof tok === "string" && tok.length < 2000) {
      const hit = adminCache.get(tok);
      if (hit && Date.now() - hit.at < 300_000) name = hit.name;
      else {
        try { name = (await serble.accountForLogin(tok)).username; adminCache.set(tok, { name, at: Date.now() }); } catch { /* invalid */ }
      }
    }
    if (!name || !config.adminUsers.includes(name)) return reply.code(403).send({ error: "Admins only." });
    const day = Date.now() - 86400_000, week = Date.now() - 7 * 86400_000;
    const one = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as { n: number }).n;
    let appBalance = null;
    try { appBalance = rawToCoins(BigInt(Math.round((await serble.appBalance()).coins))); } catch { /* ignore */ }
    return {
      users: one("SELECT COUNT(*) n FROM users"),
      active24h: one("SELECT COUNT(*) n FROM users WHERE last_seen > ?", day),
      active7d: one("SELECT COUNT(*) n FROM users WHERE last_seen > ?", week),
      newUsers7d: one("SELECT COUNT(*) n FROM users WHERE created_at > ?", week),
      blooms: one("SELECT COUNT(*) n FROM blooms"),
      exported: one("SELECT COUNT(*) n FROM blooms WHERE state = 'exported'"),
      species: one("SELECT COUNT(*) n FROM species"),
      events24h: db.prepare("SELECT kind, COUNT(*) n FROM events WHERE at > ? GROUP BY kind ORDER BY n DESC").all(day),
      events7d: db.prepare("SELECT kind, COUNT(*) n FROM events WHERE at > ? GROUP BY kind ORDER BY n DESC").all(week),
      pendingProposals: one("SELECT COUNT(*) n FROM proposals WHERE status = 'Pending'"),
      appBalance,
    };
  });

  // Where serble.net sends the user after a transaction decision.
  app.get("/return", async (req, reply) => {
    const q = req.query as { proposal?: string; status?: string };
    const id = str(q.proposal);
    let status = str(q.status) || "Unknown";
    let kind = "";
    if (id) {
      try {
        const r = await eco.settle(id);
        status = r.status; kind = r.kind ?? "";
      } catch (e) { req.log.warn(e, "settle on return failed"); }
    }
    const dest = kind === "import" ? "/vase" : kind === "export" ? "/vase" : "/garden";
    return reply.redirect(`${dest}?trade=${encodeURIComponent(kind)}&status=${encodeURIComponent(status)}`);
  });
}
