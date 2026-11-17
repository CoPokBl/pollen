import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { db, logEvent } from "./db.ts";
import { config } from "./config.ts";
import { serble } from "./serble.ts";
import { upsertUser } from "./game.ts";

const COOKIE = "pollen_sid";
const SESSION_DAYS = 30;
// Serble's legacy access tokens don't report a usable lifetime; refresh them hourly.
const TOKEN_TTL = 3600_000;
const redirectUri = () => `${config.publicUrl}/auth/callback`;

interface SessionRow {
  id: string; user_id: string; access_token: string | null; refresh_token: string | null;
  token_exp: number | null; expires_at: number;
}

declare module "fastify" {
  interface FastifyRequest { session?: SessionRow & { username: string } }
}

export function loadSession(req: FastifyRequest) {
  const raw = req.cookies[COOKIE];
  if (!raw) return;
  const un = req.unsignCookie(raw);
  if (!un.valid || !un.value) return;
  const s = db.prepare(`SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id
                        WHERE s.id = ? AND s.expires_at > ?`).get(un.value, Date.now()) as any;
  if (s) req.session = s;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.session) return reply.code(401).send({ error: "Sign in with Serble first." });
}

/** A usable Serble access token for the session's user, refreshing it if needed. */
export async function userToken(req: FastifyRequest): Promise<string | null> {
  const s = req.session;
  if (!s?.access_token) return null;
  if (!s.token_exp || s.token_exp - 60_000 > Date.now()) return s.access_token;
  if (!s.refresh_token) return null;
  try {
    const t = await serble.refresh(s.refresh_token);
    const exp = Date.now() + TOKEN_TTL;
    db.prepare("UPDATE sessions SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_exp = ? WHERE id = ?")
      .run(t.access_token, t.refresh_token ?? null, exp, s.id);
    return t.access_token;
  } catch {
    return null;
  }
}

export function registerAuth(app: FastifyInstance) {
  app.get("/auth/login", async (req, reply) => {
    const state = randomBytes(16).toString("base64url");
    const q = req.query as { next?: string };
    const next = typeof q.next === "string" && q.next.startsWith("/") && !q.next.startsWith("//") ? q.next : "/garden";
    db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(Date.now() - 15 * 60_000);
    db.prepare("INSERT INTO oauth_states (state, verifier, return_to, created_at) VALUES (?, ?, ?, ?)").run(state, "-", next, Date.now());
    const url = new URL(config.serbleWebsite + "/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: redirectUri(), response_type: "code", scope: config.scopes, state,
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get("/auth/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; authorized?: string };
    if (q.error || q.authorized === "false") return reply.redirect("/?signin=cancelled");
    const st = q.state && db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(q.state) as { verifier: string; return_to: string } | undefined;
    if (!st || !q.code) return reply.redirect("/?signin=failed");
    db.prepare("DELETE FROM oauth_states WHERE state = ?").run(q.state!);
    try {
      const tok = await serble.exchangeCode(q.code);
      const info = await serble.account(tok.access_token);
      const sub = info.id;
      upsertUser(sub, info.username || "gardener");
      const sid = randomBytes(24).toString("base64url");
      const now = Date.now();
      db.prepare(`INSERT INTO sessions (id, user_id, access_token, refresh_token, token_exp, created_at, expires_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(sid, sub, tok.access_token, tok.refresh_token ?? null, now + TOKEN_TTL, now, now + SESSION_DAYS * 86400_000);
      logEvent(sub, "login");
      reply.setCookie(COOKIE, sid, {
        signed: true, httpOnly: true, sameSite: "lax", path: "/",
        secure: config.publicUrl.startsWith("https://"), maxAge: SESSION_DAYS * 86400,
      });
      return reply.redirect(st.return_to || "/garden");
    } catch (e) {
      req.log.error(e, "sign-in failed");
      return reply.redirect("/?signin=failed");
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    if (req.session) db.prepare("DELETE FROM sessions WHERE id = ?").run(req.session.id);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });
}
