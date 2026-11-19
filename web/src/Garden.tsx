import { useEffect, useState } from "react";
import { useDraggable, useDropTarget, useDragging, type Payload } from "./drag";
import { api, useApi, useAction, useNow, useSession, useToast, Flower, Coins, fmtDuration, hintColor, toConsent, Link, Modal } from "./lib";
import { RarityTag } from "./blooms";
import type { Genome, Stage } from "../../shared/genome";

interface Plant {
  genome: Genome | null; hint: { hue: number; sat: number; lum: number }; origin: string; generation: number;
  stage: Stage; progress: number; readyAt: number; growMs: number; waters: number; canWaterAt: number | null;
}
interface Seed { id: string; origin: string; generation: number; hint: { hue: number; sat: number; lum: number } }
interface GardenData {
  plots: { slot: number; plant: Plant | null }[];
  seeds: Seed[];
  freeSeeds: { available: number; nextAt: number | null };
  pending: { id: string; kind: string; consentUrl: string; createdAt: number }[];
  serverNow?: number;
  fertiliser?: number;
  fertiliseCost?: number;
}

// A plant whose genome is still hidden is drawn with a neutral stand-in that carries its colour.
const placeholder = (h: Plant["hint"]): Genome => ({
  hue: h.hue, hue2: h.hue, sat: h.sat, lum: h.lum, petals: 5, shape: 0, layers: 1, pattern: 0, center: 0,
  centerHue: 50, stem: 0.5, leaves: 2, curl: 0, glow: false, iridescent: false,
});
const originLabel = (s: { origin: string; generation: number }) =>
  s.origin === "hybrid" ? `Hybrid · gen ${s.generation}` : s.origin === "packet" ? "Premium" : "Wild";

export default function Garden() {
  const { config, refreshBalance } = useSession();
  const { data, reload, setData } = useApi<GardenData>("/api/garden");
  const [picked, setPicked] = useState<string | null>(null);
  // Short-lived visual effects on a plot: a seed dropping in, or a splash of water.
  const [fx, setFx] = useState<Record<number, { kind: "plant" | "water"; at: number }>>({});
  const flash = (slot: number, kind: "plant" | "water") => {
    const at = Date.now();
    setFx((f) => ({ ...f, [slot]: { kind, at } }));
    setTimeout(() => setFx((f) => (f[slot]?.at === at ? (({ [slot]: _, ...rest }) => rest)(f) : f)), 1200);
  };
  const dragging = useDragging();
  const [harvested, setHarvested] = useState<{ id: string; species: string; rarity: string; discovered: boolean; genome: Genome } | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const clientNow = useNow(1000);
  // All timers come from the server's clock; correct for any difference with this device's clock.
  const [skew, setSkew] = useState(0);
  useEffect(() => { if (data?.serverNow) setSkew(Date.now() - data.serverNow); }, [data?.serverNow]);
  const now = clientNow - skew;

  // Refresh state when a plant crosses a stage boundary or the tab comes back.
  useEffect(() => {
    const t = setInterval(reload, 30_000);
    const vis = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [reload]);
  useEffect(() => {
    if (!data) return;
    const soon = data.plots.some((p) => p.plant && p.plant.stage !== "bloom" && p.plant.readyAt <= now);
    if (soon) reload();
  }, [Math.floor(now / 5000)]);

  // Coming back from serble.net
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const kind = q.get("trade"), status = q.get("status");
    if (!kind) return;
    history.replaceState(null, "", "/garden");
    if (kind === "packet") {
      if (status === "Approved") toast("Your seed packet arrived. Check your pouch!");
      else if (status === "Pending") toast("Still waiting on serble.net. We'll pick it up when it's approved.");
      else toast("The packet purchase didn't go through.", true);
    }
    refreshBalance();
    reload();
  }, []);

  if (!data) return <div className="wrap section"><span className="spin" /></div>;

  const act = async (path: string, body: unknown, ok?: string) => {
    const r = await run(() => api(path, body), ok);
    reload();
    return r;
  };
  const plantInto = async (slot: number, seedId = picked) => {
    if (!seedId) return;
    setPicked(null);
    setData({ ...data, seeds: data.seeds.filter((s) => s.id !== seedId) });
    flash(slot, "plant");
    await act("/api/plant", { seedId, slot });
  };
  // Watering is instant on screen and never blocks other plots: update this plant optimistically
  // (one watering used, 15% growth boost, its own cooldown started), then confirm in the background.
  const waterPlot = (slot: number) => {
    flash(slot, "water");
    setData((d) => d && {
      ...d,
      plots: d.plots.map((p) => p.slot !== slot || !p.plant ? p : {
        ...p,
        plant: {
          ...p.plant,
          waters: p.plant.waters + 1,
          readyAt: p.plant.readyAt - Math.round(p.plant.growMs * 0.15),
          canWaterAt: p.plant.waters + 1 >= 3 ? null : Date.now() - skew + 60_000, // placeholder until the reload
        },
      }),
    });
    api("/api/water", { slot }).then(reload, (e) => { toast((e as Error).message, true); reload(); });
  };
  const fertilisePlot = (slot: number) => {
    flash(slot, "plant");
    setData((d) => d && {
      ...d,
      fertiliser: (d.fertiliser ?? 0) - (d.fertiliseCost ?? 3),
      plots: d.plots.map((p) => p.slot !== slot || !p.plant ? p : { ...p, plant: { ...p.plant, readyAt: p.plant.readyAt - Math.round(p.plant.growMs * 0.25) } }),
    });
    api("/api/fertilise", { slot }).then(reload, (e) => { toast((e as Error).message, true); reload(); });
  };
  const harvest = async (slot: number, genome: Genome) => {
    const r = await run(() => api("/api/harvest", { slot }));
    if (r) setHarvested({ ...r, genome });
    reload();
  };
  const emptySlots = data.plots.filter((p) => !p.plant).map((p) => p.slot);
  const freeReady = data.freeSeeds.available > 0;

  return <div className="wrap">
    {data.pending.length > 0 && <div className="banner">
      <span>{data.pending.length === 1 ? "A request is" : `${data.pending.length} requests are`} waiting for you on serble.net.</span>
      <span className="spacer" />
      {data.pending.slice(0, 1).map((p) => <a key={p.id} className="btn small accent" href={p.consentUrl}>Open it</a>)}
      <button className="btn small ghost" disabled={busy} onClick={async () => {
        for (const p of data.pending) await api(`/api/proposals/${p.id}/settle`, {}).catch(() => {});
        reload(); refreshBalance();
      }}>Check again</button>
    </div>}

    <div className="section">
      <div className="section-head">
        <h2>Your garden</h2>
        <span className="faint">{picked ? "Now tap an empty plot to plant." : dragging ? "" : "Drag a seed onto a plot, or tap one then the other."}</span>
        <span className="spacer" />
        <FertiliserSack count={data.fertiliser ?? 0} cost={data.fertiliseCost ?? 3} />
        <WateringCan />
      </div>
      <div className="plots">
        {data.plots.map(({ slot, plant }) => <Plot key={slot} slot={slot} plant={plant} now={now} busy={busy} picked={picked} fx={fx[slot]}
          onEmptyTap={() => picked ? plantInto(slot) : data.seeds[0] ? setPicked(data.seeds[0].id) : toast("Your pouch is empty. Gather free seeds or buy a packet.")}
          onSeedDrop={(id) => plantInto(slot, id)}
          onWater={() => waterPlot(slot)}
          canFertilise={(data.fertiliser ?? 0) >= (data.fertiliseCost ?? 3)}
          onFertilise={() => fertilisePlot(slot)}
          onHarvest={() => plant?.genome && harvest(slot, plant.genome)}
          onCompost={() => confirm("Dig this plant up? It will be lost.") && act("/api/compost", { slot })} />)}
      </div>
    </div>

    <div className="section">
      <div className="section-head"><h2>Seed pouch</h2><span className="pill">{data.seeds.length}</span>
        {picked && <button className="linkish" onClick={() => setPicked(null)}>cancel</button>}</div>
      {data.seeds.length === 0 ? <p className="muted">No seeds. Claim your free ones below, or breed two flowers in your <Link to="/vase">vase</Link>.</p>
        : <div className="pouch">
          {data.seeds.map((s) => <SeedChip key={s.id} seed={s} on={picked === s.id} onTap={() => {
            if (picked === s.id) return setPicked(null);
            setPicked(s.id);
            if (emptySlots.length === 0) toast("All plots are busy. Harvest or dig one up first.");
          }} />)}
        </div>}
    </div>

    <div className="side section">
      <div className="card pad">
        <h3>Free seeds</h3>
        <p className="muted">Wild seeds blow in every few hours. Up to three wait for you.</p>
        <div className="row">
          <button className="btn accent" disabled={!freeReady || busy} onClick={() => act("/api/seeds/claim", {}, undefined).then((r: any) => r && toast(`You found ${r.claimed} seed${r.claimed > 1 ? "s" : ""}.`))}>
            {freeReady ? `Gather ${data.freeSeeds.available} seed${data.freeSeeds.available > 1 ? "s" : ""}` : "Nothing yet"}
          </button>
          {data.freeSeeds.nextAt && <span className="faint">next in {fmtDuration(data.freeSeeds.nextAt - now)}</span>}
        </div>
      </div>
      <div className="card pad">
        <h3>Premium seed packet</h3>
        <p className="muted">{config?.prices.packet.seeds ?? 3} seeds with much better odds of rare forms, glowing and opaline petals.</p>
        <div className="row">
          <button className="btn" disabled={busy} onClick={async () => {
            const r = await run(() => api<{ consentUrl: string }>("/api/shop/packet", {}));
            if (r) toConsent(r.consentUrl);
          }}>Buy for <Coins n={config?.prices.packet.coins ?? "?"} /></button>
          <span className="faint">You'll confirm on serble.net.</span>
        </div>
      </div>
    </div>

    {harvested && <Modal label="Harvested" onClose={() => setHarvested(null)}>
      <div style={{ textAlign: "center" }}>
        <Flower genome={harvested.genome} animate uid="harvest" className="harvest-art" />
        <h2 style={{ marginTop: 8 }}>{harvested.species}</h2>
        <p><RarityTag r={harvested.rarity} /></p>
        {harvested.discovered && <p><b>New species!</b> You're the first gardener to grow this one. It's in the Almanac under your name.</p>}
        <div className="row" style={{ justifyContent: "center" }}>
          <Link to="/vase" className="btn accent">See it in your vase</Link>
          <button className="btn ghost" onClick={() => setHarvested(null)}>Keep gardening</button>
        </div>
      </div>
    </Modal>}
  </div>;
}

function SeedDot({ s }: { s: Seed }) {
  return <div className="dot" style={{ background: s.origin === "wild" ? "#a9875f" : hintColor(s.hint) }} />;
}

function SeedChip({ seed, on, onTap }: { seed: Seed; on: boolean; onTap: () => void }) {
  const drag = useDraggable({ kind: "seed", id: seed.id }, () => <div className="seed ghost"><SeedDot s={seed} /></div>, { onTap });
  return <div className={"seed" + (on ? " on" : "")} role="button" tabIndex={0} aria-pressed={on} {...drag}>
    <SeedDot s={seed} />
    {originLabel(seed)}
  </div>;
}

const CAN = <svg viewBox="0 0 64 48" aria-hidden><path d="M14 18h26v20a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6V18Z" fill="#5f9ea0" stroke="#2f5f60" strokeWidth="2"/>
  <path d="M40 24l16-12 3 4-15 14" fill="#5f9ea0" stroke="#2f5f60" strokeWidth="2" strokeLinejoin="round"/>
  <path d="M18 18c0-8 18-8 18 0" fill="none" stroke="#2f5f60" strokeWidth="3"/><circle cx="58" cy="13" r="3" fill="#2f5f60"/></svg>;

function WateringCan() {
  const toast = useToast();
  const drag = useDraggable({ kind: "can" }, () => <div className="can tilt">{CAN}</div>,
    { onTap: () => toast("Drag the watering can onto a growing plant.") });
  return <div className="can" role="button" tabIndex={0} aria-label="Watering can: drag onto a plant" title="Drag onto a growing plant" {...drag}>{CAN}</div>;
}

const SACK = <svg viewBox="0 0 48 48" aria-hidden><path d="M13 16c-3 8-4 18-1 24 2 4 22 4 24 0 3-6 2-16-1-24Z" fill="#b08a5a" stroke="#6b4f2c" strokeWidth="2" strokeLinejoin="round"/>
  <path d="M14 16c3-5 17-5 20 0" fill="none" stroke="#6b4f2c" strokeWidth="2"/><path d="M17 11l3 5M31 11l-3 5" stroke="#6b4f2c" strokeWidth="2" strokeLinecap="round"/>
  <path d="M24 34c0-6 4-9 7-9-1 5-3 8-7 9Zm0 0c0-5-3-7-6-7 1 4 3 6 6 7Z" fill="#5f9a4a"/></svg>;

function FertiliserSack({ count, cost }: { count: number; cost: number }) {
  const toast = useToast();
  const enough = count >= cost;
  const drag = useDraggable({ kind: "fertiliser" }, () => <div className="can tilt">{SACK}</div>, {
    disabled: !enough,
    onTap: () => toast(enough ? `Drag the sack onto a growing plant to skip a quarter of its growing time (uses ${cost}).`
      : `You have ${count} fertiliser; ${cost} are needed. Compost flowers in your vase to make more.`),
  });
  return <div className={"can sack" + (enough ? "" : " empty")} role="button" tabIndex={0} {...drag}
    onClick={enough ? undefined : () => toast(`You have ${count} fertiliser; ${cost} are needed. Compost flowers in your vase to make more.`)}
    aria-label={`Fertiliser: ${count}. Drag onto a growing plant.`} title={`Fertiliser: ${count} (uses ${cost})`}>
    {SACK}<span className="count">{count}</span>
  </div>;
}

function Plot({ slot, plant, now, busy, picked, fx, onEmptyTap, onSeedDrop, onWater, onHarvest, onCompost, canFertilise, onFertilise }: {
  slot: number; plant: Plant | null; now: number; busy: boolean; picked: string | null; fx?: { kind: string; at: number };
  onEmptyTap: () => void; onSeedDrop: (id: string) => void; onWater: () => void; onHarvest: () => void; onCompost: () => void;
  canFertilise: boolean; onFertilise: () => void;
}) {
  const ready = plant?.stage === "bloom";
  const waterIn = !plant || plant.canWaterAt === null ? null : Math.max(0, plant.canWaterAt - now);
  const canWater = !!plant && !ready && waterIn === 0;
  const drop = useDropTarget(`plot-${slot}`,
    (p: Payload) => (p.kind === "seed" && !plant) || (p.kind === "can" && canWater) || (p.kind === "fertiliser" && !!plant && !ready && canFertilise),
    (p: Payload) => { if (p.kind === "seed") onSeedDrop(p.id); else if (p.kind === "can") onWater(); else if (p.kind === "fertiliser") onFertilise(); });
  const effects = fx && <div className={"fx fx-" + fx.kind} key={fx.at} aria-hidden>
    {Array.from({ length: fx.kind === "water" ? 9 : 1 }, (_, i) => <i key={i} style={{ ["--i" as any]: i }} />)}
  </div>;

  if (!plant) return <div className={"card plot empty" + (picked ? " targetable" : "") + drop.state} {...drop.props}
    onClick={onEmptyTap} role="button" tabIndex={0} aria-label={`Empty plot ${slot + 1}`}>
    <div className="art"><Flower genome={placeholder({ hue: 30, sat: 40, lum: 50 })} stage="seed" soil uid={"e" + slot} className="emptyart" /></div>
    <div className="label muted">{picked ? "Plant here" : "Empty plot"}</div>
    {effects}
  </div>;

  const progress = ready ? 1 : Math.max(0.03, Math.min(1, 1 - (plant.readyAt - now) / plant.growMs));
  return <div className={"card plot" + (ready ? " ready-glow" : "") + drop.state} {...drop.props}>
    <div className={"art" + (fx?.kind === "plant" ? " pop" : "")} onClick={ready && !busy ? onHarvest : undefined} style={ready ? { cursor: "pointer" } : undefined}>
      <Flower genome={plant.genome ?? placeholder(plant.hint)} stage={plant.stage} soil animate={ready} uid={"p" + slot} />
    </div>
    <div className="label">{ready ? "In bloom!" : `${plant.stage === "seed" ? "Germinating" : plant.stage === "sprout" ? "Sprouting" : "Budding"} · ${fmtDuration(plant.readyAt - now)}`}</div>
    {!ready && <div className="bar"><i style={{ width: `${progress * 100}%` }} /></div>}
    <div className="acts">
      {ready ? <button className="btn small accent" disabled={busy} onClick={onHarvest}>Harvest</button>
        : <button className="btn small ghost" disabled={busy || !canWater} onClick={onWater}
            title="Each watering speeds growth by 15%, up to 3 times. You can also drag the watering can here.">
            {waterIn === null ? "Well watered" : waterIn > 0 ? `Water in ${fmtDuration(waterIn)}` : `Water (${3 - plant.waters} left)`}
          </button>}
      {!ready && <button className="btn small ghost" disabled={busy} onClick={onCompost} aria-label="Dig up">✕</button>}
    </div>
    <div className="faint" style={{ textAlign: "center", marginTop: 4 }}>{originLabel(plant)}</div>
    {effects}
  </div>;
}
