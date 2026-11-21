// Weekly commissions (#2): one breeding target per week, generated from the week number so every
// server and client agrees on it without storing anything.
import { type Genome, SHAPES, PATTERNS, colorName, mulberry32 } from "./genome.ts";

export const WEEK_MS = 7 * 24 * 3600_000;
/** Monday 2026-01-05 00:00 UTC: weeks are counted from here and start on Mondays. */
const EPOCH = Date.UTC(2026, 0, 5);
export const REWARDS = [25, 15, 10] as const;

export const weekOf = (t: number) => Math.floor((t - EPOCH) / WEEK_MS);
export const weekStart = (w: number) => EPOCH + w * WEEK_MS;

export interface Requirement { kind: string; value?: string | number; label: string }
export interface Commission { week: number; start: number; end: number; title: string; requirements: Requirement[] }

// Each target pairs one hard trait with one flavour, so it takes deliberate breeding.
const HARD: Requirement[] = [
  { kind: "glow", label: "Luminous" },
  { kind: "iridescent", label: "Opaline" },
  { kind: "shape", value: 6, label: "Starbloom form" },
  { kind: "pattern", value: 4, label: "Ember-tipped petals" },
  { kind: "colour", value: "Midnight", label: "Midnight colour" },
  { kind: "layers", value: 3, label: "Three petal layers" },
];
const VIVID = ["Crimson", "Amber", "Golden", "Jade", "Teal", "Azure", "Cobalt", "Indigo", "Amethyst", "Orchid", "Magenta"];

function flavours(hard: Requirement): Requirement[] {
  const out: Requirement[] = [];
  if (hard.kind !== "shape") for (let s = 0; s < 6; s++) out.push({ kind: "shape", value: s, label: `${SHAPES[s]} form` });
  if (hard.kind !== "pattern") for (let p = 1; p < 4; p++) out.push({ kind: "pattern", value: p, label: `${PATTERNS[p]} pattern` });
  if (hard.kind !== "colour") for (const c of VIVID) out.push({ kind: "colour", value: c, label: `${c} colour` });
  out.push({ kind: "generation", value: 3, label: "Generation 3 or later" });
  return out;
}

export function commissionFor(week: number): Commission {
  const r = mulberry32(week * 7919 + 17);
  const hard = HARD[Math.floor(r() * HARD.length)];
  const options = flavours(hard);
  const flavour = options[Math.floor(r() * options.length)];
  const requirements = [hard, flavour];
  return { week, start: weekStart(week), end: weekStart(week + 1), title: describe(requirements), requirements };
}

function describe(reqs: Requirement[]): string {
  const adj: string[] = [];
  let noun = "flower";
  const extra: string[] = [];
  for (const q of reqs) {
    if (q.kind === "glow") adj.push("luminous");
    else if (q.kind === "iridescent") adj.push("opaline");
    else if (q.kind === "colour") adj.push(String(q.value));
    else if (q.kind === "shape") noun = SHAPES[Number(q.value)];
    else if (q.kind === "pattern") adj.unshift(String(PATTERNS[Number(q.value)]).toLowerCase());
    else if (q.kind === "layers") extra.push("with three layers of petals");
    else if (q.kind === "generation") extra.push(`bred to generation ${q.value}+`);
  }
  const phrase = [...adj, noun].join(" ");
  const article = /^[aeiou]/i.test(phrase) ? "An" : "A";
  return `${article} ${phrase}${extra.length ? " " + extra.join(" ") : ""}`;
}

export function meets(g: Genome, generation: number, q: Requirement): boolean {
  switch (q.kind) {
    case "glow": return g.glow;
    case "iridescent": return g.iridescent;
    case "shape": return g.shape === q.value;
    case "pattern": return g.pattern === q.value;
    case "colour": return colorName(g) === q.value;
    case "layers": return g.layers >= Number(q.value);
    case "generation": return generation >= Number(q.value);
    default: return false;
  }
}

export const matches = (c: Commission, g: Genome, generation: number) => c.requirements.every((q) => meets(g, generation, q));

const COLOUR_HSL: Record<string, [number, number, number]> = {
  Crimson: [2, 82, 52], Amber: [38, 85, 52], Golden: [54, 85, 52], Jade: [120, 70, 48], Teal: [172, 70, 45],
  Azure: [195, 80, 52], Cobalt: [225, 80, 52], Indigo: [255, 75, 55], Amethyst: [280, 70, 55], Orchid: [305, 70, 55],
  Magenta: [335, 80, 55], Midnight: [250, 70, 27],
};

/** A flower that meets the commission, built from `base`: used to draw the target, and in tests. */
export function exampleGenome(c: Commission, base: Genome): Genome {
  const g: Genome = { ...base, glow: false, iridescent: false };
  if (g.lum < 33) g.lum = 55;
  for (const q of c.requirements) {
    if (q.kind === "glow") g.glow = true;
    if (q.kind === "iridescent") g.iridescent = true;
    if (q.kind === "shape") g.shape = Number(q.value);
    if (q.kind === "pattern") g.pattern = Number(q.value);
    if (q.kind === "layers") g.layers = Number(q.value);
    if (q.kind === "colour") [g.hue, g.sat, g.lum] = COLOUR_HSL[String(q.value)];
  }
  return g;
}
