import { useEffect, useState } from "react";
import { api, useApi, useAction, useNow, useSession, useToast, Flower, Coins, Link, Modal, toConsent } from "./lib";
import { BloomCard, RarityTag, Traits, type Bloom } from "./blooms";
import { useDraggable, useDropTarget, useDragging, type Payload } from "./drag";

interface InvItem { itemId: string; name: string; bloom: Bloom }

export default function Vase() {
  const { config, refreshBalance } = useSession();
  const { data: blooms, reload } = useApi<Bloom[]>("/api/vase");
  const [tab, setTab] = useState<"vase" | "serble">("vase");
  const [mode, setMode] = useState<"view" | "pollinate">("view");
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<Bloom | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const now = useNow(30_000);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const kind = q.get("trade"), status = q.get("status");
    if (!kind) return;
    history.replaceState(null, "", "/vase");
    const ok = status === "Approved";
    if (kind === "export") toast(ok ? "Sent! The flower is now an item in your Serble inventory, ready to trade." : status === "Pending" ? "Still waiting for serble.net." : "The flower stayed in your vase.", !ok && status !== "Pending");
    if (kind === "import") toast(ok ? "Welcome home! The flowers are back in your vase." : "Nothing was brought over.", !ok);
    refreshBalance();
  }, []);

  const [burst, setBurst] = useState<{ id: string; at: number } | null>(null);
  const dragging = useDragging();
  if (!blooms) return <div className="wrap section"><span className="spin" /></div>;
  const inVase = blooms.filter((b) => b.state === "vase");
  const travelling = blooms.filter((b) => b.state === "exporting");
  const ready = (b: Bloom) => !b.pollenReadyAt || b.pollenReadyAt <= now;

  const toggle = (b: Bloom) => {
    if (mode !== "pollinate") return setOpen(b);
    if (!ready(b)) return toast(`${b.species} is out of pollen for now.`, true);
    setSel((s) => s.includes(b.id) ? s.filter((x) => x !== b.id) : s.length >= 2 ? [s[1], b.id] : [...s, b.id]);
  };
  const pollinate = async (a = sel[0], b = sel[1]) => {
    const at = Date.now();
    setBurst({ id: b, at });
    setTimeout(() => setBurst((x) => (x?.at === at ? null : x)), 1100);
    const r = await run(() => api("/api/pollinate", { a, b }), "A hybrid seed is in your pouch. Plant it to see what grows!");
    if (r) { setSel([]); setMode("view"); reload(); }
  };

  return <div className="wrap section">
    <div className="section-head">
      <h2>Vase</h2>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "vase"} className={tab === "vase" ? "on" : ""} onClick={() => setTab("vase")}>In your vase · {inVase.length}</button>
        <button role="tab" aria-selected={tab === "serble"} className={tab === "serble" ? "on" : ""} onClick={() => setTab("serble")}>On Serble</button>
      </div>
      <span className="spacer" />
      {tab === "vase" && inVase.length >= 2 && (mode === "view"
        ? <button className="btn accent" onClick={() => setMode("pollinate")}>Cross-pollinate</button>
        : <><span className="faint">Pick two flowers · {sel.length}/2</span>
          <button className="btn accent" disabled={sel.length !== 2 || busy} onClick={() => pollinate()}>Make a hybrid seed</button>
          <button className="btn ghost" onClick={() => { setMode("view"); setSel([]); }}>Cancel</button></>)}
    </div>

    {tab === "vase" && <>
      {travelling.length > 0 && <div className="banner">{travelling.length} flower{travelling.length > 1 ? "s are" : " is"} waiting for your approval on serble.net.</div>}
      {inVase.length === 0 ? <div className="empty-state">
        <p>Your vase is empty. Harvest a flower from your <Link to="/garden">garden</Link>, or bring one in from Serble.</p>
      </div> : <div className="blooms" style={{ marginTop: 14 }}>
        {inVase.map((b) => <VaseBloom key={b.id} b={b} selected={sel.includes(b.id)} ready={ready(b)} busy={busy}
          burst={burst?.id === b.id ? burst.at : undefined} onTap={() => toggle(b)}
          onPollinate={(fromId) => pollinate(fromId, b.id)}
          extra={(mode === "pollinate" || dragging) && !ready(b) ? <div className="faint">resting</div> : b.generation > 0 ? <div className="faint">gen {b.generation}</div> : null} />)}
      </div>}
      {inVase.length >= 2 && mode === "view" && <p className="faint" style={{ marginTop: 12 }}>Tip: drag one flower onto another to cross-pollinate them (press and hold first on a phone).</p>}
      {mode === "pollinate" && <p className="faint" style={{ marginTop: 12 }}>Hybrids inherit traits from both parents, blend their colours, and sometimes mutate. Two luminous or opaline parents are far more likely to pass those traits on. Each flower needs about 20 hours to make more pollen.</p>}
    </>}

    {tab === "serble" && <SerbleTab onImported={reload} />}

    {open && <Modal label={open.species} onClose={() => setOpen(null)}>
      <div className="detail">
        <div className="art"><Flower genome={open.genome} animate uid={"d" + open.id} /></div>
        <div>
          <RarityTag r={open.rarity} />
          <h2 style={{ marginTop: 8 }}>{open.species}</h2>
          <Traits g={open.genome} b={open} now={now} />
          <div className="row">
            <button className="btn accent" disabled={busy} onClick={async () => {
              const r = await run(() => api<{ consentUrl: string }>("/api/export", { bloomId: open.id }));
              if (r) toConsent(r.consentUrl);
            }}>Send to Serble{config && Number(config.prices.export.coins) > 0 ? <> · <Coins n={config.prices.export.coins} /></> : null}</button>
            <Link to={`/b/${open.id}`} className="btn ghost">Public page</Link>
          </div>
          <p className="faint" style={{ marginTop: 10 }}>Sending turns this flower into a Serble item you can sell or trade on the <a href={config?.marketUrl} target="_blank" rel="noreferrer">Market</a>. Whoever holds it can bring it back into their own Pollen garden to breed.</p>
          <button className="linkish" style={{ fontSize: ".85rem" }} disabled={busy} onClick={async () => {
            if (!confirm(`Compost your ${open.species}? This can't be undone.`)) return;
            if (await run(() => api("/api/release", { bloomId: open.id }), "Composted.")) { setOpen(null); reload(); }
          }}>Compost this flower</button>
        </div>
      </div>
    </Modal>}
  </div>;
}

function SerbleTab({ onImported }: { onImported: () => void }) {
  const { config } = useSession();
  const { data, error } = useApi<InvItem[]>("/api/serble/inventory");
  const [sel, setSel] = useState<string[]>([]);
  const { busy, run } = useAction();
  if (error) return <div className="empty-state"><p>{error}</p></div>;
  if (!data) return <div className="section"><span className="spin" /></div>;
  if (!data.length) return <div className="empty-state">
    <p>No Pollen flowers in your Serble inventory. Send one from your vase, or find one on the <a href={config?.marketUrl} target="_blank" rel="noreferrer">Serble Market</a>.</p>
  </div>;
  return <>
    <div className="row" style={{ margin: "12px 0" }}>
      <span className="muted">These flowers are items in your Serble inventory. Bring them home to breed with them.</span>
      <span className="spacer" />
      <button className="btn accent" disabled={!sel.length || busy} onClick={async () => {
        const r = await run(() => api<{ consentUrl: string }>("/api/import", { itemIds: sel }));
        if (r) { onImported(); toConsent(r.consentUrl); }
      }}>Bring {sel.length || ""} home</button>
    </div>
    <div className="blooms">
      {data.map((it) => <BloomCard key={it.itemId} b={it.bloom} selected={sel.includes(it.itemId)}
        onClick={() => setSel((s) => s.includes(it.itemId) ? s.filter((x) => x !== it.itemId) : [...s, it.itemId])} />)}
    </div>
  </>;
}

function VaseBloom({ b, selected, ready, busy, burst, extra, onTap, onPollinate }: {
  b: Bloom; selected: boolean; ready: boolean; busy: boolean; burst?: number; extra: React.ReactNode;
  onTap: () => void; onPollinate: (fromId: string) => void;
}) {
  const drag = useDraggable({ kind: "bloom", id: b.id },
    () => <div className="card bloom"><Flower genome={b.genome} uid={"g" + b.id} /></div>,
    { onTap, hold: 220, disabled: !ready || busy });
  const drop = useDropTarget(`bloom-${b.id}`, (p: Payload) => p.kind === "bloom" && p.id !== b.id && ready, (p: Payload) => p.kind === "bloom" && onPollinate(p.id));
  return <div className={"card bloom" + (selected ? " sel" : "") + (burst ? " pollinated" : "") + drop.state} {...drop.props}
    role="button" tabIndex={0} aria-pressed={selected} {...drag} onClick={ready ? undefined : onTap}>
    <span className="tag"><RarityTag r={b.rarity} /></span>
    <Flower genome={b.genome} uid={"c" + b.id} />
    <div className="nm">{b.species}</div>
    {extra}
    {burst && <div className="fx fx-pollen" key={burst} aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ ["--i" as any]: i }} />)}</div>}
  </div>;
}
