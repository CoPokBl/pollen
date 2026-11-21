// Reactions (#13) and flower of the day (#14).
import { db, tx, logEvent } from "./db.ts";
import { GameError, type BloomRow } from "./game.ts";

export const REACTIONS = ["love", "sparkle", "wow", "bloom"] as const;
type Kind = (typeof REACTIONS)[number];
const DAY = 86400_000;

export function reactionSummary(bloomId: string, userId: string | null) {
  const counts = Object.fromEntries(REACTIONS.map((k) => [k, 0])) as Record<Kind, number>;
  for (const r of db.prepare("SELECT kind, COUNT(*) n FROM reactions WHERE bloom_id = ? GROUP BY kind").all(bloomId) as { kind: Kind; n: number }[])
    if (r.kind in counts) counts[r.kind] = r.n;
  const mine = userId ? (db.prepare("SELECT kind FROM reactions WHERE bloom_id = ? AND user_id = ?").get(bloomId, userId) as { kind: Kind } | undefined)?.kind ?? null : null;
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), mine };
}

/** Set, change or (same kind again) remove your reaction to someone else's flower. */
export function react(userId: string, bloomId: string, kind: string) {
  if (!REACTIONS.includes(kind as Kind)) throw new GameError("Unknown reaction.");
  tx(() => {
    const b = db.prepare("SELECT owner_id, grower_id FROM blooms WHERE id = ?").get(bloomId) as { owner_id: string | null; grower_id: string | null } | undefined;
    if (!b) throw new GameError("No such flower.", 404);
    if (b.owner_id === userId || b.grower_id === userId) throw new GameError("You can't react to your own flower.");
    const cur = db.prepare("SELECT kind FROM reactions WHERE bloom_id = ? AND user_id = ?").get(bloomId, userId) as { kind: string } | undefined;
    if (cur?.kind === kind) db.prepare("DELETE FROM reactions WHERE bloom_id = ? AND user_id = ?").run(bloomId, userId);
    else db.prepare(`INSERT INTO reactions (bloom_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT (bloom_id, user_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at`).run(bloomId, userId, kind, Date.now());
  });
  logEvent(userId, "react");
  return reactionSummary(bloomId, userId);
}

const dayOf = (t: number) => Math.floor(t / DAY);

/** Today's flower, chosen on first request each UTC day and then fixed. */
export function flowerOfTheDay(now = Date.now()) {
  const day = dayOf(now);
  let row = db.prepare("SELECT * FROM daily_flowers WHERE day = ?").get(day) as any;
  if (!row) {
    row = tx(() => {
      const existing = db.prepare("SELECT * FROM daily_flowers WHERE day = ?").get(day);
      if (existing) return existing;
      const since = now - 7 * DAY;
      // Most-reacted flower of the past week that hasn't been picked before...
      let pick = db.prepare(`SELECT b.*, COUNT(r.user_id) AS n FROM blooms b JOIN reactions r ON r.bloom_id = b.id
                             WHERE r.created_at >= ? AND b.id NOT IN (SELECT bloom_id FROM daily_flowers)
                             GROUP BY b.id ORDER BY n DESC, b.score DESC, b.created_at ASC LIMIT 1`).get(since) as (BloomRow & { n: number }) | undefined;
      let reason = "reactions";
      // ...or, with no reactions, the rarest flower grown in the last day (then the last week).
      if (!pick) {
        reason = "rarest";
        for (const window of [DAY, 7 * DAY]) {
          pick = db.prepare(`SELECT b.*, 0 AS n FROM blooms b WHERE b.created_at >= ? AND b.id NOT IN (SELECT bloom_id FROM daily_flowers)
                             ORDER BY b.score DESC, b.generation DESC, b.created_at ASC LIMIT 1`).get(now - window) as (BloomRow & { n: number }) | undefined;
          if (pick) break;
        }
      }
      if (!pick) return null;
      const grower = (db.prepare("SELECT username FROM users WHERE id = ?").get(pick.grower_id) as { username: string } | undefined)?.username ?? null;
      db.prepare("INSERT INTO daily_flowers (day, bloom_id, genome, species, rarity, grower, reactions, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(day, pick.id, pick.genome, pick.species, pick.rarity, grower, pick.n, reason);
      return db.prepare("SELECT * FROM daily_flowers WHERE day = ?").get(day);
    });
  }
  if (!row) return null;
  const alive = !!db.prepare("SELECT 1 FROM blooms WHERE id = ?").get(row.bloom_id);
  return {
    day: row.day, bloomId: row.bloom_id, genome: JSON.parse(row.genome), species: row.species, rarity: row.rarity,
    grower: row.grower, reactions: row.reactions, reason: row.reason, alive,
  };
}
