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
