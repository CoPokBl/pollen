import { useEffect, useState } from "react";
import { notifyChanged, useOnChanged } from "./lib";
import { api, useApi, useAction, useNow, useSession, useToast, Flower, Coins, Link, Modal, toConsent } from "./lib";
import { BloomCard, RarityTag, Traits, CENTRES, type Bloom } from "./blooms";
import { PATTERNS, RARITIES, colorName } from "../../shared/genome";
import { useDraggable, useDropTarget, useDragging, type Payload } from "./drag";

interface InvItem { itemId: string; name: string; bloom: Bloom }
interface VaseData { blooms: Bloom[]; fertiliser: number; compostYield: Record<string, number> }

// Sorting and grouping (#10). Choices are remembered per device.
const SORTS = {
  newest: { label: "Newest", cmp: (a: Bloom, b: Bloom) => b.createdAt - a.createdAt },
  oldest: { label: "Oldest", cmp: (a: Bloom, b: Bloom) => a.createdAt - b.createdAt },
  rarity: { label: "Rarest", cmp: (a: Bloom, b: Bloom) => b.score - a.score || b.createdAt - a.createdAt },
  global: { label: "Globally rarest", cmp: (a: Bloom, b: Bloom) => (a.speciesCount ?? 1) - (b.speciesCount ?? 1) || b.score - a.score },
  generation: { label: "Generation", cmp: (a: Bloom, b: Bloom) => b.generation - a.generation || b.createdAt - a.createdAt },
  pollen: { label: "Pollen ready soonest", cmp: (a: Bloom, b: Bloom) => (a.pollenReadyAt ?? 0) - (b.pollenReadyAt ?? 0) || b.score - a.score },
} as const;
const RARITY_ORDER = [...RARITIES].reverse() as string[];
const GROUPS = {
  none: { label: "No grouping", key: () => "", order: (_k: string) => 0 },
  rarity: { label: "Rarity", key: (b: Bloom) => b.rarity, order: (k: string) => RARITY_ORDER.indexOf(k) },
  colour: { label: "Colour", key: (b: Bloom) => colorName(b.genome), order: () => 0 },
  pattern: { label: "Pattern", key: (b: Bloom) => PATTERNS[b.genome.pattern] || "Plain", order: () => 0 },
  centre: { label: "Centre", key: (b: Bloom) => CENTRES[b.genome.center] ?? "Other", order: () => 0 },
} as const;
type SortKey = keyof typeof SORTS;
type GroupKey = keyof typeof GROUPS;
function usePref<T extends string>(key: string, fallback: T, allowed: readonly string[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key); if (s && allowed.includes(s)) return s as T; } catch { /* storage unavailable */ }
    return fallback;
  });
  return [v, (nv: T) => { setV(nv); try { localStorage.setItem(key, nv); } catch { /* ignore */ } }];
}

export default function Vase() {
  const { config, refreshBalance } = useSession();
  const { data: vase, reload } = useApi<VaseData>("/api/vase");
  useOnChanged("vase", reload);
  const { data: gifts, setData: setGifts } = useApi<{ bloomId: string; species: string; sender: string | null }[]>("/api/gifts/new");
  const [giving, setGiving] = useState(false);
  const [giftTo, setGiftTo] = useState("");
  const blooms = vase?.blooms;
  const [sort, setSort] = usePref<SortKey>("pollen.vase.sort", "newest", Object.keys(SORTS));
  const [group, setGroup] = usePref<GroupKey>("pollen.vase.group", "none", Object.keys(GROUPS));
  const [tab, setTab] = useState<"vase" | "serble">("vase");
  const [mode, setMode] = useState<"view" | "pollinate" | "compost">("view");
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

  const yieldOf = (b: Bloom) => vase?.compostYield[b.rarity] ?? 1;
  const compost = async (ids: string[]) => {
    const list = inVase.filter((b) => ids.includes(b.id));
    const precious = list.filter((b) => b.score >= 4);
    if (precious.length && !confirm(precious.length === 1 ? `Compost your ${precious[0].rarity} ${precious[0].species}? This can't be undone.`
      : `Compost ${list.length} flowers, including ${precious.length} Rare or better? This can't be undone.`)) return;
    const r = await run(() => api<{ composted: number; gained: number }>("/api/compost-blooms", { bloomIds: ids }),
      (r) => `Composted ${r.composted} flower${r.composted > 1 ? "s" : ""} into ${r.gained} fertiliser. Use it in your garden to speed up growth.`);
    if (r) { setSel([]); setMode("view"); setOpen(null); reload(); notifyChanged("garden"); }
  };
  const feature = async (bloomId: string, slot: number | null) => {
    if (await run(() => api("/api/feature", { bloomId, slot }), slot === null ? undefined : "Featured on your profile.")) reload();
  };
  const toggle = (b: Bloom) => {
    if (mode === "compost") return setSel((s) => s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]);
    if (mode !== "pollinate") return setOpen(b);
    if (!ready(b)) return toast(`${b.species} is out of pollen for now.`, true);
    setSel((s) => s.includes(b.id) ? s.filter((x) => x !== b.id) : s.length >= 2 ? [s[1], b.id] : [...s, b.id]);
  };
  const pollinate = async (a = sel[0], b = sel[1]) => {
    const at = Date.now();
    setBurst({ id: b, at });
    setTimeout(() => setBurst((x) => (x?.at === at ? null : x)), 1100);
    const r = await run(() => api("/api/pollinate", { a, b }), "A hybrid seed is in your pouch. Plant it to see what grows!");
    if (r) notifyChanged("garden");
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
      {tab === "vase" && mode === "view" && <>
        {inVase.length >= 2 && <button className="btn accent" onClick={() => setMode("pollinate")}>Cross-pollinate</button>}
        {inVase.length > 0 && <button className="btn ghost" onClick={() => setMode("compost")}>Compost…</button>}
        <CompostBin onDropBloom={(id) => compost([id])} />
      </>}
      {tab === "vase" && mode === "pollinate" && <><span className="faint">Pick two flowers · {sel.length}/2</span>
        <button className="btn accent" disabled={sel.length !== 2 || busy} onClick={() => pollinate()}>Make a hybrid seed</button>
        <button className="btn ghost" onClick={() => { setMode("view"); setSel([]); }}>Cancel</button></>}
      {tab === "vase" && mode === "compost" && <><span className="faint">{sel.length ? `${sel.length} selected · +${inVase.filter((b) => sel.includes(b.id)).reduce((n, b) => n + yieldOf(b), 0)} fertiliser` : "Pick flowers to compost"}</span>
        <button className="btn accent" disabled={!sel.length || busy} onClick={() => compost(sel)}>Compost</button>
        <button className="btn ghost" onClick={() => { setMode("view"); setSel([]); }}>Cancel</button></>}
    </div>
    {tab === "vase" && inVase.length > 0 && mode === "view" && <FeaturedShelf blooms={inVase} onFeature={feature} onOpen={setOpen} />}
    {tab === "vase" && inVase.length > 0 && <div className="row vase-tools">
      <label className="faint">Sort <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
        {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      <label className="faint">Group <select value={group} onChange={(e) => setGroup(e.target.value as GroupKey)}>
        {Object.entries(GROUPS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      <span className="spacer" />
      <span className="pill" title="Made by composting flowers. Drag the sack onto a growing plant in your garden.">🌱 {vase?.fertiliser ?? 0} fertiliser</span>
    </div>}

    {tab === "vase" && gifts && gifts.length > 0 && <div className="banner gift-banner">
      <span>🎁 {gifts.length === 1 ? <><b>{gifts[0].sender ?? "Someone"}</b> sent you a <b>{gifts[0].species}</b>!</>
        : <>You've been sent {gifts.length} flowers by {[...new Set(gifts.map((g) => g.sender ?? "someone"))].join(", ")}!</>}</span>
      <span className="spacer" />
      <button className="btn small ghost" onClick={() => { api("/api/gifts/seen", {}).catch(() => {}); setGifts([]); }}>Thanks!</button>
    </div>}
    {tab === "vase" && <>
      {travelling.length > 0 && <div className="banner">{travelling.length} flower{travelling.length > 1 ? "s are" : " is"} waiting for your approval on serble.net.</div>}
      {inVase.length === 0 ? <div className="empty-state">
        <p>Your vase is empty. Harvest a flower from your <Link to="/garden">garden</Link>, or bring one in from Serble.</p>
      </div> : grouped(inVase, sort, group).map(([name, list]) => <div key={name || "all"} className="vase-group">
        {name && <h3 className="group-head">{name} <span className="pill">{list.length}</span></h3>}
        <div className="blooms">
          {list.map((b) => <VaseBloom key={b.id} b={b} selected={sel.includes(b.id)} ready={ready(b)} busy={busy} dragOnlyCompost={mode === "compost"}
            burst={burst?.id === b.id ? burst.at : undefined} onTap={() => toggle(b)}
            onPollinate={(fromId) => pollinate(fromId, b.id)}
            extra={mode === "compost" ? <div className="faint">+{yieldOf(b)} fertiliser</div>
              : (mode === "pollinate" || dragging) && !ready(b) ? <div className="faint">resting</div>
              : sort === "global" ? <div className="faint">{b.speciesCount ?? 1} ever grown</div>
              : b.generation > 0 ? <div className="faint">gen {b.generation}</div> : null} />)}
        </div>
      </div>)}
      {inVase.length >= 2 && mode === "view" && <p className="faint" style={{ marginTop: 12 }}>Tip: drag one flower onto another to cross-pollinate them, or onto the compost bin to turn it into fertiliser (press and hold first on a phone).</p>}
      {mode === "pollinate" && sel.length === 2 && <CrossOdds a={sel[0]} b={sel[1]} />}
      {mode === "pollinate" && <p className="faint" style={{ marginTop: 12 }}>Hybrids inherit traits from both parents, blend their colours, and sometimes mutate. Two luminous or opaline parents are far more likely to pass those traits on. Each flower needs about 20 hours to make more pollen.</p>}
    </>}

    {tab === "serble" && <SerbleTab onImported={reload} />}

    {open && <Modal label={open.species} onClose={() => { setOpen(null); setGiving(false); }}>
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
            {open.featuredSlot != null
              ? <button className="btn ghost" disabled={busy} onClick={() => { feature(open.id, null); setOpen(null); }}>Unfeature</button>
              : <button className="btn ghost" disabled={busy} onClick={() => {
                  const used = new Set(inVase.map((b) => b.featuredSlot).filter((x) => x != null));
                  const free = [0, 1, 2, 3, 4].find((i) => !used.has(i));
                  if (free === undefined) return toast("All 5 featured slots are full. Drag this flower onto one to swap it in.", true);
                  feature(open.id, free); setOpen(null);
                }}>★ Feature</button>}
          </div>
          {!giving ? <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => { setGiving(true); setGiftTo(""); }}>🎁 Gift to a gardener</button>
            : <form className="gift-form" onSubmit={async (e) => {
                e.preventDefault();
                const r = await run(() => api<{ to: string; species: string }>("/api/gift", { bloomId: open.id, to: giftTo }), (r) => `Sent your ${r.species} to ${r.to}.`);
                if (r) { setGiving(false); setOpen(null); reload(); }
              }}>
                <GardenerInput value={giftTo} onChange={setGiftTo} />
                <button className="btn accent small" disabled={!giftTo.trim() || busy}>Send</button>
                <button type="button" className="btn ghost small" onClick={() => setGiving(false)}>Cancel</button>
              </form>}
          <p className="faint" style={{ marginTop: 10 }}>Sending turns this flower into a Serble item you can sell or trade on the <a href={config?.marketUrl} target="_blank" rel="noreferrer">Market</a>. Whoever holds it can bring it back into their own Pollen garden to breed.</p>
          <button className="linkish" style={{ fontSize: ".85rem" }} disabled={busy} onClick={() => {
            if (open.score < 4 && !confirm(`Compost your ${open.species} into ${yieldOf(open)} fertiliser? This can't be undone.`)) return;
            compost([open.id]);
          }}>Compost this flower (+{yieldOf(open)} fertiliser)</button>
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

function VaseBloom({ b, selected, ready, busy, burst, extra, onTap, onPollinate, dragOnlyCompost }: {
  b: Bloom; selected: boolean; ready: boolean; busy: boolean; burst?: number; extra: React.ReactNode;
  onTap: () => void; onPollinate: (fromId: string) => void; dragOnlyCompost?: boolean;
}) {
  // A resting flower can't pollinate, but can still be dragged to the compost bin.
  const drag = useDraggable({ kind: "bloom", id: b.id },
    () => <div className="card bloom"><Flower genome={b.genome} uid={"g" + b.id} /></div>,
    { onTap, hold: 220, disabled: busy || dragOnlyCompost });
  const drop = useDropTarget(`bloom-${b.id}`, (p: Payload) => p.kind === "bloom" && p.id !== b.id && ready && !dragOnlyCompost,
    (p: Payload) => p.kind === "bloom" && onPollinate(p.id));
  return <div className={"card bloom" + (selected ? " sel" : "") + (burst ? " pollinated" : "") + drop.state} {...drop.props}
    role="button" tabIndex={0} aria-pressed={selected} {...drag} onClick={dragOnlyCompost ? onTap : undefined}>
    <span className="tag"><RarityTag r={b.rarity} /></span>
    <Flower genome={b.genome} uid={"c" + b.id} />
    <div className="nm">{b.species}</div>
    {extra}
    {burst && <div className="fx fx-pollen" key={burst} aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ ["--i" as any]: i }} />)}</div>}
  </div>;
}

function grouped(list: Bloom[], sort: SortKey, group: GroupKey): [string, Bloom[]][] {
  const sorted = [...list].sort(SORTS[sort].cmp);
  if (group === "none") return [["", sorted]];
  const g = GROUPS[group];
  const map = new Map<string, Bloom[]>();
  for (const b of sorted) { const k = g.key(b); map.set(k, [...(map.get(k) ?? []), b]); }
  return [...map].sort((a, b) => g.order(a[0]) - g.order(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

const BIN = <svg viewBox="0 0 48 48" aria-hidden><path d="M10 14h28l-3 28H13L10 14Z" fill="#7a9a58" stroke="#3d5a2a" strokeWidth="2" strokeLinejoin="round"/>
  <path d="M7 14h34" stroke="#3d5a2a" strokeWidth="3" strokeLinecap="round"/><path d="M19 9h10" stroke="#3d5a2a" strokeWidth="3" strokeLinecap="round"/>
  <path d="M18 22c3 4 9 4 12 0M18 30c3 4 9 4 12 0" stroke="#d9e8c5" strokeWidth="2" fill="none" strokeLinecap="round"/></svg>;

function CompostBin({ onDropBloom }: { onDropBloom: (id: string) => void }) {
  const dragging = useDragging();
  const drop = useDropTarget("compost-bin", (p: Payload) => p.kind === "bloom", (p: Payload) => p.kind === "bloom" && onDropBloom(p.id));
  return <div className={"bin" + drop.state + (dragging?.payload.kind === "bloom" ? " bin-open" : "")} {...drop.props}
    title="Drag a flower here to compost it into fertiliser" aria-label="Compost bin">{BIN}</div>;
}

function FeaturedShelf({ blooms, onFeature, onOpen }: { blooms: Bloom[]; onFeature: (id: string, slot: number | null) => void; onOpen: (b: Bloom) => void }) {
  const { me } = useSession();
  const bySlot = new Map(blooms.filter((b) => b.featuredSlot != null).map((b) => [b.featuredSlot!, b]));
  return <div className="shelf">
    <div className="shelf-head"><b>Featured</b> <span className="faint">Drag your best flowers here to show them on {me ? <Link to={`/u/${me.username}`}>your profile</Link> : "your profile"}.</span></div>
    <div className="shelf-slots">{[0, 1, 2, 3, 4].map((i) => <FeatureSlot key={i} slot={i} bloom={bySlot.get(i)} onFeature={onFeature} onOpen={onOpen} />)}</div>
  </div>;
}

function FeatureSlot({ slot, bloom, onFeature, onOpen }: { slot: number; bloom?: Bloom; onFeature: (id: string, slot: number | null) => void; onOpen: (b: Bloom) => void }) {
  const drop = useDropTarget(`feature-${slot}`, (p: Payload) => p.kind === "bloom" && p.id !== bloom?.id, (p: Payload) => p.kind === "bloom" && onFeature(p.id, slot));
  const drag = useDraggable(bloom ? { kind: "bloom", id: bloom.id } : { kind: "bloom", id: "" },
    () => bloom ? <div className="card bloom"><Flower genome={bloom.genome} uid={"fg" + bloom.id} /></div> : null,
    { hold: 220, disabled: !bloom, onTap: () => bloom && onOpen(bloom) });
  return <div className={"slot" + (bloom ? " filled" : "") + drop.state} {...drop.props} {...(bloom ? drag : {})}
    aria-label={bloom ? `Featured: ${bloom.species}` : `Empty featured slot ${slot + 1}`} role={bloom ? "button" : undefined} tabIndex={bloom ? 0 : undefined}>
    {bloom ? <>
      <Flower genome={bloom.genome} uid={"f" + bloom.id} />
      <button className="slot-x" aria-label="Remove from featured" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onFeature(bloom.id, null); }}>×</button>
    </> : <span className="slot-star" aria-hidden>★</span>}
  </div>;
}

interface Odds { luminous: number; opaline: number; both: number; rarity: Record<string, number>; shapes: Record<string, number> }

/** What a cross is likely to produce, so breeding can be aimed at a goal (#15). */
function CrossOdds({ a, b }: { a: string; b: string }) {
  const { data } = useApi<Odds>(`/api/pollinate/odds?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`, [a, b]);
  if (!data) return null;
  const fmt = (n: number) => (n >= 10 ? Math.round(n) : n) + "%";
  const rare = (["Legendary", "Epic", "Rare"] as const).filter((r) => data.rarity[r]);
  const topShapes = Object.entries(data.shapes).sort((x, y) => y[1] - x[1]).slice(0, 3);
  return <div className="card pad odds" aria-live="polite">
    <b>Likely offspring</b>
    <div className="odds-row">
      <span>Luminous <b>{fmt(data.luminous)}</b></span>
      <span>Opaline <b>{fmt(data.opaline)}</b></span>
      <span>Both <b>{fmt(data.both)}</b></span>
      {rare.map((r) => <span key={r}>{r} <b>{fmt(data.rarity[r])}</b></span>)}
    </div>
    <div className="faint">Form: {topShapes.map(([k, v]) => `${k} ${fmt(v)}`).join(" · ")}</div>
  </div>;
}

/** A username box with suggestions from the gardener search. */
function GardenerInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const q = value.trim();
  const { data } = useApi<{ gardeners: { username: string }[] }>(q.length >= 2 ? `/api/public/search?q=${encodeURIComponent(q)}` : null, [q]);
  return <>
    <input className="search" list="gardener-names" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Their name" autoFocus aria-label="Gardener to gift to" />
    <datalist id="gardener-names">{data?.gardeners.map((g) => <option key={g.username} value={g.username} />)}</datalist>
  </>;
}
