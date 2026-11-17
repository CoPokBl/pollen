import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fstatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config, assertConfig } from "./config.ts";
import { db } from "./db.ts";
import { registerAuth, loadSession } from "./auth.ts";
import { registerRoutes } from "./routes.ts";
import { registerMock } from "./mock.ts";
import { startPoller } from "./economy.ts";

assertConfig();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  trustProxy: config.trustProxy,
  bodyLimit: 64 * 1024,
});

await app.register(cookie, { secret: config.sessionSecret });
await app.register(formbody);
app.addHook("onRequest", async (req) => { loadSession(req); });
app.addHook("onSend", async (_req, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
});
// Cookie-authenticated POSTs must come from our own pages.
app.addHook("preHandler", async (req, reply) => {
  if (req.method !== "POST" || req.url.startsWith("/__mock")) return;
  const origin = req.headers.origin;
  if (origin && origin !== config.publicUrl && !(config.mock && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)))
    return reply.code(403).send({ error: "Cross-site request refused." });
});

app.get("/healthz", async () => {
  db.prepare("SELECT 1").get();
  return { ok: true };
});

registerAuth(app);
registerRoutes(app);
if (config.mock) registerMock(app);

const webDir = resolve(process.env.WEB_DIR ?? "dist/web");
if (existsSync(join(webDir, "index.html"))) {
  const indexHtml = readFileSync(join(webDir, "index.html"), "utf8");
  await app.register(fstatic, { root: webDir, wildcard: false, index: false, maxAge: "7d", immutable: true,
    setHeaders: (res, path) => { if (!path.includes("/assets/")) { const r: any = res; r.setHeader ? r.setHeader("Cache-Control", "public, max-age=300") : r.header("Cache-Control", "public, max-age=300"); }; } });
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== "GET" || req.url.startsWith("/api/") || req.url.startsWith("/auth/")) return reply.code(404).send({ error: "Not found" });
    let html = indexHtml;
    const m = /^\/b\/([A-Za-z0-9_-]+)/.exec(req.url);
    if (m) {
      const b = db.prepare("SELECT species, rarity FROM blooms WHERE id = ?").get(m[1]) as { species: string; rarity: string } | undefined;
      if (b) {
        const title = `${b.rarity} ${b.species} · Pollen`;
        html = html.replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>` +
          `<meta property="og:title" content="${esc(title)}"><meta property="og:image" content="${config.publicUrl}/bloom/${m[1]}.svg">`);
      }
    }
    return reply.type("text/html").header("Cache-Control", "no-cache").send(html);
  });
} else {
  app.log.warn(`No built web client at ${webDir}; run "npm run build". API only.`);
}

startPoller();
await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`Pollen at ${config.publicUrl}${config.mock ? " (mock Serble)" : ""}`);
