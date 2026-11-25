import { randomBytes, randomInt } from "node:crypto";
import { db, tx, logEvent } from "./db.ts";
import { config } from "./config.ts";
import {
  Genome, breed, wildGenome, rarityOf, rarityScore, speciesName, mulberry32,
} from "../shared/genome.ts";

export class GameError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const newId = (n = 9) => randomBytes(n).toString("base64url");
const rng = () => mulberry32(randomInt(0, 2 ** 32 - 1));

const HOUR = 3600_000;
export const POLLINATE_COOLDOWN = 20 * HOUR;
const WATER_COOLDOWN = 45 * 60_000;
const MAX_WATERS = 3;

export function growTimeMs(origin: string, generation: number): number {
  const hours = origin === "hybrid" ? 3 + Math.min(generation, 6) * 0.5 : origin === "packet" ? 2 : 1.5;
  return Math.round(hours * HOUR * config.growScale);
}

// ------------------------------------------------------------------ users

export interface UserRow {
  id: string; username: string; created_at: number; last_seen: number; free_seed_at: number; free_seeds: number;
  fertiliser?: number;
}

export function upsertUser(id: string, username: string): UserRow {
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (existing) {
    db.prepare("UPDATE users SET username = ?, last_seen = ? WHERE id = ?").run(username, now, id);
    return { ...existing, username, last_seen: now };
  }
  tx(() => {
    db.prepare("INSERT INTO users (id, username, created_at, last_seen, free_seed_at, free_seeds) VALUES (?, ?, ?, ?, ?, 0)")
      .run(id, username, now, now, now);
    // A starter handful of seeds.
    for (let i = 0; i < 4; i++) addSeed(id, wildGenome(rng(), i === 0 ? 2 : 1), "wild", null, 0);
  });
  logEvent(id, "signup");
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow;
}

/** Free seeds accrue one per FREE_SEED_HOURS up to a cap. Returns {available, nextAt}. */
export function freeSeedState(u: UserRow, now = Date.now()) {
  const period = config.freeSeedHours * HOUR;
  const accrued = Math.floor((now - u.free_seed_at) / period);
  const available = Math.min(config.freeSeedCap, u.free_seeds + accrued);
  const nextAt = available >= config.freeSeedCap ? null : u.free_seed_at + (accrued + 1) * period;
  return { available, nextAt };
}

export function claimFreeSeeds(userId: string) {
  return tx(() => {
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as unknown as UserRow;
    const now = Date.now();
    const { available } = freeSeedState(u, now);
    if (available <= 0) throw new GameError("No free seeds yet — check back later.");
    const period = config.freeSeedHours * HOUR;
    const accrued = Math.floor((now - u.free_seed_at) / period);
    // Keep the partial progress towards the next seed unless we were capped.
    const capped = u.free_seeds + accrued >= config.freeSeedCap;
    const newAnchor = capped ? now : u.free_seed_at + accrued * period;
    db.prepare("UPDATE users SET free_seeds = 0, free_seed_at = ? WHERE id = ?").run(newAnchor, userId);
    const ids = [];
    for (let i = 0; i < available; i++) ids.push(addSeed(userId, wildGenome(rng()), "wild", null, 0));
    logEvent(userId, "claim", { n: available });
    return ids.length;
  });
}

// ------------------------------------------------------------------ seeds & plants

export function addSeed(owner: string, g: Genome, origin: string, parents: string[] | null, generation: number) {
  const id = newId();
  db.prepare("INSERT INTO seeds (id, owner_id, genome, origin, parents, generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, owner, JSON.stringify(g), origin, parents ? JSON.stringify(parents) : null, generation, Date.now());
  return id;
}

interface SeedRow { id: string; owner_id: string; genome: string; origin: string; parents: string | null; generation: number; created_at: number; }
interface PlantRow {
  user_id: string; slot: number; genome: string; origin: string; parents: string | null; generation: number;
  planted_at: number; grow_ms: number; boost_ms: number; waters: number; last_water_at: number | null;
}

export function plantProgress(p: PlantRow, now = Date.now()) {
  return Math.min(1, (now - p.planted_at + p.boost_ms) / p.grow_ms);
}
const stageOf = (progress: number) => progress >= 1 ? "bloom" : progress >= 0.6 ? "bud" : progress >= 0.2 ? "sprout" : "seed";

export function plant(userId: string, seedId: string, slot: number) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= config.plots) throw new GameError("No such plot.");
  tx(() => {
    const seed = db.prepare("SELECT * FROM seeds WHERE id = ? AND owner_id = ?").get(seedId, userId) as SeedRow | undefined;
    if (!seed) throw new GameError("That seed isn't in your pouch.");
    const occupied = db.prepare("SELECT 1 FROM plants WHERE user_id = ? AND slot = ?").get(userId, slot);
    if (occupied) throw new GameError("That plot is already planted.");
    db.prepare("DELETE FROM seeds WHERE id = ?").run(seedId);
    db.prepare(`INSERT INTO plants (user_id, slot, genome, origin, parents, generation, planted_at, grow_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, slot, seed.genome, seed.origin, seed.parents, seed.generation, Date.now(), growTimeMs(seed.origin, seed.generation));
  });
  logEvent(userId, "plant");
}

export function water(userId: string, slot: number) {
  const p = db.prepare("SELECT * FROM plants WHERE user_id = ? AND slot = ?").get(userId, slot) as PlantRow | undefined;
  if (!p) throw new GameError("Nothing is growing there.");
  const now = Date.now();
  if (plantProgress(p, now) >= 1) throw new GameError("It's already in bloom.");
  if (p.waters >= MAX_WATERS) throw new GameError("It's had all the water it needs.");
  if (p.last_water_at && now - p.last_water_at < WATER_COOLDOWN * config.growScale)
    throw new GameError("The soil is still damp. Try again a little later.");
  db.prepare("UPDATE plants SET boost_ms = boost_ms + ?, waters = waters + 1, last_water_at = ? WHERE user_id = ? AND slot = ?")
    .run(Math.round(p.grow_ms * 0.15), now, userId, slot);
  logEvent(userId, "water");
}

export function compost(userId: string, slot: number) {
  const r = db.prepare("DELETE FROM plants WHERE user_id = ? AND slot = ?").run(userId, slot);
  if (!r.changes) throw new GameError("Nothing is growing there.");
  logEvent(userId, "compost");
}

export function harvest(userId: string, slot: number) {
  return tx(() => {
    const p = db.prepare("SELECT * FROM plants WHERE user_id = ? AND slot = ?").get(userId, slot) as PlantRow | undefined;
    if (!p) throw new GameError("Nothing is growing there.");
    if (plantProgress(p) < 1) throw new GameError("It hasn't bloomed yet.");
    db.prepare("DELETE FROM plants WHERE user_id = ? AND slot = ?").run(userId, slot);
    const g = JSON.parse(p.genome) as Genome;
    const id = newId();
    const species = speciesName(g), rarity = rarityOf(g), now = Date.now();
    db.prepare(`INSERT INTO blooms (id, owner_id, grower_id, genome, species, rarity, score, origin, parents, generation, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, userId, p.genome, species, rarity, rarityScore(g), p.origin, p.parents, p.generation, now);
    const known = db.prepare("UPDATE species SET count = count + 1 WHERE name = ?").run(species);
    let discovered = false;
    if (!known.changes) {
      db.prepare("INSERT INTO species (name, rarity, first_bloom_id, first_user_id, discovered_at) VALUES (?, ?, ?, ?, ?)")
        .run(species, rarity, id, userId, now);
      discovered = true;
    }
    logEvent(userId, "harvest", { rarity, discovered });
    return { id, species, rarity, discovered };
  });
}

// ------------------------------------------------------------------ blooms

export interface BloomRow {
  id: string; owner_id: string | null; grower_id: string | null; genome: string; species: string; rarity: string;
  score: number; origin: string; parents: string | null; generation: number; state: string; item_id: string | null;
  pollinated_at: number | null; created_at: number; featured_slot?: number | null;
}

export function bloomView(b: BloomRow, now = Date.now()) {
  return {
    id: b.id,
    genome: JSON.parse(b.genome) as Genome,
    species: b.species,
    rarity: b.rarity,
    score: b.score,
    origin: b.origin,
    generation: b.generation,
    parents: b.parents ? JSON.parse(b.parents) as string[] : null,
    state: b.state,
    itemId: b.item_id,
    pollenReadyAt: b.pollinated_at && now - b.pollinated_at < POLLINATE_COOLDOWN ? b.pollinated_at + POLLINATE_COOLDOWN : null,
    createdAt: b.created_at,
    featuredSlot: b.featured_slot ?? null,
  };
}

// ------------------------------------------------------------------ profiles (#13)

export const FEATURED_SLOTS = 5;
export const BIO_MAX = 280;

/** Put a flower in a featured slot (moving out whatever was there), or take it out with slot = null. */
export function feature(userId: string, bloomId: string, slot: number | null) {
  if (slot !== null && (!Number.isInteger(slot) || slot < 0 || slot >= FEATURED_SLOTS)) throw new GameError("No such slot.");
  tx(() => {
    const b = db.prepare("SELECT featured_slot FROM blooms WHERE id = ? AND owner_id = ? AND state = 'vase'").get(bloomId, userId) as { featured_slot: number | null } | undefined;
    if (!b) throw new GameError("That flower isn't in your vase.");
    if (slot === null) { db.prepare("UPDATE blooms SET featured_slot = NULL WHERE id = ?").run(bloomId); return; }
    // Swap: the flower already in the target slot moves to this flower's old slot (or out).
    db.prepare("UPDATE blooms SET featured_slot = NULL WHERE id = ?").run(bloomId);
    db.prepare("UPDATE blooms SET featured_slot = ? WHERE owner_id = ? AND featured_slot = ?").run(b.featured_slot, userId, slot);
    db.prepare("UPDATE blooms SET featured_slot = ? WHERE id = ?").run(slot, bloomId);
  });
  logEvent(userId, "feature");
}

export function setBio(userId: string, bio: string) {
  const clean = bio.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length > BIO_MAX) throw new GameError(`Keep it under ${BIO_MAX} characters.`);
  db.prepare("UPDATE users SET bio = ? WHERE id = ?").run(clean, userId);
  return clean;
}

export function profileView(username: string) {
  const u = db.prepare("SELECT id, username, bio, created_at FROM users WHERE username = ? COLLATE NOCASE").get(username) as
    { id: string; username: string; bio: string; created_at: number } | undefined;
  if (!u) return null;
  const one = (sql: string) => (db.prepare(sql).get(u.id) as { n: number | null }).n ?? 0;
  const featured = (db.prepare("SELECT * FROM blooms WHERE owner_id = ? AND featured_slot IS NOT NULL ORDER BY featured_slot").all(u.id) as unknown as BloomRow[]).map((b) => bloomView(b));
  const discoveries = (db.prepare(`SELECT b.* FROM species s JOIN blooms b ON b.id = s.first_bloom_id WHERE s.first_user_id = ?
                                   ORDER BY b.score DESC, s.discovered_at DESC LIMIT 12`).all(u.id) as unknown as BloomRow[]).map((b) => bloomView(b));
  return {
    username: u.username,
    bio: u.bio,
    joined: u.created_at,
    stats: {
      grown: one("SELECT COUNT(*) n FROM events WHERE user_id = ? AND kind = 'harvest'"),
      inVase: one("SELECT COUNT(*) n FROM blooms WHERE owner_id = ? AND state = 'vase'"),
      species: one("SELECT COUNT(*) n FROM species WHERE first_user_id = ?"),
      bestGeneration: one("SELECT MAX(generation) n FROM blooms WHERE grower_id = ?"),
    },
    featured,
    discoveries,
  };
}

export function pollinate(userId: string, aId: string, bId: string) {
  if (aId === bId) throw new GameError("A flower can't pollinate itself.");
  return tx(() => {
    const get = (id: string) => db.prepare("SELECT * FROM blooms WHERE id = ? AND owner_id = ? AND state = 'vase'").get(id, userId) as BloomRow | undefined;
    const a = get(aId), b = get(bId);
    if (!a || !b) throw new GameError("Both flowers must be in your vase.");
    const now = Date.now();
    for (const x of [a, b]) {
      if (x.pollinated_at && now - x.pollinated_at < POLLINATE_COOLDOWN)
        throw new GameError(`${x.species} needs time to make more pollen.`);
    }
    const child = breed(JSON.parse(a.genome), JSON.parse(b.genome), rng());
    const gen = Math.max(a.generation, b.generation) + 1;
    db.prepare("UPDATE blooms SET pollinated_at = ? WHERE id IN (?, ?)").run(now, a.id, b.id);
    const seedId = addSeed(userId, child, "hybrid", [a.id, b.id], gen);
    logEvent(userId, "pollinate", { gen });
    return seedId;
  });
}

/** Fertiliser gained by composting a flower, by rarity. */
export const COMPOST_YIELD: Record<string, number> = { Common: 1, Uncommon: 2, Rare: 3, Epic: 5, Legendary: 8 };
/** Fertiliser one application costs, and how much of the plant's total growth it skips. */
export const FERTILISE_COST = 3;
const FERTILISE_BOOST = 0.25;

/** Compost flowers from the vase into fertiliser. Returns the fertiliser gained. */
export function compostBlooms(userId: string, bloomIds: string[]) {
  const ids = [...new Set(bloomIds)].slice(0, 200);
  if (!ids.length) throw new GameError("Pick some flowers to compost.");
  return tx(() => {
    let gained = 0, n = 0;
    for (const id of ids) {
      const b = db.prepare("SELECT rarity FROM blooms WHERE id = ? AND owner_id = ? AND state = 'vase'").get(id, userId) as { rarity: string } | undefined;
      if (!b) continue;
      db.prepare("DELETE FROM blooms WHERE id = ?").run(id);
      gained += COMPOST_YIELD[b.rarity] ?? 1;
      n++;
    }
    if (!n) throw new GameError("Those flowers aren't in your vase.");
    db.prepare("UPDATE users SET fertiliser = fertiliser + ? WHERE id = ?").run(gained, userId);
    logEvent(userId, "release", { n, gained });
    return { composted: n, gained, fertiliser: fertiliserOf(userId) };
  });
}

/** Back-compat single-flower compost. */
export function release(userId: string, bloomId: string) {
  return compostBlooms(userId, [bloomId]);
}

export const fertiliserOf = (userId: string) =>
  (db.prepare("SELECT fertiliser FROM users WHERE id = ?").get(userId) as { fertiliser: number } | undefined)?.fertiliser ?? 0;

/** Spend fertiliser to skip a quarter of a growing plant's total growth time. */
export function fertilise(userId: string, slot: number) {
  return tx(() => {
    const p = db.prepare("SELECT * FROM plants WHERE user_id = ? AND slot = ?").get(userId, slot) as PlantRow | undefined;
    if (!p) throw new GameError("Nothing is growing there.");
    if (plantProgress(p) >= 1) throw new GameError("It's already in bloom.");
    const r = db.prepare("UPDATE users SET fertiliser = fertiliser - ? WHERE id = ? AND fertiliser >= ?").run(FERTILISE_COST, userId, FERTILISE_COST);
    if (!r.changes) throw new GameError(`You need ${FERTILISE_COST} fertiliser. Compost some flowers from your vase to make more.`);
    db.prepare("UPDATE plants SET boost_ms = boost_ms + ? WHERE user_id = ? AND slot = ?").run(Math.round(p.grow_ms * FERTILISE_BOOST), userId, slot);
    logEvent(userId, "fertilise");
    return { fertiliser: fertiliserOf(userId) };
  });
}

// ------------------------------------------------------------------ views

export function gardenView(userId: string) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as unknown as UserRow;
  const now = Date.now();
  const plants = db.prepare("SELECT * FROM plants WHERE user_id = ?").all(userId) as unknown as PlantRow[];
  const plots = Array.from({ length: config.plots }, (_, slot) => {
    const p = plants.find((x) => x.slot === slot);
    if (!p) return { slot, plant: null };
    const progress = plantProgress(p, now);
    const g = JSON.parse(p.genome) as Genome;
    return {
      slot,
      plant: {
        // The genome is only revealed once it blooms; until then only the colour hints through.
        genome: progress >= 0.6 ? g : null,
        // What's visible while growing (colour, stem, leaves, leaf tint), so the drawing doesn't
        // jump when the rest of the genome is revealed at the bud stage (#18).
        hint: { hue: g.hue, sat: g.sat, lum: g.lum, stem: g.stem, curl: g.curl, leaves: g.leaves, leafTone: ((g.hue2 % 40) + 40) % 40 },
        origin: p.origin,
        generation: p.generation,
        stage: stageOf(progress),
        progress,
        readyAt: p.planted_at + p.grow_ms - p.boost_ms,
        growMs: p.grow_ms,
        waters: p.waters,
        // 0 means "now", so clients don't compare against their own (possibly skewed) clock.
        canWaterAt: p.waters >= 3 || progress >= 1 ? null : (p.last_water_at ? Math.max(0, p.last_water_at + WATER_COOLDOWN * config.growScale) : 0),
      },
    };
  });
  const seeds = (db.prepare("SELECT * FROM seeds WHERE owner_id = ? ORDER BY created_at DESC").all(userId) as unknown as SeedRow[])
    .map((s) => {
      const g = JSON.parse(s.genome) as Genome;
      return { id: s.id, origin: s.origin, generation: s.generation, hint: { hue: g.hue, sat: g.sat, lum: g.lum }, parents: s.parents ? JSON.parse(s.parents) : null };
    });
  return { plots, seeds, freeSeeds: freeSeedState(u, now), serverNow: now, fertiliser: u.fertiliser ?? 0, fertiliseCost: FERTILISE_COST };
}

export function vaseView(userId: string) {
  // speciesCount: how many of this species have ever been grown, for sorting by global rarity (#10).
  const rows = db.prepare(`SELECT b.*, COALESCE(s.count, 1) AS species_count FROM blooms b LEFT JOIN species s ON s.name = b.species
                           WHERE b.owner_id = ? ORDER BY b.created_at DESC`).all(userId) as unknown as (BloomRow & { species_count: number })[];
  return { blooms: rows.map((b) => ({ ...bloomView(b), speciesCount: b.species_count })), fertiliser: fertiliserOf(userId), compostYield: COMPOST_YIELD };
}

// ------------------------------------------------------------------ gifts (#3)

export const GIFTS_PER_DAY = 10;

/** Give a flower from your vase to another gardener. It keeps its original grower. */
export function giftBloom(fromId: string, bloomId: string, toUsername: string) {
  const name = toUsername.trim().replace(/^@/, "");
  if (!name) throw new GameError("Who should it go to?");
  return tx(() => {
    const to = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(name) as { id: string; username: string } | undefined;
    if (!to) throw new GameError(`There's no gardener called ${name} yet.`);
    if (to.id === fromId) throw new GameError("That's you!");
    const sent = (db.prepare("SELECT COUNT(*) n FROM gifts WHERE from_id = ? AND at > ?").get(fromId, Date.now() - 86400_000) as { n: number }).n;
    if (sent >= GIFTS_PER_DAY) throw new GameError(`You can send ${GIFTS_PER_DAY} gifts a day. Try again tomorrow.`);
    const b = db.prepare("SELECT id, species FROM blooms WHERE id = ? AND owner_id = ? AND state = 'vase'").get(bloomId, fromId) as { id: string; species: string } | undefined;
    if (!b) throw new GameError("That flower isn't in your vase.");
    db.prepare("UPDATE blooms SET owner_id = ?, featured_slot = NULL WHERE id = ?").run(to.id, b.id);
    db.prepare("INSERT INTO gifts (id, bloom_id, species, from_id, to_id, at) VALUES (?, ?, ?, ?, ?, ?)").run(newId(), b.id, b.species, fromId, to.id, Date.now());
    logEvent(fromId, "gift");
    return { to: to.username, species: b.species };
  });
}

/** Gifts you haven't acknowledged yet. */
export function newGifts(userId: string) {
  return db.prepare(`SELECT g.bloom_id AS bloomId, g.species, u.username AS sender, g.at FROM gifts g
                     LEFT JOIN users u ON u.id = g.from_id WHERE g.to_id = ? AND g.seen = 0 ORDER BY g.at`).all(userId);
}
export function markGiftsSeen(userId: string) {
  db.prepare("UPDATE gifts SET seen = 1 WHERE to_id = ? AND seen = 0").run(userId);
}

// ------------------------------------------------------------------ family tree (#4)

export interface LineageNode { id: string; missing?: boolean; species?: string; rarity?: string; genome?: Genome; generation?: number; grower?: string | null; parents: LineageNode[] }

/** Ancestors of a flower, up to `depth` generations back. Composted ancestors appear as missing. */
export function lineage(id: string, depth = 4): LineageNode | null {
  const get = db.prepare(`SELECT b.id, b.species, b.rarity, b.genome, b.generation, b.parents, u.username AS grower
                          FROM blooms b LEFT JOIN users u ON u.id = b.grower_id WHERE b.id = ?`);
  const visit = (bid: string, d: number): LineageNode => {
    const r = get.get(bid) as any;
    if (!r) return { id: bid, missing: true, parents: [] };
    const parents: string[] = r.parents ? JSON.parse(r.parents) : [];
    return {
      id: r.id, species: r.species, rarity: r.rarity, genome: JSON.parse(r.genome), generation: r.generation, grower: r.grower,
      parents: d > 0 ? parents.slice(0, 2).map((p) => visit(p, d - 1)) : [],
    };
  };
  if (!get.get(id)) return null;
  return visit(id, Math.max(0, Math.min(depth, 5)));
}
