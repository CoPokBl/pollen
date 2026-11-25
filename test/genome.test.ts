import { describe, expect, it } from "vitest";
import { breed, mulberry32, rarityOf, renderFlower, speciesName, validGenome, wildGenome } from "../shared/genome.ts";
import { coinsToRaw, rawToCoins } from "../server/config.ts";

describe("genome", () => {
  it("wild genomes are valid and render at every stage", () => {
    const r = mulberry32(1);
    for (let i = 0; i < 300; i++) {
      const g = wildGenome(r, i % 2 ? 1 : 5);
      expect(validGenome(g)).toBe(true);
      for (const stage of ["seed", "sprout", "bud", "bloom"] as const) {
        const svg = renderFlower(g, { stage, soil: true });
        expect(svg.startsWith("<svg")).toBe(true);
        expect(svg).not.toMatch(/NaN|undefined/);
      }
    }
  });
  it("breeding keeps genes in range", () => {
    const r = mulberry32(2);
    let a = wildGenome(r), b = wildGenome(r);
    for (let i = 0; i < 500; i++) {
      const c = breed(a, b, r);
      expect(validGenome(c)).toBe(true);
      expect(c.petals).toBeGreaterThanOrEqual(3); expect(c.petals).toBeLessThanOrEqual(12);
      expect(c.hue).toBeGreaterThanOrEqual(0); expect(c.hue).toBeLessThan(360);
      expect(c.lum).toBeGreaterThanOrEqual(22); expect(c.lum).toBeLessThanOrEqual(78);
      [a, b] = [b, c];
    }
  });
  it("rare traits are rare in the wild", () => {
    const r = mulberry32(3);
    let glow = 0;
    for (let i = 0; i < 10000; i++) if (wildGenome(r).glow) glow++;
    expect(glow).toBeGreaterThan(100); expect(glow).toBeLessThan(350);
  });
  it("names and rarities are stable", () => {
    const g = wildGenome(mulberry32(42));
    expect(speciesName(g)).toBe(speciesName({ ...g }));
    expect(["Common", "Uncommon", "Rare", "Epic", "Legendary"]).toContain(rarityOf(g));
  });
});

describe("coins", () => {
  it("converts decimal coins to Serble fixed point", () => {
    expect(coinsToRaw("1")).toBe(16777216n);
    expect(coinsToRaw("10")).toBe(167772160n);
    expect(coinsToRaw("0.5")).toBe(8388608n);
    expect(rawToCoins(167772160n)).toBe("10");
    expect(rawToCoins(coinsToRaw("2.5"))).toBe("2.5");
  });
});

describe("item icons", async () => {
  const { iconKey } = await import("../shared/icons.ts");
  const { readFileSync } = await import("node:fs");
  const icons: Record<string, string> = JSON.parse(readFileSync(new URL("../shared/icons.json", import.meta.url), "utf8"));
  it("every possible flower has an icon on Serble Files", () => {
    const r = mulberry32(9);
    let a = wildGenome(r, 6), b = wildGenome(r, 6);
    for (let i = 0; i < 20000; i++) {
      const g = i % 2 ? wildGenome(r, i % 7) : breed(a, b, r);
      if (i % 3 === 0) [a, b] = [b, g];
      expect(icons[iconKey(g)], iconKey(g)).toMatch(/^https:\/\/api\.files\.serble\.net\/files\/[a-z0-9]+\.png$/);
    }
  });
});

describe("inheritance (#15)", async () => {
  const { crossOdds, RARE_TRAIT_INHERITANCE } = await import("../shared/genome.ts");
  const base = wildGenome(mulberry32(11));
  const lum = { ...base, glow: true, iridescent: false }, opa = { ...base, glow: false, iridescent: true };
  const both = { ...base, glow: true, iridescent: true }, plain = { ...base, glow: false, iridescent: false };
  it("rare traits pass on at the advertised rates", () => {
    const close = (x: number, p: number) => expect(Math.abs(x - p * 100)).toBeLessThan(3.5);
    close(crossOdds(lum, plain).luminous, RARE_TRAIT_INHERITANCE[1]);
    close(crossOdds(lum, lum).luminous, RARE_TRAIT_INHERITANCE[2]);
    close(crossOdds(plain, plain).luminous, RARE_TRAIT_INHERITANCE[0]);
  });
  it("breeding toward both traits pays off", () => {
    expect(crossOdds(lum, opa).both).toBeGreaterThan(9);      // ~12%: a long shot from one of each
    expect(crossOdds(both, both).both).toBeGreaterThan(65);   // ~72%: breed two carriers of both
  });
});

describe("weekly commissions (#2)", async () => {
  const { commissionFor, exampleGenome, matches, weekOf, weekStart } = await import("../shared/commission.ts");
  it("weeks start on Monday 00:00 UTC", () => {
    const w = weekOf(Date.UTC(2026, 10, 18, 12));
    expect(new Date(weekStart(w)).toISOString()).toBe("2026-11-16T00:00:00.000Z");
  });
  it("every week's target is achievable and reads well", () => {
    const base = wildGenome(mulberry32(5));
    const titles = new Set<string>();
    for (let w = 0; w < 400; w++) {
      const c = commissionFor(w);
      expect(c.requirements.length).toBeGreaterThanOrEqual(2);
      expect(c.requirements.some((q) => q.kind === "generation"), c.title).toBe(true);   // always needs breeding
      expect(matches(c, exampleGenome(c, base), 5), c.title).toBe(true);
      expect(matches(c, exampleGenome(c, base), 0), c.title).toBe(false);              // a packet flower never qualifies
      if (w > 0) expect(c.requirements[0].kind + c.requirements[0].value, `week ${w} repeats`).not.toBe(commissionFor(w - 1).requirements[0].kind + commissionFor(w - 1).requirements[0].value);
      expect(c.title).toMatch(/^An? [a-zA-Z-]/);
      titles.add(c.title);
    }
    expect(titles.size).toBeGreaterThan(60);          // plenty of variety
    expect(commissionFor(3).title).toBe(commissionFor(3).title);
  });
  it("a plain flower doesn't qualify", () => {
    const c = commissionFor(weekOf(Date.now()));
    const plain = { ...wildGenome(mulberry32(1)), glow: false, iridescent: false, shape: 0, pattern: 0, layers: 1, lum: 55, hue: 30, sat: 40 };
    expect(matches(c, plain, 0)).toBe(false);
  });
});

describe("species art fallback", async () => {
  const { genomeFromSpecies, speciesName, SHAPES } = await import("../shared/genome.ts");
  it("rebuilds every species name exactly", () => {
    const r = mulberry32(21);
    const seen = new Set<string>();
    for (let i = 0; i < 60000; i++) seen.add(speciesName(wildGenome(r, (i % 9) + 1)));
    expect(seen.size).toBeGreaterThan(400);
    for (const name of seen) {
      const g = genomeFromSpecies(name);
      expect(g, name).not.toBeNull();
      expect(speciesName(g!), name).toBe(name);
    }
    expect(genomeFromSpecies("Not A Flower")).toBeNull();
    expect(SHAPES.length).toBe(7);
  });
});

describe("commission breeding tips", async () => {
  const { commissionFor, breedingTip } = await import("../shared/commission.ts");
  it("every requirement of every week has a tip", () => {
    for (let w = 0; w < 200; w++) for (const q of commissionFor(w).requirements) expect(breedingTip(q).length, q.label).toBeGreaterThan(10);
  });
});

describe("tip numbers match the genetics", () => {
  it("form, pattern, layers and Midnight inherit at the advertised rates", () => {
    const r = mulberry32(31); const N = 20000;
    let shape1 = 0, shape2 = 0, mid1 = 0, mid2 = 0;
    for (let i = 0; i < N; i++) {
      const a = { ...wildGenome(r), shape: 5, lum: 27 };
      if (breed(a, { ...wildGenome(r), shape: 1 }, r).shape === 5) shape1++;
      if (breed(a, { ...a }, r).shape === 5) shape2++;
      const b = { ...wildGenome(r), lum: 60 };
      if (breed(a, b, r).lum < 33) mid1++;
      if (breed(a, { ...wildGenome(r), lum: 28 }, r).lum < 33) mid2++;
    }
    const near = (n: number, pct: number, tol = 4) => expect(Math.abs((n / N) * 100 - pct)).toBeLessThan(tol);
    near(shape1, 47); near(shape2, 93); near(mid1, 20, 6); near(mid2, 92);
  });
});

describe("continuous growth (#18)", async () => {
  const { renderFlower } = await import("../shared/genome.ts");
  it("is unchanged at full bloom and renders cleanly at every point", () => {
    const r = mulberry32(44);
    for (let i = 0; i < 100; i++) {
      const g = wildGenome(r, 5);
      for (let p = 0; p < 1; p += 0.05) {
        const svg = renderFlower(g, { progress: p, soil: true, uid: "t" });
        expect(svg.startsWith("<svg")).toBe(true);
        expect(svg).not.toMatch(/NaN|undefined|Infinity/);
      }
      expect(renderFlower(g, { progress: 1, uid: "t" })).toBe(renderFlower(g, { uid: "t" }));
    }
  });
  it("the hidden-genome stand-in draws exactly the same until the head opens", () => {
    const r = mulberry32(45);
    for (let i = 0; i < 200; i++) {
      const g = wildGenome(r, 5);
      // what the server sends before the bud stage, and how the garden builds its stand-in
      const hint = { hue: g.hue, sat: g.sat, lum: g.lum, stem: g.stem, curl: g.curl, leaves: g.leaves, leafTone: ((g.hue2 % 40) + 40) % 40 };
      const stand = { hue: hint.hue, hue2: hint.leafTone, sat: hint.sat, lum: hint.lum, petals: 5, shape: 0, layers: 1, pattern: 0, center: 0,
        centerHue: 50, stem: hint.stem, leaves: hint.leaves, curl: hint.curl, glow: false, iridescent: false };
      for (const p of [0.05, 0.2, 0.4, 0.55, 0.6, 0.65, 0.7]) {
        expect(renderFlower(stand, { progress: p, soil: true, uid: "s" }), `p=${p}`).toBe(renderFlower(g, { progress: p, soil: true, uid: "s" }));
      }
    }
  });
});
