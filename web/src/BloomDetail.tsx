// A flower's details and actions (send to Serble, feature, gift, compost). Shared by the classic
// vase and the world view's greenhouse.
import { useState } from "react";
import { api, useApi, useAction, useNow, useSession, useToast, Flower, Coins, Link, Modal, toConsent, notifyChanged } from "./lib";
import { RarityTag, Traits, type Bloom } from "./blooms";

export function BloomDetail({ bloom: open, all, compostYield, onClose, onChanged }: {
  bloom: Bloom; all: Bloom[]; compostYield: Record<string, number>;
  onClose: () => void; onChanged: () => void;
}) {
  const { config } = useSession();
  const { busy, run } = useAction();
  const toast = useToast();
  const now = useNow(30_000);
  const [giving, setGiving] = useState(false);
  const [giftTo, setGiftTo] = useState("");
  const yieldOf = (b: Bloom) => compostYield[b.rarity] ?? 1;
  const done = (closeToo = true) => { onChanged(); if (closeToo) onClose(); };

  const feature = async (slot: number | null) => {
    if (await run(() => api("/api/feature", { bloomId: open.id, slot }), slot === null ? undefined : "Featured on your profile.")) done();
  };
  const compost = async () => {
    if (open.score >= 4 && !confirm(`Compost your ${open.rarity} ${open.species}? This can't be undone.`)) return;
    if (open.score < 4 && !confirm(`Compost your ${open.species} into ${yieldOf(open)} fertiliser? This can't be undone.`)) return;
    const r = await run(() => api<{ gained: number }>("/api/compost-blooms", { bloomIds: [open.id] }), (r) => `Composted into ${r.gained} fertiliser.`);
    if (r) { notifyChanged("garden"); done(); }
  };

  return <Modal label={open.species} onClose={onClose}>
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
            ? <button className="btn ghost" disabled={busy} onClick={() => feature(null)}>Unfeature</button>
            : <button className="btn ghost" disabled={busy} onClick={() => {
                const used = new Set(all.map((b) => b.featuredSlot).filter((x) => x != null));
                const free = [0, 1, 2, 3, 4].find((i) => !used.has(i));
                if (free === undefined) return toast("All 5 featured slots are full. Unfeature one first, or drag this flower onto a slot in the classic vase.", true);
                feature(free);
              }}>★ Feature</button>}
        </div>
        {!giving ? <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => { setGiving(true); setGiftTo(""); }}>🎁 Gift to a gardener</button>
          : <form className="gift-form" onSubmit={async (e) => {
              e.preventDefault();
              const r = await run(() => api<{ to: string; species: string }>("/api/gift", { bloomId: open.id, to: giftTo }), (r) => `Sent your ${r.species} to ${r.to}.`);
              if (r) done();
            }}>
              <GardenerInput value={giftTo} onChange={setGiftTo} />
              <button className="btn accent small" disabled={!giftTo.trim() || busy}>Send</button>
              <button type="button" className="btn ghost small" onClick={() => setGiving(false)}>Cancel</button>
            </form>}
        <p className="faint" style={{ marginTop: 10 }}>Sending turns this flower into a Serble item you can sell or trade on the <a href={config?.marketUrl} target="_blank" rel="noreferrer">Market</a>. Whoever holds it can bring it back into their own Pollen garden to breed.</p>
        <button className="linkish" style={{ fontSize: ".85rem" }} disabled={busy} onClick={compost}>Compost this flower (+{yieldOf(open)} fertiliser)</button>
      </div>
    </div>
  </Modal>;
}

/** A username box with suggestions from the gardener search. */
export function GardenerInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const q = value.trim();
  const { data } = useApi<{ gardeners: { username: string }[] }>(q.length >= 2 ? `/api/public/search?q=${encodeURIComponent(q)}` : null, [q]);
  return <>
    <input className="search" list="gardener-names" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Their name" autoFocus aria-label="Gardener to gift to" />
    <datalist id="gardener-names">{data?.gardeners.map((g) => <option key={g.username} value={g.username} />)}</datalist>
  </>;
}
