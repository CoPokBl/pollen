import { useEffect, useState } from "react";
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
  const [harvested, setHarvested] = useState<{ id: string; species: string; rarity: string; discovered: boolean; genome: Genome } | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const now = useNow(1000);

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
  const plantInto = async (slot: number) => {
    if (!picked) return;
    const seedId = picked;
    setPicked(null);
    setData({ ...data, seeds: data.seeds.filter((s) => s.id !== seedId) });
    await act("/api/plant", { seedId, slot });
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
        <span className="faint">{picked ? "Now tap an empty plot to plant." : "Pick a seed from your pouch, then a plot."}</span>
      </div>
      <div className="plots">
        {data.plots.map(({ slot, plant }) => {
          if (!plant) return <div key={slot} className={"card plot empty" + (picked ? " targetable" : "")}
            onClick={() => picked ? plantInto(slot) : data.seeds[0] ? setPicked(data.seeds[0].id) : toast("Your pouch is empty. Claim free seeds or buy a packet.")}
            role="button" tabIndex={0} aria-label={`Empty plot ${slot + 1}`}>
            <div className="art"><Flower genome={placeholder({ hue: 30, sat: 40, lum: 50 })} stage="seed" soil uid={"e" + slot} className="emptyart" /></div>
            <div className="label muted">{picked ? "Plant here" : "Empty plot"}</div>
          </div>;
          const ready = plant.stage === "bloom";
          const waterIn = plant.canWaterAt === null ? null : Math.max(0, plant.canWaterAt - now);
          const progress = ready ? 1 : Math.max(0.03, Math.min(1, 1 - (plant.readyAt - now) / plant.growMs));
          return <div key={slot} className={"card plot" + (ready ? " ready-glow" : "")}>
            <div className="art"><Flower genome={plant.genome ?? placeholder(plant.hint)} stage={plant.stage} soil animate={ready} uid={"p" + slot} /></div>
            <div className="label">{ready ? "In bloom!" : `${plant.stage === "seed" ? "Germinating" : plant.stage === "sprout" ? "Sprouting" : "Budding"} · ${fmtDuration(plant.readyAt - now)}`}</div>
            {!ready && <div className="bar"><i style={{ width: `${progress * 100}%` }} /></div>}
            <div className="acts">
              {ready ? <button className="btn small accent" disabled={busy} onClick={() => harvest(slot, plant.genome!)}>Harvest</button>
                : <button className="btn small ghost" disabled={busy || waterIn === null || waterIn > 0} onClick={() => act("/api/water", { slot }, "Watered. It's growing faster.")}
                    title="Each watering speeds growth by 15%, up to 3 times.">
                    {waterIn === null ? "Well watered" : waterIn > 0 ? `Water in ${fmtDuration(waterIn)}` : `Water (${3 - plant.waters} left)`}
                  </button>}
              {!ready && <button className="btn small ghost" disabled={busy} onClick={() => confirm("Dig this plant up? It will be lost.") && act("/api/compost", { slot })} aria-label="Dig up">✕</button>}
            </div>
            <div className="faint" style={{ textAlign: "center", marginTop: 4 }}>{originLabel(plant)}</div>
          </div>;
        })}
      </div>
    </div>

    <div className="section">
      <div className="section-head"><h2>Seed pouch</h2><span className="pill">{data.seeds.length}</span>
        {picked && <button className="linkish" onClick={() => setPicked(null)}>cancel</button>}</div>
      {data.seeds.length === 0 ? <p className="muted">No seeds. Claim your free ones below, or breed two flowers in your <Link to="/vase">vase</Link>.</p>
        : <div className="pouch">
          {data.seeds.map((s) => <button key={s.id} className={"seed" + (picked === s.id ? " on" : "")} onClick={() => {
            if (picked === s.id) return setPicked(null);
            setPicked(s.id);
            if (emptySlots.length === 0) toast("All plots are busy. Harvest or dig one up first.");
          }}>
            <div className="dot" style={{ background: s.origin === "wild" ? "#a9875f" : hintColor(s.hint) }} />
            {originLabel(s)}
          </button>)}
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
