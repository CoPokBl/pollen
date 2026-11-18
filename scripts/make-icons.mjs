// Renders one item icon per flower form x colour family, uploads them to Serble Files and writes
// shared/icons.json (form-colour key -> public URL). Serble only accepts item icons hosted on
// Serble Files, so exported blooms use the icon for their form and colour.
//
// Usage: FILES_TOKEN=<Serble Files token for the pollen account> npx tsx scripts/make-icons.mjs
// With DRY_RUN=1 it only renders the PNGs into ./icons-out for a look.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { SHAPES, colorName, renderFlower } from "../shared/genome.ts";
import { iconKey } from "../shared/icons.ts";

// Playwright is a dev tool, not a dependency: use whichever one is installed on the machine.
const { chromium } = createRequire(import.meta.url)("playwright");

const OUT = "icons-out";
const MAP = "shared/icons.json";
const token = process.env.FILES_TOKEN;
const dry = process.env.DRY_RUN === "1";
if (!dry && !token) throw new Error("Set FILES_TOKEN, or DRY_RUN=1");

// A representative (hue, sat, lum) for every colour name: average over the samples that get the name.
const buckets = new Map();
for (let hue = 0; hue < 360; hue += 2)
  for (const sat of [38, 50, 65, 80, 92])
    for (let lum = 22; lum <= 78; lum += 4) {
      const name = colorName({ hue, sat, lum });
      const b = buckets.get(name) ?? { x: 0, y: 0, sat: 0, lum: 0, n: 0 };
      b.x += Math.cos((hue * Math.PI) / 180); b.y += Math.sin((hue * Math.PI) / 180);
      b.sat += sat; b.lum += lum; b.n++;
      buckets.set(name, b);
    }
const colours = [...buckets].map(([name, b]) => ({
  name,
  hue: Math.round(((Math.atan2(b.y, b.x) * 180) / Math.PI + 360) % 360),
  sat: Math.round(b.sat / b.n),
  lum: Math.round(b.lum / b.n),
}));
// Make sure each representative really maps back to its own name.
for (const c of colours) {
  if (colorName(c) !== c.name) {
    // fall back to the first sample with that name
    outer: for (let hue = 0; hue < 360; hue += 2) for (const sat of [92, 80, 65, 50, 38]) for (let lum = 50; lum <= 78; lum += 4)
      if (colorName({ hue, sat, lum }) === c.name) { Object.assign(c, { hue, sat, lum }); break outer; }
    if (colorName(c) !== c.name) for (let lum = 22; lum <= 40; lum += 2) if (colorName({ ...c, lum }) === c.name) { c.lum = lum; break; }
  }
}

mkdirSync(OUT, { recursive: true });
const map = existsSync(MAP) ? JSON.parse(readFileSync(MAP, "utf8")) : {};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
let made = 0;
for (let shape = 0; shape < SHAPES.length; shape++) {
  for (const c of colours) {
    const g = {
      hue: c.hue, hue2: (c.hue + 40) % 360, sat: c.sat, lum: c.lum, petals: shape === 6 ? 8 : 6, shape,
      layers: shape === 5 ? 2 : 1, pattern: 0, center: 0, centerHue: 48, stem: 0.35, leaves: 2, curl: 0.1,
      glow: false, iridescent: false,
    };
    const key = iconKey(g);
    if (map[key] && !process.env.FORCE) continue;
    const svg = renderFlower(g, { uid: "i", background: "#f4ecdc" });
    await page.setContent(`<body style="margin:0;background:#f4ecdc;display:grid;place-items:center;width:256px;height:256px">` +
      `<div style="width:256px;height:256px">${svg.replace('viewBox="0 0 200 220"', 'viewBox="25 38 150 150"').replace("<svg ", '<svg width="256" height="256" ')}</div></body>`);
    const file = `${OUT}/${key}.png`;
    await page.screenshot({ path: file });
    made++;
    if (!dry) {
      map[key] = await upload(file, `pollen-${key}.png`);
      writeFileSync(MAP, JSON.stringify(map, null, 2) + "\n");
    }
  }
}
await browser.close();
console.log(`${made} icons rendered${dry ? " (dry run)" : `, ${Object.keys(map).length} in ${MAP}`}`);

async function upload(file, name) {
  const data = readFileSync(file);
  const r = await fetch("https://api.files.serble.net/files", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: name, fileSize: data.length, expirationHours: null }),
  });
  if (!r.ok) throw new Error(`create ${r.status} ${await r.text()}`);
  const { file: meta, uploadUrl, uploadFields } = await r.json();
  const form = new FormData();
  for (const [k, v] of Object.entries(uploadFields)) form.append(k, v);
  form.append("file", new Blob([data], { type: "image/png" }), name);
  const up = await fetch(uploadUrl, { method: "POST", body: form });
  if (!up.ok) throw new Error(`upload ${up.status} ${await up.text()}`);
  return `https://api.files.serble.net/files/${meta.id}`;
}
