import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, "pollen.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

const migrations: string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     free_seed_at INTEGER NOT NULL,      -- free seeds accrue from this instant
     free_seeds INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     access_token TEXT,
     refresh_token TEXT,
     token_exp INTEGER,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE seeds (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     genome TEXT NOT NULL,
     origin TEXT NOT NULL,               -- wild | packet | hybrid
     parents TEXT,                       -- JSON [bloomId, bloomId]
     generation INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE plants (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     slot INTEGER NOT NULL,
     genome TEXT NOT NULL,
     origin TEXT NOT NULL,
     parents TEXT,
     generation INTEGER NOT NULL DEFAULT 0,
     planted_at INTEGER NOT NULL,
     grow_ms INTEGER NOT NULL,
     boost_ms INTEGER NOT NULL DEFAULT 0,
     waters INTEGER NOT NULL DEFAULT 0,
     last_water_at INTEGER,
     PRIMARY KEY (user_id, slot)
   );
   CREATE TABLE blooms (
     id TEXT PRIMARY KEY,
     owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     grower_id TEXT,
     genome TEXT NOT NULL,
     species TEXT NOT NULL,
     rarity TEXT NOT NULL,
     score INTEGER NOT NULL,
     origin TEXT NOT NULL,
     parents TEXT,
     generation INTEGER NOT NULL DEFAULT 0,
     state TEXT NOT NULL DEFAULT 'vase',  -- vase | exporting | exported
     item_id TEXT UNIQUE,
     pollinated_at INTEGER,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX blooms_owner ON blooms(owner_id, state);
   CREATE INDEX blooms_score ON blooms(score DESC, created_at DESC);
   CREATE TABLE species (
     name TEXT PRIMARY KEY,
     rarity TEXT NOT NULL,
     first_bloom_id TEXT NOT NULL,
     first_user_id TEXT NOT NULL,
     discovered_at INTEGER NOT NULL,
     count INTEGER NOT NULL DEFAULT 1
   );
   CREATE TABLE proposals (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,                 -- packet | export | import
     payload TEXT NOT NULL,
     status TEXT NOT NULL,               -- Pending | Approved | Denied | Failed | Expired | Cancelled
     consent_url TEXT NOT NULL,
     applied INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     resolved_at INTEGER
   );
   CREATE INDEX proposals_pending ON proposals(status, created_at);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT,
     kind TEXT NOT NULL,
     data TEXT,
     at INTEGER NOT NULL
   );
   CREATE INDEX events_kind ON events(kind, at);
   CREATE TABLE oauth_states (
     state TEXT PRIMARY KEY,
     verifier TEXT NOT NULL,
     return_to TEXT,
     created_at INTEGER NOT NULL
   );`,
];

db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
const row = db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
let version = row?.v ?? 0;
if (!row) db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
while (version < migrations.length) {
  db.exec("BEGIN");
  try {
    db.exec(migrations[version]);
    version++;
    db.prepare("UPDATE schema_version SET v = ?").run(version);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function logEvent(userId: string | null, kind: string, data?: unknown) {
  db.prepare("INSERT INTO events (user_id, kind, data, at) VALUES (?, ?, ?, ?)")
    .run(userId, kind, data === undefined ? null : JSON.stringify(data), Date.now());
}
