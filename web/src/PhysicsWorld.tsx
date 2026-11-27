// The world view (#20): a side-on 2D garden with real physics (planck.js, a port of Box2D).
// Seeds are bodies in a sack; drop one into a hole to plant it. The watering can and fertiliser
// sack pour droplets and granules; plants they land on are watered or fertilised. Pull a blooming
// flower up to harvest it. Everything else falls, rolls, bounces and stacks.
import { useEffect, useRef, useState } from "react";
import { World, Vec2, Box, Circle, Chain, Polygon, MouseJoint, AABB, type Body, type Fixture } from "planck";
import { api, useApi, useToast, notifyChanged, useOnChanged, Link, fmtDuration, useSession, Coins, toConsent } from "./lib";
import { renderFlower, type Genome } from "../../shared/genome";
import { BloomDetail } from "./BloomDetail";
import type { Bloom } from "./blooms";

// ---------------------------------------------------------------- layout (metres, y up)
const WORLD_W = 70;
const TABLE = { x0: 2, x1: 8.5, top: 2.4 };
const SACK = { x0: 3.3, x1: 5.9, bottom: TABLE.top + 0.05, top: TABLE.top + 1.8 };
const HOLE_W = 0.7, HOLE_D = 0.55;
const holeX = (slot: number) => 15 + slot * 3.6;
const GREENHOUSE = { x0: 40, x1: 64, shelves: [1.4, 2.8], roof: 4.2 };
const BIN = { x: 37.6, w: 1.0, h: 1.0 };
const VASE_STEP = 0.62;
const AREAS = [
  { key: "table", label: "Potting table", x: (TABLE.x0 + TABLE.x1) / 2 + 1 },
  { key: "garden", label: "Garden", x: holeX(2.5) },
  { key: "greenhouse", label: "Greenhouse", x: GREENHOUSE.x0 + 7 },
] as const;
const SEED_R = 0.14;
const OUT_OF_SACK_MS = 10 * 60_000;

interface Plant {
  genome: Genome | null; hint: { hue: number; sat: number; lum: number; stem?: number; curl?: number; leaves?: number; leafTone?: number };
  stage: string; readyAt: number; growMs: number; waters: number; canWaterAt: number | null; origin: string; generation: number;
}
interface Seed { id: string; origin: string; generation: number; hint: { hue: number; sat: number; lum: number } }
interface GardenData {
  plots: { slot: number; plant: Plant | null }[]; seeds: Seed[];
  freeSeeds: { available: number; nextAt: number | null }; serverNow?: number; fertiliser?: number; fertiliseCost?: number;
}
type Tag =
  | { kind: "ground" } | { kind: "seed"; id: string; color: string; outSince?: number }
  | { kind: "can" } | { kind: "sackTool" } | { kind: "drop"; born: number; tool: "water" | "fert" | "pollen" }
  | { kind: "plantSensor"; slot: number } | { kind: "bloom"; genome: Genome; born: number }
  | { kind: "vase"; id: string; genome: Genome; composting?: boolean };

const placeholder = (h: Plant["hint"]): Genome => ({
  hue: h.hue, hue2: h.leafTone ?? h.hue, sat: h.sat, lum: h.lum, petals: 5, shape: 0, layers: 1, pattern: 0, center: 0,
  centerHue: 50, stem: h.stem ?? 0.5, leaves: h.leaves ?? 2, curl: h.curl ?? 0, glow: false, iridescent: false,
});
const seedColor = (s: Seed) => s.origin === "wild" ? "#a9875f" : `hsl(${s.hint.hue} ${Math.min(s.hint.sat, 70)}% ${Math.max(35, Math.min(s.hint.lum, 65))}%)`;

// flower images, cached by genome and growth (1% steps)
const imgCache = new Map<string, HTMLImageElement>();
function flowerImage(g: Genome, progress: number): HTMLImageElement {
  const p = Math.round(Math.min(1, progress) * 100) / 100;
  const key = JSON.stringify(g) + p;
  let img = imgCache.get(key);
  if (!img) {
    img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(renderFlower(g, { progress: p >= 1 ? undefined : p, uid: "w" }));
    imgCache.set(key, img);
    if (imgCache.size > 400) imgCache.delete(imgCache.keys().next().value!);
  }
  return img;
}

export default function PhysicsWorld() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { data, reload, setData } = useApi<GardenData>("/api/garden");
  useOnChanged("garden", reload);
  const toast = useToast();
  const { config, refreshBalance } = useSession();
  const dataRef = useRef<GardenData | null>(null);
  dataRef.current = data;
  const skew = useRef(0);
  useEffect(() => { if (data?.serverNow) skew.current = Date.now() - data.serverNow; }, [data?.serverNow]);
  const [area, setArea] = useState("garden");
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const engine = useRef<ReturnType<typeof createEngine> | null>(null);
  const { data: vase, reload: reloadVase } = useApi<{ blooms: Bloom[]; compostYield: Record<string, number> }>("/api/vase");
  useOnChanged("vase", reloadVase);
  const vaseRef = useRef<Bloom[]>([]);
  vaseRef.current = vase?.blooms.filter((b) => b.state === "vase") ?? [];
  const [open, setOpen] = useState<Bloom | null>(null);

  // the physics world lives for the lifetime of the page
  useEffect(() => {
    const e = createEngine(canvas.current!, {
      plant: async (seedId, slot) => {
        setData((d) => d && { ...d, seeds: d.seeds.filter((s) => s.id !== seedId) });
        try { await api("/api/plant", { seedId, slot }); } catch (err) { toast((err as Error).message, true); }
        reload();
      },
      water: async (slot) => { try { await api("/api/water", { slot }); } catch { /* cooldown: the server is the judge */ } reload(); },
      fertilise: async (slot) => {
        try { await api("/api/fertilise", { slot }); toast("Fertilised: it's growing faster."); } catch (err) { toast((err as Error).message, true); }
        reload();
      },
      harvest: async (slot, genome) => {
        try {
          const r = await api<{ species: string; rarity: string; discovered: boolean }>("/api/harvest", { slot });
          toast(`${r.rarity} ${r.species}${r.discovered ? " (a new species!)" : ""}, off to your greenhouse.`);
          notifyChanged("vase");
          e.spawnBloom(slot, genome);
        } catch (err) { toast((err as Error).message, true); }
        reload();
      },
      tapVase: (id) => { const b = vaseRef.current.find((x) => x.id === id); if (b) setOpen(b); },
      pollinate: async (a, b) => {
        try {
          await api("/api/pollinate", { a, b });
          toast("Pollen flies! A hybrid seed drops into your sack.");
          notifyChanged("garden"); reloadVase(); reload();
          return true;
        } catch (err) { toast((err as Error).message, true); return false; }
      },
      compostVase: async (id) => {
        const b = vaseRef.current.find((x) => x.id === id);
        if (!b) return false;
        if (!confirm(`Compost your ${b.rarity} ${b.species}? This can't be undone.`)) return false;
        try {
          const r = await api<{ gained: number }>("/api/compost-blooms", { bloomIds: [id] });
          toast(`Composted into ${r.gained} fertiliser.`); reloadVase(); reload(); return true;
        } catch (err) { toast((err as Error).message, true); return false; }
      },
      data: () => dataRef.current,
      now: () => Date.now() - skew.current,
      onArea: setArea,
      onTip: setTip,
      toast,
    });
    engine.current = e;
    return () => e.destroy();
  }, []);

  // refresh periodically, and right when a plant finishes growing
  useEffect(() => {
    const t = setInterval(reload, 30_000);
    const vis = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [reload]);
  useEffect(() => {
    if (!data) return;
    const next = Math.min(...data.plots.map((p) => p.plant && p.plant.stage !== "bloom" ? p.plant.readyAt - (Date.now() - skew.current) : Infinity));
    if (!isFinite(next)) return;
    const t = setTimeout(reload, Math.max(500, next + 300));
    return () => clearTimeout(t);
  }, [data, reload]);

  // keep vase bodies in step with the collection
  useEffect(() => { if (vase) engine.current?.syncVases(vase.blooms.filter((b) => b.state === "vase")); }, [vase]);

  // keep seed bodies in step with the pouch
  useEffect(() => { if (data) engine.current?.syncSeeds(data.seeds); }, [data]);

  const claim = async () => {
    try { const r = await api<{ claimed: number }>("/api/seeds/claim", {}); toast(`${r.claimed} seed${r.claimed > 1 ? "s" : ""} tumble into your sack.`); reload(); }
    catch (err) { toast((err as Error).message, true); }
  };
  const buy = async () => {
    try { const r = await api<{ consentUrl: string }>("/api/shop/packet", {}); toConsent(r.consentUrl); }
    catch (err) { toast((err as Error).message, true); }
  };
  useEffect(() => { refreshBalance(); }, []);

  return <div className="world-shell">
    <div className="world-bar">
      <div className="tabs" role="tablist" aria-label="Areas">
        {AREAS.map((a) => <button key={a.key} role="tab" aria-selected={area === a.key} className={area === a.key ? "on" : ""} onClick={() => engine.current?.goTo(a.x)}>{a.label}</button>)}
      </div>
      <span className="spacer" />
      {data && <>
        <button className="btn small accent" disabled={!data.freeSeeds.available} onClick={claim}>
          {data.freeSeeds.available ? `Gather ${data.freeSeeds.available} free seed${data.freeSeeds.available > 1 ? "s" : ""}` : data.freeSeeds.nextAt ? `Free seeds in ${fmtDuration(data.freeSeeds.nextAt - Date.now())}` : "No free seeds"}
        </button>
        <button className="btn small" onClick={buy}>Packet <Coins n={config?.prices.packet.coins ?? "?"} /></button>
        <span className="pill" title="Fertiliser: hold the sack over a growing plant">🌱 {data.fertiliser ?? 0}</span>
      </>}
      <Link to="/garden" className="linkish faint">Classic view</Link>
    </div>
    <div className="world-viewport physics">
      <canvas ref={canvas} aria-label="Your garden. Drag seeds into holes, hold the watering can over plants, pull blooming flowers up to harvest." />
      {tip && <div className="world-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
      <div className="world-help faint">Drag seeds from the sack into a hole · hold the can over plants · pull a bloom up to harvest · in the greenhouse, tap a vase for details, drop one vase onto another to cross-pollinate, drop it in the bin to compost · drag empty space to look around</div>
    </div>
    {open && <BloomDetail bloom={open} all={vaseRef.current} compostYield={vase?.compostYield ?? {}} onClose={() => setOpen(null)} onChanged={() => { reloadVase(); reload(); }} />}
  </div>;
}

// ---------------------------------------------------------------- engine

interface Hooks {
  tapVase: (id: string) => void;
  pollinate: (a: string, b: string) => Promise<boolean>;
  compostVase: (id: string) => Promise<boolean>;
  plant: (seedId: string, slot: number) => void;
  water: (slot: number) => void;
  fertilise: (slot: number) => void;
  harvest: (slot: number, genome: Genome) => void;
  data: () => GardenData | null;
  now: () => number;
  onArea: (key: string) => void;
  onTip: (t: { x: number; y: number; text: string } | null) => void;
  toast: (t: string, bad?: boolean) => void;
}

function createEngine(cv: HTMLCanvasElement, hooks: Hooks) {
  const ctx = cv.getContext("2d")!;
  const world = new World({ gravity: new Vec2(0, -12) });
  const tagOf = (b: Body) => b.getUserData() as Tag;
  const cam = { x: AREAS[1].x, y: 2.6, z: 60 };   // centre in metres, pixels per metre
  let W = 0, H = 0, dpr = 1;
  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    const r = cv.parentElement!.getBoundingClientRect();
    W = r.width; H = r.height;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    cam.z = Math.max(28, Math.min(80, W / 16));
    cam.y = Math.max(1.5, 0.3 * H / cam.z);   // ground sits about 20% up from the bottom
  };
  resize();
  const toScreen = (x: number, y: number) => ({ x: (x - cam.x) * cam.z + W / 2, y: H / 2 - (y - cam.y) * cam.z });
  const toWorld = (sx: number, sy: number) => new Vec2((sx - W / 2) / cam.z + cam.x, (H / 2 - sy) / cam.z + cam.y);

  // ground with six holes, the potting table and the sack
  const ground = world.createBody({ userData: { kind: "ground" } as Tag });
  const profile: Vec2[] = [new Vec2(-2, 0)];
  for (let s = 0; s < 6; s++) {
    const cx = holeX(s);
    profile.push(new Vec2(cx - HOLE_W / 2, 0), new Vec2(cx - HOLE_W / 2 + 0.05, -HOLE_D), new Vec2(cx + HOLE_W / 2 - 0.05, -HOLE_D), new Vec2(cx + HOLE_W / 2, 0));
  }
  profile.push(new Vec2(WORLD_W + 2, 0));
  ground.createFixture(new Chain(profile), { friction: 0.8 });
  ground.createFixture(new Box((TABLE.x1 - TABLE.x0) / 2, 0.08, new Vec2((TABLE.x0 + TABLE.x1) / 2, TABLE.top), 0), { friction: 0.7 });
  ground.createFixture(new Chain([new Vec2(SACK.x0 - 0.2, SACK.top), new Vec2(SACK.x0, SACK.bottom + 0.1), new Vec2(SACK.x0 + 0.2, SACK.bottom),
    new Vec2(SACK.x1 - 0.2, SACK.bottom), new Vec2(SACK.x1, SACK.bottom + 0.1), new Vec2(SACK.x1 + 0.2, SACK.top)]), { friction: 0.6 });
  // greenhouse: two shelves above the floor, walls at either end
  for (const y of GREENHOUSE.shelves) ground.createFixture(new Box((GREENHOUSE.x1 - GREENHOUSE.x0) / 2 - 0.4, 0.06, new Vec2((GREENHOUSE.x0 + GREENHOUSE.x1) / 2, y), 0), { friction: 0.8 });
  ground.createFixture(new Box(0.08, GREENHOUSE.roof / 2, new Vec2(GREENHOUSE.x1, GREENHOUSE.roof / 2), 0));
  // the compost bin by the greenhouse door
  ground.createFixture(new Chain([new Vec2(BIN.x - BIN.w / 2 - 0.08, BIN.h), new Vec2(BIN.x - BIN.w / 2, 0.02), new Vec2(BIN.x + BIN.w / 2, 0.02), new Vec2(BIN.x + BIN.w / 2 + 0.08, BIN.h)]), { friction: 0.6 });
  // plug for occupied holes, so seeds roll over planted plots
  const plugs = new Map<number, Fixture>();
  // sensors where droplets and granules land on plants
  const sensors = world.createBody({ userData: { kind: "ground" } as Tag });
  for (let s = 0; s < 6; s++) {
    const f = sensors.createFixture(new Box(0.8, 1.6, new Vec2(holeX(s), 1.4), 0), { isSensor: true });
    f.setUserData({ kind: "plantSensor", slot: s } as Tag);
  }

  // tools
  const can = world.createDynamicBody({ position: new Vec2(11.2, 0.4), userData: { kind: "can" } as Tag, angularDamping: 2 });
  can.createFixture(new Box(0.42, 0.32), { density: 1, friction: 0.6, restitution: 0.1 });
  const fertSack = world.createDynamicBody({ position: new Vec2(12.6, 0.4), userData: { kind: "sackTool" } as Tag, angularDamping: 2 });
  fertSack.createFixture(new Polygon([new Vec2(-0.32, -0.38), new Vec2(0.32, -0.38), new Vec2(0.24, 0.38), new Vec2(-0.24, 0.38)]), { density: 1.2, friction: 0.8 });

  // seeds
  const seeds = new Map<string, Body>();
  const inSack = (p: Vec2) => p.x > SACK.x0 - 0.1 && p.x < SACK.x1 + 0.1 && p.y > SACK.bottom - 0.2 && p.y < SACK.top + 0.4;
  const spawnSeed = (s: Seed, i: number) => {
    const b = world.createDynamicBody({
      position: new Vec2(SACK.x0 + 0.4 + (i % 7) * 0.28, SACK.top + 0.3 + Math.floor(i / 7) * 0.3), bullet: true,
      userData: { kind: "seed", id: s.id, color: seedColor(s) } as Tag, linearDamping: 0.05,
    });
    b.createFixture(new Circle(SEED_R), { density: 2, friction: 0.5, restitution: 0.35 });
    seeds.set(s.id, b);
  };
  const syncSeeds = (list: Seed[]) => {
    const want = new Set(list.map((s) => s.id));
    for (const [id, b] of seeds) if (!want.has(id)) { world.destroyBody(b); seeds.delete(id); }
    list.forEach((s, i) => { if (!seeds.has(s.id)) spawnSeed(s, i); });
  };


  // ---------------------------------------------------------------- vases in the greenhouse
  const vases = new Map<string, Body>();
  const LAYOUT_KEY = "pollen.world.vases";
  const loadLayout = (): Record<string, [number, number]> => { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"); } catch { return {}; } };
  const saveLayout = () => {
    const out: Record<string, [number, number]> = {};
    for (const [id, b] of vases) out[id] = [Math.round(b.getPosition().x * 100) / 100, Math.round(b.getPosition().y * 100) / 100];
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(out)); } catch { /* storage unavailable */ }
  };
  const freeSpot = (i: number): Vec2 => {
    const perRow = Math.floor((GREENHOUSE.x1 - GREENHOUSE.x0 - 1.4) / VASE_STEP);
    const rows = [0, ...GREENHOUSE.shelves];
    const row = rows[Math.min(rows.length - 1, Math.floor(i / perRow))];
    return new Vec2(GREENHOUSE.x0 + 0.9 + (i % perRow) * VASE_STEP, row + 0.4 + Math.floor(i / (perRow * rows.length)) * 0.6);
  };
  const syncVases = (list: Bloom[]) => {
    const want = new Set(list.map((b) => b.id));
    for (const [id, b] of vases) if (!want.has(id)) { world.destroyBody(b); vases.delete(id); }
    const layout = loadLayout();
    let i = 0;
    for (const bl of list) {
      if (vases.has(bl.id)) continue;
      const saved = layout[bl.id];
      const pos = saved ? new Vec2(saved[0], saved[1] + 0.05) : freeSpot(vases.size + i++);
      const b = world.createDynamicBody({ position: pos, userData: { kind: "vase", id: bl.id, genome: bl.genome } as Tag, angularDamping: 3 });
      b.createFixture(new Polygon([new Vec2(-0.18, -0.25), new Vec2(0.18, -0.25), new Vec2(0.22, 0.25), new Vec2(-0.22, 0.25)]), { density: 1.5, friction: 0.7, restitution: 0.05 });
      vases.set(bl.id, b);
    }
  };

  // ---------------------------------------------------------------- input
  let joint: MouseJoint | null = null;
  let held: Body | null = null;
  let panning: { sx: number; sy: number; cx: number; cy: number } | null = null;
  let pulling: { slot: number; startY: number; genome: Genome } | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  let pourHits = new Set<number>();
  let holdStart: { at: number; p: Vec2 } | null = null;

  const plantAt = (wp: Vec2) => {
    const d = hooks.data();
    if (!d) return null;
    for (const { slot, plant } of d.plots) {
      if (!plant) continue;
      const progress = plantProgress(plant);
      const h = 0.6 + 2.6 * Math.min(1, progress);
      if (Math.abs(wp.x - holeX(slot)) < 0.9 && wp.y > -0.2 && wp.y < h) return { slot, plant, progress };
    }
    return null;
  };
  // Ready as soon as its time is up (the server double-checks on harvest).
  const plantProgress = (p: Plant) => p.stage === "bloom" || p.readyAt <= hooks.now() ? 1 : Math.max(0, Math.min(0.999, 1 - (p.readyAt - hooks.now()) / p.growMs));
  const bodyAt = (wp: Vec2): Body | null => {
    let found: Body | null = null;
    world.queryAABB(new AABB(new Vec2(wp.x - 0.05, wp.y - 0.05), new Vec2(wp.x + 0.05, wp.y + 0.05)), (f: Fixture) => {
      const b = f.getBody();
      if (b.isDynamic() && !f.isSensor() && f.testPoint(wp)) { found = b; return false; }
      return true;
    });
    if (found) return found;
    // be forgiving with small seeds and fingers: nearest seed within 0.35 m
    let best = 0.35;
    for (const b of seeds.values()) { const dd = Vec2.distance(b.getPosition(), wp); if (dd < best) { best = dd; found = b; } }
    return found;
  };
  const local = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  const down = (e: PointerEvent) => {
    cv.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); releaseHeld(); panning = null; return; }
    const wp = toWorld(p.x, p.y);
    const body = bodyAt(wp);
    if (body) {
      held = body;
      holdStart = { at: performance.now(), p: wp };
      joint = world.createJoint(new MouseJoint({ maxForce: 600 * body.getMass() + 50, frequencyHz: 6, dampingRatio: 0.8 }, ground, body, wp)) as MouseJoint;
      body.setAwake(true);
      pourHits = new Set();
      const t = tagOf(body);
      if (t.kind === "seed") t.outSince = t.outSince ?? Date.now();
      cv.style.cursor = "grabbing";
      return;
    }
    const pl = plantAt(wp);
    if (pl && pl.progress >= 1 && pl.plant.genome) { pulling = { slot: pl.slot, startY: wp.y, genome: pl.plant.genome }; return; }
    panning = { sx: p.x, sy: p.y, cx: cam.x, cy: cam.y };
  };
  const move = (e: PointerEvent) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoomAt(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = d;
      return;
    }
    const wp = toWorld(p.x, p.y);
    if (joint) { joint.setTarget(wp); return; }
    if (pulling) {
      if (wp.y - pulling.startY > 0.5) { const { slot, genome } = pulling; pulling = null; hooks.harvest(slot, genome); }
      return;
    }
    if (panning) {
      cam.x = clampX(panning.cx - (p.x - panning.sx) / cam.z);
      cam.y = Math.max(1.5, Math.min(6, panning.cy + (p.y - panning.sy) / cam.z));
      return;
    }
    // hover tips
    const pl = plantAt(wp);
    if (pl && e.pointerType === "mouse") {
      const text = pl.progress >= 1 ? "In bloom! Pull it up to harvest."
        : `${pl.progress < 0.2 ? "Germinating" : pl.progress < 0.6 ? "Sprouting" : "Budding"} · ${fmtDuration(pl.plant.readyAt - hooks.now())}`;
      hooks.onTip({ x: p.x + 14, y: p.y - 10, text });
      cv.style.cursor = pl.progress >= 1 ? "grab" : "default";
    } else {
      hooks.onTip(null);
      cv.style.cursor = bodyAt(wp) ? "grab" : "default";
    }
  };
  const releaseHeld = () => {
    if (joint) world.destroyJoint(joint);
    joint = null; held = null; cv.style.cursor = "default";
  };
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    const b = held, start = holdStart;
    const tag = b ? tagOf(b) : null;
    if (b && tag?.kind === "vase" && start) {
      const p = local(e), wp = toWorld(p.x, p.y);
      if (performance.now() - start.at < 350 && Vec2.distance(wp, start.p) < 0.15) { releaseHeld(); hooks.tapVase(tag.id); panning = null; pulling = null; return; }
      // dropped onto another vase: cross-pollinate
      let other: string | null = null, best = 0.6;
      for (const [id, v] of vases) if (v !== b) { const d = Vec2.distance(v.getPosition(), b.getPosition()); if (d < best) { best = d; other = id; } }
      if (other) {
        burst(b.getPosition());
        hooks.pollinate(tag.id, other);
        b.setLinearVelocity(new Vec2(-1.5, 3));   // hop off, so they don't stay stuck together
      }
      setTimeout(saveLayout, 1500);
    }
    holdStart = null;
    releaseHeld(); panning = null; pulling = null;
  };
  const clampX = (x: number) => Math.max(0, Math.min(WORLD_W, x));
  const zoomAt = (f: number, sx: number, sy: number) => {
    const before = toWorld(sx, sy);
    cam.z = Math.max(20, Math.min(140, cam.z * f));
    const after = toWorld(sx, sy);
    cam.x = clampX(cam.x + before.x - after.x);
    cam.y = Math.max(1.5, Math.min(6, cam.y + before.y - after.y));
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e as unknown as PointerEvent);
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0022), p.x, p.y);
    else cam.x = clampX(cam.x + (e.deltaX || e.deltaY) / cam.z);
  };
  cv.addEventListener("pointerdown", down);
  cv.addEventListener("pointermove", move);
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("pointerleave", () => hooks.onTip(null));
  cv.addEventListener("wheel", wheel, { passive: false });
  addEventListener("resize", resize);

  let glideTo: number | null = null;
  const goTo = (x: number) => { glideTo = x; };

  // ---------------------------------------------------------------- pouring
  const tipOf = (b: Body) => b.getWorldPoint(new Vec2(tagOf(b).kind === "can" ? 0.62 : 0, tagOf(b).kind === "can" ? 0.28 : 0.42));
  let lastDrop = 0;
  const pour = (b: Body, tool: "water" | "fert", now: number) => {
    // tilt the held tool towards pouring
    const target = tool === "water" ? -0.75 : Math.PI * 0.8;
    b.setAngularVelocity((target - b.getAngle()) * 6);
    if (now - lastDrop < (tool === "water" ? 40 : 90)) return;
    lastDrop = now;
    const from = tipOf(b);
    const d = world.createDynamicBody({ position: from, bullet: true, userData: { kind: "drop", born: now, tool } as Tag });
    d.createFixture(new Circle(tool === "water" ? 0.05 : 0.04), { density: 0.5, filterGroupIndex: -1, restitution: 0.1 });
    d.setLinearVelocity(new Vec2((Math.random() - 0.3) * 1.2, -1));
  };
  world.on("begin-contact", (c) => {
    const fa = c.getFixtureA(), fb = c.getFixtureB();
    const pairs: [Fixture, Fixture][] = [[fa, fb], [fb, fa]];
    for (const [sensor, other] of pairs) {
      const st = sensor.getUserData() as Tag | null;
      const ot = tagOf(other.getBody());
      if (st?.kind === "plantSensor" && ot?.kind === "drop") {
        const slot = st.slot;
        const d = hooks.data();
        const plant = d?.plots[slot]?.plant;
        if (!plant || plant.stage === "bloom" || pourHits.has(slot)) continue;
        if (ot.tool === "pollen") continue;
        if (ot.tool === "water") {
          if (plant.canWaterAt === null || plant.canWaterAt > hooks.now()) continue;
          pourHits.add(slot); hooks.water(slot);
        } else {
          if ((d?.fertiliser ?? 0) < (d?.fertiliseCost ?? 3)) continue;
          pourHits.add(slot); hooks.fertilise(slot);
        }
      }
    }
  });

  const burst = (at: Vec2) => {
    const now = performance.now();
    for (let i = 0; i < 18; i++) {
      const d = world.createDynamicBody({ position: new Vec2(at.x, at.y + 0.6), bullet: true, gravityScale: 0.25, userData: { kind: "drop", born: now, tool: "pollen" } as Tag });
      d.createFixture(new Circle(0.035), { density: 0.2, filterGroupIndex: -1, isSensor: true });
      const a = (i / 18) * Math.PI * 2;
      d.setLinearVelocity(new Vec2(Math.cos(a) * 2.2, Math.sin(a) * 2.2 + 1));
    }
  };

  // ---------------------------------------------------------------- loop
  let raf = 0, last = performance.now(), acc = 0;
  const bloomsInFlight: Body[] = [];
  const spawnBloom = (slot: number, g: Genome) => {
    const b = world.createDynamicBody({ position: new Vec2(holeX(slot), 2.4), userData: { kind: "bloom", genome: g, born: performance.now() } as Tag, angularDamping: 1 });
    b.createFixture(new Box(0.5, 0.5), { density: 0.4, restitution: 0.4, friction: 0.6 });
    b.setLinearVelocity(new Vec2(3 + Math.random() * 2, 7));
    b.setAngularVelocity(-2);
    bloomsInFlight.push(b);
  };
  const frame = (t: number) => {
    const dt = Math.min(0.05, (t - last) / 1000); last = t; acc += dt;
    const now = performance.now();
    if (held) {
      const k = tagOf(held).kind;
      if (k === "can") pour(held, "water", now);
      else if (k === "sackTool" && (hooks.data()?.fertiliser ?? 0) >= (hooks.data()?.fertiliseCost ?? 3)) pour(held, "fert", now);
    }
    while (acc >= 1 / 60) { world.step(1 / 60); acc -= 1 / 60; }
    // seeds: plant when one settles into an empty hole; send strays home after a while
    const d = hooks.data();
    for (const [id, b] of seeds) {
      const p = b.getPosition(), tag = tagOf(b) as Extract<Tag, { kind: "seed" }>;
      if (p.y < -HOLE_D * 0.4 && d) {
        for (let s = 0; s < 6; s++) {
          if (Math.abs(p.x - holeX(s)) < HOLE_W / 2 && !d.plots[s]?.plant && b !== held) {
            world.destroyBody(b); seeds.delete(id); hooks.plant(id, s); break;
          }
        }
      }
      if (inSack(p)) tag.outSince = undefined;
      else if (b !== held) {
        tag.outSince = tag.outSince ?? Date.now();
        if (Date.now() - tag.outSince > OUT_OF_SACK_MS || p.y < -5 || p.x < -3 || p.x > WORLD_W + 3) {
          b.setPosition(new Vec2((SACK.x0 + SACK.x1) / 2, SACK.top + 0.5)); b.setLinearVelocity(new Vec2(0, 0)); tag.outSince = undefined;
        }
      }
    }
    // a vase dropped in the compost bin
    for (const [, v] of vases) {
      const t = tagOf(v) as Extract<Tag, { kind: "vase" }>;
      const p = v.getPosition();
      if (v !== held && !t.composting && Math.abs(p.x - BIN.x) < BIN.w / 2 && p.y < BIN.h - 0.1) {
        t.composting = true;
        hooks.compostVase(t.id).then((ok) => {
          if (!ok && vases.get(t.id) === v) { v.setPosition(new Vec2(BIN.x + 1.4, 0.6)); v.setLinearVelocity(new Vec2(1.5, 2)); t.composting = false; }
        });
      }
    }
    // occupied holes get a plug so seeds roll over them
    if (d) for (let s = 0; s < 6; s++) {
      const occupied = !!d.plots[s]?.plant;
      if (occupied && !plugs.has(s)) plugs.set(s, ground.createFixture(new Box(HOLE_W / 2, 0.05, new Vec2(holeX(s), -0.02), 0)));
      if (!occupied && plugs.has(s)) { ground.destroyFixture(plugs.get(s)!); plugs.delete(s); }
    }
    // tidy up drops and harvested blooms; keep tools in the world
    for (let b = world.getBodyList(); b; ) {
      const next = b.getNext(); const tg = tagOf(b);
      if (tg?.kind === "drop" && (now - tg.born > 1600 || b.getPosition().y < -1)) world.destroyBody(b);
      if (tg?.kind === "bloom" && now - tg.born > 4000) world.destroyBody(b);
      if ((tg?.kind === "can" || tg?.kind === "sackTool") && (b.getPosition().y < -5 || b.getPosition().x < -3 || b.getPosition().x > WORLD_W + 3)) {
        b.setPosition(new Vec2(tg.kind === "can" ? 11.2 : 12.6, 1)); b.setLinearVelocity(new Vec2(0, 0));
      }
      b = next;
    }
    if (glideTo !== null) { cam.x += (glideTo - cam.x) * 0.12; if (Math.abs(glideTo - cam.x) < 0.02) glideTo = null; }
    const centre = AREAS.reduce((a, b) => Math.abs(b.x - cam.x) < Math.abs(a.x - cam.x) ? b : a);
    hooks.onArea(centre.key);
    draw(now);
    raf = requestAnimationFrame(frame);
  };

  // ---------------------------------------------------------------- drawing
  const draw = (now: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    const cs = getComputedStyle(cv);
    sky.addColorStop(0, cs.getPropertyValue("--sky-top") || "#cfe6f3");
    sky.addColorStop(1, cs.getPropertyValue("--sky-bottom") || "#eef5e6");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    // sun and drifting clouds, far away (slow parallax)
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    ctx.fillStyle = dark ? "rgba(240,235,200,.55)" : "rgba(255,226,140,.9)";
    ctx.beginPath(); ctx.arc(W * 0.82 - cam.x * 2, H * 0.16, 34, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = dark ? "rgba(200,210,220,.12)" : "rgba(255,255,255,.8)";
    for (let i = 0; i < 9; i++) {
      const span = W + 400;
      const cx = (((i * 337 + now * 0.004 * (1 + (i % 3) * 0.3) - cam.x * cam.z * 0.15) % span) + span) % span - 200;
      const cy = H * (0.08 + ((i * 53) % 40) / 100);
      for (const [dx, dy, r] of [[0, 0, 26], [24, -10, 22], [48, 0, 24], [22, 8, 20]]) { ctx.beginPath(); ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2); ctx.fill(); }
    }
    // distant hills (parallax)
    ctx.fillStyle = cs.getPropertyValue("--grass-dark") || "#8fb36f";
    ctx.globalAlpha = 0.35; ctx.beginPath();
    const g0 = toScreen(0, 0).y;
    for (let x = -50; x <= W + 50; x += 20) { const wx = x / cam.z * 0.4 + cam.x * 0.6; ctx.lineTo(x, g0 - 40 - Math.sin(wx * 0.35) * 30 - Math.sin(wx * 0.9) * 12); }
    ctx.lineTo(W + 50, H); ctx.lineTo(-50, H); ctx.fill(); ctx.globalAlpha = 1;

    // greenhouse frame (behind)
    const ga = toScreen(GREENHOUSE.x0, 0), gb = toScreen(GREENHOUSE.x1, 0), gr = toScreen((GREENHOUSE.x0 + GREENHOUSE.x1) / 2, 5.5);
    ctx.fillStyle = cs.getPropertyValue("--glass") || "rgba(214,238,236,.35)";
    ctx.strokeStyle = cs.getPropertyValue("--frame") || "#9fb9b3"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(ga.x, ga.y); ctx.lineTo(ga.x, toScreen(0, GREENHOUSE.roof).y); ctx.lineTo(gr.x, gr.y); ctx.lineTo(gb.x, toScreen(0, GREENHOUSE.roof).y); ctx.lineTo(gb.x, gb.y); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.font = "600 15px Nunito, sans-serif"; ctx.fillStyle = cs.getPropertyValue("--ink-2") || "#4c5f53"; ctx.textAlign = "center";
    // shelves
    ctx.fillStyle = "#b98b5e";
    for (const y of GREENHOUSE.shelves) { const a = toScreen(GREENHOUSE.x0 + 0.4, y + 0.06); ctx.fillRect(a.x, a.y, (GREENHOUSE.x1 - GREENHOUSE.x0 - 0.8) * cam.z, 0.12 * cam.z); }
    // compost bin
    const b0 = toScreen(BIN.x - BIN.w / 2 - 0.08, BIN.h), b1 = toScreen(BIN.x + BIN.w / 2 + 0.08, BIN.h), bb = toScreen(BIN.x, 0);
    ctx.fillStyle = "#6f8f4e"; ctx.strokeStyle = "#3d5a2a"; ctx.lineWidth = 3; ctx.beginPath();
    ctx.moveTo(b0.x, b0.y); ctx.lineTo(bb.x - BIN.w / 2 * cam.z, bb.y); ctx.lineTo(bb.x + BIN.w / 2 * cam.z, bb.y); ctx.lineTo(b1.x, b1.y); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#d9e8c5"; ctx.font = `800 ${Math.max(9, cam.z * 0.18)}px Nunito, sans-serif`; ctx.fillText("COMPOST", bb.x, bb.y - BIN.h * cam.z * 0.45);

    // soil and grass with holes
    ctx.fillStyle = "#7a5236";
    ctx.beginPath();
    const first = toScreen(-60, 0); ctx.moveTo(first.x, first.y);
    for (let s = 0; s < 6; s++) {
      const cx = holeX(s);
      for (const [x, y] of [[cx - HOLE_W / 2, 0], [cx - HOLE_W / 2 + 0.05, -HOLE_D], [cx + HOLE_W / 2 - 0.05, -HOLE_D], [cx + HOLE_W / 2, 0]]) { const q = toScreen(x, y); ctx.lineTo(q.x, q.y); }
    }
    const end = toScreen(WORLD_W + 60, 0); ctx.lineTo(end.x, end.y); ctx.lineTo(end.x, H + 10); ctx.lineTo(first.x, H + 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#4a2f1d";
    for (let s = 0; s < 6; s++) {
      const cx = holeX(s); ctx.beginPath();
      for (const [x, y] of [[cx - HOLE_W / 2, 0], [cx - HOLE_W / 2 + 0.05, -HOLE_D], [cx + HOLE_W / 2 - 0.05, -HOLE_D], [cx + HOLE_W / 2, 0]]) { const q = toScreen(x, y); ctx.lineTo(q.x, q.y); }
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = "#6d9a4c"; ctx.lineWidth = Math.max(3, cam.z * 0.08); ctx.beginPath();
    let pen = toScreen(-60, 0); ctx.moveTo(pen.x, pen.y);
    for (let s = 0; s < 6; s++) { pen = toScreen(holeX(s) - HOLE_W / 2, 0); ctx.lineTo(pen.x, pen.y); pen = toScreen(holeX(s) + HOLE_W / 2, 0); ctx.moveTo(pen.x, pen.y); }
    pen = toScreen(WORLD_W + 60, 0); ctx.lineTo(pen.x, pen.y); ctx.stroke();

    // potting table and sack
    const tl = toScreen(TABLE.x0, TABLE.top), tr = toScreen(TABLE.x1, TABLE.top);
    ctx.fillStyle = "#b98b5e"; ctx.fillRect(tl.x, tl.y - 0.08 * cam.z, tr.x - tl.x, 0.16 * cam.z);
    ctx.fillStyle = "#8f6a45";
    for (const lx of [TABLE.x0 + 0.3, TABLE.x1 - 0.5]) { const l = toScreen(lx, TABLE.top - 0.08); ctx.fillRect(l.x, l.y, 0.2 * cam.z, (TABLE.top - 0.08) * cam.z); }
    ctx.fillStyle = "#d8c29a"; ctx.strokeStyle = "#a68a5c"; ctx.lineWidth = 2; ctx.beginPath();
    for (const [x, y] of [[SACK.x0 - 0.2, SACK.top], [SACK.x0, SACK.bottom + 0.1], [SACK.x0 + 0.2, SACK.bottom], [SACK.x1 - 0.2, SACK.bottom], [SACK.x1, SACK.bottom + 0.1], [SACK.x1 + 0.2, SACK.top]]) { const q = toScreen(x, y); ctx.lineTo(q.x, q.y); }
    ctx.fill(); ctx.stroke();
    const label = toScreen((SACK.x0 + SACK.x1) / 2, SACK.bottom + 0.35);
    ctx.fillStyle = "#7a5f36"; ctx.font = `700 ${Math.max(10, cam.z * 0.22)}px Nunito, sans-serif`; ctx.fillText("SEEDS", label.x, label.y);

    // plants (drawn so the SVG's ground line sits on the soil)
    const d = hooks.data();
    if (d) for (const { slot, plant } of d.plots) {
      if (!plant) continue;
      const pr = plantProgress(plant);
      const img = flowerImage(plant.genome ?? placeholder(plant.hint), pr);
      const wM = 3, hM = 3.3, groundFromTop = (196 / 220) * hM;
      const tlp = toScreen(holeX(slot) - wM / 2, groundFromTop);
      if (img.complete) ctx.drawImage(img, tlp.x, tlp.y, wM * cam.z, hM * cam.z);
      // soil mound over the hole
      const m = toScreen(holeX(slot), 0.02);
      ctx.fillStyle = "#6b4a33"; ctx.beginPath(); ctx.ellipse(m.x, m.y, 0.45 * cam.z, 0.09 * cam.z, 0, Math.PI, 0); ctx.fill();
    }

    // bodies
    for (let b = world.getBodyList(); b; b = b.getNext()) {
      const tg = tagOf(b);
      if (!tg || tg.kind === "ground") continue;
      const p = toScreen(b.getPosition().x, b.getPosition().y);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(-b.getAngle());
      const s = cam.z;
      if (tg.kind === "seed") {
        ctx.fillStyle = tg.color; ctx.beginPath(); ctx.ellipse(0, 0, SEED_R * s * 1.15, SEED_R * s * 0.85, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 1; ctx.stroke();
      } else if (tg.kind === "can") {
        ctx.fillStyle = "#5f9ea0"; ctx.strokeStyle = "#2f5f60"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(-0.42 * s, -0.32 * s, 0.84 * s, 0.64 * s, 0.1 * s); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0.4 * s, 0.05 * s); ctx.lineTo(0.66 * s, -0.28 * s); ctx.lineWidth = 0.1 * s; ctx.stroke();
        ctx.beginPath(); ctx.lineWidth = 0.07 * s; ctx.arc(-0.05 * s, -0.32 * s, 0.25 * s, Math.PI, 0); ctx.stroke();
      } else if (tg.kind === "sackTool") {
        ctx.fillStyle = "#b08a5a"; ctx.strokeStyle = "#6b4f2c"; ctx.lineWidth = 2; ctx.beginPath();
        ctx.moveTo(-0.32 * s, 0.38 * s); ctx.lineTo(0.32 * s, 0.38 * s); ctx.lineTo(0.24 * s, -0.38 * s); ctx.lineTo(-0.24 * s, -0.38 * s); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#5f9a4a"; ctx.beginPath(); ctx.arc(0, 0.05 * s, 0.1 * s, 0, Math.PI * 2); ctx.fill();
        const n = hooks.data()?.fertiliser ?? 0;
        ctx.rotate(b.getAngle()); ctx.fillStyle = "#1f3328"; ctx.font = `800 ${Math.max(10, 0.22 * s)}px Nunito, sans-serif`; ctx.fillText(String(n), 0, -0.5 * s);
      } else if (tg.kind === "drop") {
        ctx.fillStyle = tg.tool === "water" ? "rgba(111,183,217,.9)" : tg.tool === "pollen" ? "#f2c14e" : "#7a5c3a";
        ctx.beginPath(); ctx.arc(0, 0, (tg.tool === "water" ? 0.05 : 0.04) * s, 0, Math.PI * 2); ctx.fill();
      } else if (tg.kind === "vase") {
        // the flower, standing in the vase's mouth (the SVG's soil line sits at the rim)
        const img = flowerImage({ ...tg.genome, stem: 0.3, curl: 0.1 }, 1);
        const fw = 1.1 * s, fh = 1.21 * s;
        if (img.complete) ctx.drawImage(img, -fw / 2, -0.25 * s - fh * (196 / 220), fw, fh);
        ctx.fillStyle = "#c98a5f"; ctx.strokeStyle = "#8f5b3a"; ctx.lineWidth = 2; ctx.beginPath();
        ctx.moveTo(-0.22 * s, -0.25 * s); ctx.lineTo(0.22 * s, -0.25 * s); ctx.lineTo(0.18 * s, 0.25 * s); ctx.lineTo(-0.18 * s, 0.25 * s); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,.18)"; ctx.fillRect(-0.15 * s, -0.18 * s, 0.06 * s, 0.32 * s);
      } else if (tg.kind === "bloom") {
        const img = flowerImage(tg.genome, 1);
        if (img.complete) ctx.drawImage(img, -0.7 * s, -0.75 * s, 1.4 * s, 1.55 * s);
      }
      ctx.restore();
    }
  };
  raf = requestAnimationFrame(frame);
  // Read-only hook for browser tests, only when running locally.
  if (location.hostname === "localhost") (window as unknown as Record<string, unknown>).__pollenWorld = {
    toScreen, holeX, cam,
    seeds: () => [...seeds.entries()].map(([id, b]) => ({ id, x: b.getPosition().x, y: b.getPosition().y })),
    can: () => ({ x: can.getPosition().x, y: can.getPosition().y }),
    vases: () => [...vases.entries()].map(([id, b]) => ({ id, x: b.getPosition().x, y: b.getPosition().y })),
    bin: BIN,
  };

  return {
    syncSeeds, syncVases, goTo, spawnBloom,
    destroy() {
      cancelAnimationFrame(raf);
      cv.removeEventListener("pointerdown", down); cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up); cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("wheel", wheel); removeEventListener("resize", resize);
    },
  };
}
