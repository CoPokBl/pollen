// Flower genetics and rendering, shared by the server (which owns the truth) and the web client
// (which only draws). Everything here is pure and deterministic given its inputs.

export interface Genome {
  hue: number;        // 0-359 main petal hue
  hue2: number;       // 0-359 secondary (pattern) hue
  sat: number;        // 35-95
  lum: number;        // 22-78
  petals: number;     // 3-12
  shape: number;      // 0..6 see SHAPES
  layers: number;     // 1-3
  pattern: number;    // 0..4 see PATTERNS
  center: number;     // 0..3 centre style
  centerHue: number;  // 0-359
  stem: number;       // 0-1 stem length factor
  leaves: number;     // 0-3
  curl: number;       // -1..1 petal twist
  glow: boolean;
  iridescent: boolean;
}

export const SHAPES = ["Poppy", "Lily", "Violet", "Aster", "Tulip", "Peony", "Starbloom"] as const;
export const PATTERNS = ["", "Dusk", "Tiger", "Freckled", "Ember-tipped"] as const;
export const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"] as const;
export type Rarity = (typeof RARITIES)[number];

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return h1 >>> 0;
}

const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrapHue = (h: number) => ((Math.round(h) % 360) + 360) % 360;
function pickWeighted(r: Rng, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x < 0) return i; }
  return weights.length - 1;
}

const SHAPE_WEIGHTS = [24, 22, 16, 16, 12, 8, 2];
const PATTERN_WEIGHTS = [40, 22, 14, 18, 6];

/** A wild genome. `luck` (>=1) multiplies the odds of rare traits, used for bought packets. */
export function wildGenome(r: Rng, luck = 1): Genome {
  const boost = (w: number[], rareFrom: number) => w.map((v, i) => (i >= rareFrom ? v * luck : v));
  const dark = r() < 0.03 * luck;
  return {
    hue: int(r, 0, 359),
    hue2: int(r, 0, 359),
    sat: int(r, 45, 92),
    lum: dark ? int(r, 22, 32) : int(r, 45, 72),
    petals: int(r, 4, 9) + (r() < 0.15 ? int(r, -1, 3) : 0),
    shape: pickWeighted(r, boost(SHAPE_WEIGHTS, 5)),
    layers: r() < 0.6 ? 1 : r() < 0.8 ? 2 : 3,
    pattern: pickWeighted(r, boost(PATTERN_WEIGHTS, 4)),
    center: int(r, 0, 3),
    centerHue: r() < 0.6 ? int(r, 40, 60) : int(r, 0, 359),
    stem: Math.round(r() * 100) / 100,
    leaves: int(r, 0, 3),
    curl: Math.round((r() * 2 - 1) * 100) / 100,
    glow: r() < 0.02 * luck,
    iridescent: r() < 0.02 * luck,
  };
}

function blendHue(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return wrapHue(a + d * t);
}

/** Chance a child shows luminous/opaline when 0, 1 or 2 parents have it. Strong enough that
 * breeding, not luck, is the way to rare flowers (#15). */
export const RARE_TRAIT_INHERITANCE = [0.01, 0.35, 0.85] as const;

/** Estimate what a cross is likely to produce, by sampling it. */
export function crossOdds(a: Genome, b: Genome, samples = 3000) {
  const r = mulberry32(hashString(JSON.stringify([a, b])));
  const rarity: Record<string, number> = {};
  const shapes: Record<string, number> = {};
  let glow = 0, iri = 0, both = 0;
  for (let i = 0; i < samples; i++) {
    const c = breed(a, b, r);
    if (c.glow) glow++;
    if (c.iridescent) iri++;
    if (c.glow && c.iridescent) both++;
    const rr = rarityOf(c);
    rarity[rr] = (rarity[rr] ?? 0) + 1;
    shapes[SHAPES[c.shape]] = (shapes[SHAPES[c.shape]] ?? 0) + 1;
  }
  const pct = (n: number) => Math.round((n / samples) * 1000) / 10;
  const map = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, pct(v)]));
  return { luminous: pct(glow), opaline: pct(iri), both: pct(both), rarity: map(rarity), shapes: map(shapes) };
}

/** Cross two parents. Each gene comes from a parent, a blend, or (rarely) a mutation. */
export function breed(a: Genome, b: Genome, r: Rng): Genome {
  const wild = wildGenome(r, 1.5);
  const MUT = 0.08;
  const pick = <K extends keyof Genome>(k: K): Genome[K] =>
    r() < MUT ? wild[k] : r() < 0.5 ? a[k] : b[k];
  const hueGene = (k: "hue" | "hue2" | "centerHue") => {
    if (r() < MUT) return wild[k];
    if (r() < 0.5) return blendHue(a[k], b[k], 0.2 + r() * 0.6) + int(r, -12, 12);
    return r() < 0.5 ? a[k] : b[k];
  };
  const numGene = (k: "sat" | "lum" | "petals" | "stem" | "curl", lo: number, hi: number, round = true) => {
    if (r() < MUT) return wild[k];
    const t = r();
    const v = a[k] * t + b[k] * (1 - t) + (r() - 0.5) * (hi - lo) * 0.08;
    return clamp(round ? Math.round(v) : Math.round(v * 100) / 100, lo, hi);
  };
  const rareTrait = (k: "glow" | "iridescent") => {
    const n = (a[k] ? 1 : 0) + (b[k] ? 1 : 0);
    return r() < RARE_TRAIT_INHERITANCE[n];
  };
  return {
    hue: wrapHue(hueGene("hue")),
    hue2: wrapHue(hueGene("hue2")),
    sat: numGene("sat", 35, 95),
    lum: numGene("lum", 22, 78),
    petals: numGene("petals", 3, 12),
    shape: pick("shape"),
    layers: pick("layers"),
    pattern: pick("pattern"),
    center: pick("center"),
    centerHue: wrapHue(hueGene("centerHue")),
    stem: numGene("stem", 0, 1, false),
    leaves: pick("leaves"),
    curl: numGene("curl", -1, 1, false),
    glow: rareTrait("glow"),
    iridescent: rareTrait("iridescent"),
  };
}

export function colorName(g: Pick<Genome, "hue" | "sat" | "lum">): string {
  if (g.lum < 33) return "Midnight";
  if (g.sat < 42) return g.lum > 65 ? "Pearl" : "Ash";
  if (g.lum > 70) {
    const pastels = ["Blush", "Peach", "Butter", "Mint", "Mint", "Frost", "Lilac", "Rose"];
    return pastels[Math.floor(((g.hue + 22) % 360) / 45)];
  }
  const names: [number, string][] = [
    [12, "Crimson"], [30, "Vermilion"], [45, "Amber"], [62, "Golden"], [80, "Citrine"],
    [150, "Jade"], [185, "Teal"], [205, "Azure"], [240, "Cobalt"], [265, "Indigo"],
    [290, "Amethyst"], [320, "Orchid"], [345, "Magenta"], [360, "Crimson"],
  ];
  return names.find(([max]) => g.hue < max)![1];
}

export function rarityScore(g: Genome): number {
  let s = 0;
  if (g.shape === 6) s += 3;
  else if (g.shape === 5) s += 1;
  if (g.pattern === 4) s += 2;
  else if (g.pattern !== 0) s += 0.5;
  if (g.glow) s += 4;
  if (g.iridescent) s += 4;
  if (g.layers === 3) s += 1;
  if (g.petals <= 3 || g.petals >= 11) s += 1;
  if (g.lum < 33) s += 3;
  if (g.sat >= 88 && g.hue >= 195 && g.hue <= 245) s += 1; // a true, vivid blue
  return Math.floor(s);
}

export function rarityOf(g: Genome): Rarity {
  const s = rarityScore(g);
  return s >= 9 ? "Legendary" : s >= 6 ? "Epic" : s >= 4 ? "Rare" : s >= 2 ? "Uncommon" : "Common";
}

/** The species is what the Almanac counts: shape, pattern, colour and the two rare traits. */
export function speciesName(g: Genome): string {
  const parts: string[] = [];
  if (g.glow) parts.push("Luminous");
  if (g.iridescent) parts.push("Opaline");
  if (PATTERNS[g.pattern]) parts.push(PATTERNS[g.pattern]);
  parts.push(colorName(g));
  parts.push(SHAPES[g.shape] ?? "Bloom");
  return parts.join(" ");
}

export function validGenome(x: unknown): x is Genome {
  if (!x || typeof x !== "object") return false;
  const g = x as Record<string, unknown>;
  const nums = ["hue", "hue2", "sat", "lum", "petals", "shape", "layers", "pattern", "center", "centerHue", "stem", "leaves", "curl"];
  return nums.every((k) => typeof g[k] === "number" && Number.isFinite(g[k])) &&
    typeof g.glow === "boolean" && typeof g.iridescent === "boolean";
}

// ---------------------------------------------------------------- rendering

const hsl = (h: number, s: number, l: number, a = 1) =>
  a === 1 ? `hsl(${wrapHue(h)} ${clamp(s, 0, 100)}% ${clamp(l, 0, 100)}%)`
    : `hsl(${wrapHue(h)} ${clamp(s, 0, 100)}% ${clamp(l, 0, 100)}% / ${a})`;

function petalPath(shape: number, r: number, w: number): string {
  const f = (n: number) => n.toFixed(2);
  switch (shape) {
    case 0: return `M0 0C${f(w)} ${f(-r * 0.3)} ${f(w)} ${f(-r)} 0 ${f(-r)}C${f(-w)} ${f(-r)} ${f(-w)} ${f(-r * 0.3)} 0 0Z`;
    case 1: return `M0 0C${f(w)} ${f(-r * 0.4)} ${f(w * 0.45)} ${f(-r * 0.8)} 0 ${f(-r)}C${f(-w * 0.45)} ${f(-r * 0.8)} ${f(-w)} ${f(-r * 0.4)} 0 0Z`;
    case 2: return `M0 0C${f(w)} ${f(-r * 0.3)} ${f(w * 1.05)} ${f(-r * 1.02)} ${f(w * 0.38)} ${f(-r)}C${f(w * 0.14)} ${f(-r * 0.99)} 0 ${f(-r * 0.86)} 0 ${f(-r * 0.86)}C0 ${f(-r * 0.86)} ${f(-w * 0.14)} ${f(-r * 0.99)} ${f(-w * 0.38)} ${f(-r)}C${f(-w * 1.05)} ${f(-r * 1.02)} ${f(-w)} ${f(-r * 0.3)} 0 0Z`;
    case 3: return `M0 0L${f(w * 0.4)} ${f(-r * 0.45)}L0 ${f(-r)}L${f(-w * 0.4)} ${f(-r * 0.45)}Z`;
    case 4: return `M0 0C${f(w * 1.25)} ${f(-r * 0.15)} ${f(w * 0.95)} ${f(-r * 0.9)} ${f(w * 0.55)} ${f(-r)}L0 ${f(-r * 0.82)}L${f(-w * 0.55)} ${f(-r)}C${f(-w * 0.95)} ${f(-r * 0.9)} ${f(-w * 1.25)} ${f(-r * 0.15)} 0 0Z`;
    case 5: {
      const pts: string[] = [`M0 0`, `C${f(w * 1.1)} ${f(-r * 0.2)} ${f(w * 1.1)} ${f(-r * 0.75)} ${f(w * 0.8)} ${f(-r * 0.85)}`];
      const waves = 5;
      for (let i = 0; i < waves; i++) {
        const t0 = i / waves, t1 = (i + 1) / waves;
        const x1 = w * 0.8 - (w * 1.6) * t1;
        const xm = w * 0.8 - (w * 1.6) * (t0 + t1) / 2;
        const ym = -r * (1.06 - 0.07 * Math.abs(xm / w));
        pts.push(`Q${f(xm)} ${f(ym - r * 0.06)} ${f(x1)} ${f(-r * (0.9 + 0.08 * (1 - Math.abs(x1 / w))))}`);
      }
      pts.push(`C${f(-w * 1.1)} ${f(-r * 0.75)} ${f(-w * 1.1)} ${f(-r * 0.2)} 0 0Z`);
      return pts.join("");
    }
    case 6: return `M0 0Q${f(w * 0.28)} ${f(-r * 0.55)} 0 ${f(-r * 1.08)}Q${f(-w * 0.28)} ${f(-r * 0.55)} 0 0Z`;
    default: return `M0 0L0 ${-r}`;
  }
}

export type Stage = "seed" | "sprout" | "bud" | "bloom";

export interface RenderOpts {
  stage?: Stage;
  /** Unique prefix for SVG ids, so several flowers can share a page. */
  uid?: string;
  /** Draw the soil mound (for plots). */
  soil?: boolean;
  /** Animate glow/iridescence. */
  animate?: boolean;
  background?: string;
}

/** Returns a complete <svg> string for a flower at a growth stage. viewBox 0 0 200 220. */
export function renderFlower(g: Genome, opts: RenderOpts = {}): string {
  const stage = opts.stage ?? "bloom";
  const id = (opts.uid ?? "f" + hashString(JSON.stringify(g)).toString(36)).replace(/[^a-zA-Z0-9_-]/g, "");
  const rnd = mulberry32(hashString(JSON.stringify(g)));
  const out: string[] = [];
  const defs: string[] = [];
  const base = hsl(g.hue, g.sat, g.lum);
  const deep = hsl(g.hue, g.sat, g.lum - 14);
  const second = hsl(g.hue2, clamp(g.sat + 5, 0, 100), clamp(g.lum + (g.lum < 40 ? 22 : -6), 20, 80));
  const leafC = hsl(110 + (g.hue2 % 40), 38, 34);
  const leafD = hsl(120 + (g.hue2 % 40), 40, 26);

  if (opts.background) out.push(`<rect width="200" height="220" fill="${opts.background}"/>`);

  const groundY = 196;
  const stemLen = stage === "seed" ? 0 : stage === "sprout" ? 34 : 70 + g.stem * 50;
  const headX = 100 + (stage === "bloom" || stage === "bud" ? g.curl * 10 : 0);
  const headY = groundY - stemLen;

  if (opts.soil) {
    out.push(`<ellipse cx="100" cy="${groundY + 6}" rx="62" ry="13" fill="#6b4a33"/>`);
    out.push(`<ellipse cx="100" cy="${groundY + 2}" rx="54" ry="9" fill="#82593d"/>`);
  }

  if (stage === "seed") {
    out.push(`<ellipse cx="100" cy="${groundY - 3}" rx="9" ry="6" fill="${hsl(35, 45, 38)}" transform="rotate(-18 100 ${groundY - 3})"/>`);
    out.push(`<path d="M96 ${groundY - 5}q4 -3 8 0" stroke="${hsl(35, 40, 55)}" stroke-width="1.4" fill="none"/>`);
    return wrapSvg(out, defs);
  }

  // stem
  out.push(`<path d="M100 ${groundY}C${100 - g.curl * 14} ${groundY - stemLen * 0.4} ${headX + g.curl * 18} ${headY + stemLen * 0.45} ${headX} ${headY}" stroke="${leafD}" stroke-width="${stage === "sprout" ? 3 : 4}" fill="none" stroke-linecap="round"/>`);
  // leaves
  const leafCount = stage === "sprout" ? 2 : g.leaves;
  for (let i = 0; i < leafCount; i++) {
    const t = stage === "sprout" ? 1 : 0.25 + i * 0.22;
    const y = groundY - stemLen * t + (stage === "sprout" ? 2 : 0);
    const x = 100 + (headX - 100) * t;
    const side = i % 2 === 0 ? 1 : -1;
    const len = stage === "sprout" ? 16 : 26 - i * 3;
    out.push(`<path d="M0 0C${len * 0.3} ${-len * 0.45} ${len * 0.85} ${-len * 0.45} ${len} 0C${len * 0.85} ${len * 0.25} ${len * 0.3} ${len * 0.25} 0 0Z" fill="${leafC}" stroke="${leafD}" stroke-width="0.8" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${side} 1) rotate(-20)"/>`);
  }
  if (stage === "sprout") return wrapSvg(out, defs);

  if (stage === "bud") {
    out.push(`<g transform="translate(${headX} ${headY})">`);
    out.push(`<path d="M0 6C-13 0 -11 -20 0 -30C11 -20 13 0 0 6Z" fill="${base}" stroke="${deep}" stroke-width="1"/>`);
    out.push(`<path d="M0 6C-9 2 -12 -8 -8 -14L0 -4L8 -14C12 -8 9 2 0 6Z" fill="${leafC}"/>`);
    out.push(`</g>`);
    return wrapSvg(out, defs);
  }

  // ---- bloom
  const R = 44 + (g.petals < 6 ? 6 : 0);
  // petal fill per pattern
  const gradId = `${id}-pg`;
  let petalFill = base;
  if (g.pattern === 1 || g.pattern === 4) {
    const tip = g.pattern === 4 ? 0.62 : 0;
    defs.push(`<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="${-R}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="${g.pattern === 1 ? second : base}"/>` +
      (g.pattern === 4 ? `<stop offset="${tip}" stop-color="${base}"/>` : "") +
      `<stop offset="1" stop-color="${g.pattern === 1 ? base : second}"/></linearGradient>`);
    petalFill = `url(#${gradId})`;
  }
  if (g.iridescent) {
    defs.push(`<linearGradient id="${id}-ir" x1="0" y1="0" x2="1" y2="1">` +
      [0, 60, 140, 220, 300].map((h, i) => `<stop offset="${i / 4}" stop-color="${hsl(g.hue + h, 90, 72)}"/>`).join("") +
      (opts.animate ? `<animateTransform attributeName="gradientTransform" type="rotate" from="0 .5 .5" to="360 .5 .5" dur="8s" repeatCount="indefinite"/>` : "") +
      `</linearGradient>`);
  }
  if (g.glow) {
    defs.push(`<radialGradient id="${id}-gl"><stop offset="0" stop-color="${hsl(g.hue, 95, 70, 0.75)}"/><stop offset="1" stop-color="${hsl(g.hue, 95, 70, 0)}"/></radialGradient>`);
    out.push(`<circle cx="${headX}" cy="${headY}" r="${R * 1.7}" fill="url(#${id}-gl)">` +
      (opts.animate ? `<animate attributeName="opacity" values=".55;1;.55" dur="3.2s" repeatCount="indefinite"/>` : "") + `</circle>`);
  }

  out.push(`<g transform="translate(${headX.toFixed(1)} ${headY.toFixed(1)})">`);
  for (let layer = g.layers - 1; layer >= 0; layer--) {
    const scale = 1 - layer * 0.24;
    const n = g.petals + (layer > 0 ? (layer % 2) : 0);
    const r = R * scale;
    const w = r * (g.shape === 6 ? 0.5 : g.shape === 3 ? 0.42 : 0.62) * (6 / Math.max(4, n)) ** 0.5;
    const offset = layer * (180 / n) + g.curl * 12;
    const shade = layer === 0 ? 0 : -layer * 6;
    const fill = layer === 0 ? petalFill : (g.pattern === 1 || g.pattern === 4 ? petalFill : hsl(g.hue, g.sat, g.lum + shade));
    const d = petalPath(g.shape, r, w);
    for (let i = 0; i < n; i++) {
      const rot = offset + (360 / n) * i;
      out.push(`<g transform="rotate(${rot.toFixed(1)})">`);
      out.push(`<path d="${d}" fill="${fill}" stroke="${deep}" stroke-width="0.9" stroke-linejoin="round"/>`);
      if (g.pattern === 2) {
        out.push(`<path d="M0 ${(-r * 0.12).toFixed(1)}L0 ${(-r * 0.8).toFixed(1)}" stroke="${second}" stroke-width="${(w * 0.22).toFixed(1)}" stroke-linecap="round" opacity=".85"/>`);
      } else if (g.pattern === 3) {
        for (let k = 0; k < 3; k++) {
          const px = (rnd() - 0.5) * w * 0.7, py = -r * (0.3 + rnd() * 0.5);
          out.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(1 + rnd() * 1.6).toFixed(1)}" fill="${second}"/>`);
        }
      }
      if (g.iridescent) out.push(`<path d="${d}" fill="url(#${id}-ir)" opacity=".38"/>`);
      out.push(`</g>`);
    }
  }
  // centre
  const cc = hsl(g.centerHue, 70, 48), cd = hsl(g.centerHue, 65, 30);
  const cr = R * 0.2;
  switch (g.center) {
    case 0: out.push(`<circle r="${cr.toFixed(1)}" fill="${cc}" stroke="${cd}" stroke-width="1.2"/>`); break;
    case 1: {
      out.push(`<circle r="${cr.toFixed(1)}" fill="${cd}"/>`);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2, rr = cr * (0.35 + (i % 2) * 0.35);
        out.push(`<circle cx="${(Math.cos(a) * rr).toFixed(1)}" cy="${(Math.sin(a) * rr).toFixed(1)}" r="1.5" fill="${cc}"/>`);
      }
      break;
    }
    case 2: {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        out.push(`<path d="M0 0L${(Math.cos(a) * cr * 1.5).toFixed(1)} ${(Math.sin(a) * cr * 1.5).toFixed(1)}" stroke="${cd}" stroke-width="1.2"/>`);
        out.push(`<circle cx="${(Math.cos(a) * cr * 1.5).toFixed(1)}" cy="${(Math.sin(a) * cr * 1.5).toFixed(1)}" r="2" fill="${cc}"/>`);
      }
      out.push(`<circle r="${(cr * 0.5).toFixed(1)}" fill="${cc}"/>`);
      break;
    }
    default:
      out.push(`<circle r="${(cr * 1.1).toFixed(1)}" fill="${cd}"/><circle r="${(cr * 0.7).toFixed(1)}" fill="${cc}"/><circle r="${(cr * 0.3).toFixed(1)}" fill="${cd}"/>`);
  }
  out.push(`</g>`);
  return wrapSvg(out, defs);
}

function wrapSvg(body: string[], defs: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 220">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${body.join("")}</svg>`;
}
