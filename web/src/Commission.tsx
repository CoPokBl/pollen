// The weekly commission card (#2), shown in the garden and the Almanac.
import { useState } from "react";
import { api, useApi, useAction, useNow, useSession, Flower, Coins, Link, fmtDuration } from "./lib";
import { exampleGenome, breedingTip, type Requirement } from "../../shared/commission";
import { wildGenome, mulberry32, type Genome } from "../../shared/genome";

interface CommissionData {
  week: number; start: number; end: number; title: string; requirements: Requirement[]; rewards: string[];
  claims: { place: number; username: string; bloomId: string; genome: Genome; reward: string; status: string }[];
  mine: { place: number; status: string } | null;
  eligible: string[];
}

const PLACES = ["1st", "2nd", "3rd"];

export function CommissionCard({ compact }: { compact?: boolean }) {
  const { me, refreshBalance } = useSession();
  const { data: c, reload } = useApi<CommissionData>("/api/commission", [me?.id]);
  const now = useNow(60_000);
  const { busy, run } = useAction();
  const [open, setOpen] = useState(!compact);
  if (!c) return null;
  // Head-cropped art assumes a standard stem, so normalise it for these small pictures.
  const framed = (g: Genome): Genome => ({ ...g, stem: 0.35, curl: 0.1 });
  const target = framed(exampleGenome(c, wildGenome(mulberry32(c.week * 31 + 7), 1)));
  const left = c.end - now;
  const prizesLeft = Math.max(0, c.rewards.length - c.claims.length);
  return <section className="card pad commission" aria-label="Weekly commission">
    <div className="commission-art"><Flower genome={target} animate uid={"com" + c.week} head /></div>
    <div className="commission-body">
      <div className="faint commission-kicker">Weekly commission · {left > 0 ? `${fmtDuration(left)} left` : "ending"}</div>
      <h3>{c.title}</h3>
      <div className="row" style={{ gap: 6 }}>{c.requirements.map((q) => <span key={q.kind + q.value} className="pill" title={breedingTip(q)}>{q.label}</span>)}</div>
      {!compact && <ul className="tips">{c.requirements.map((q) => <li key={q.kind + q.value}><b>{q.label}:</b> {breedingTip(q)}</li>)}</ul>}
      {compact && <details className="tips-details"><summary>Breeding tips</summary>
        <ul className="tips">{c.requirements.map((q) => <li key={q.kind + q.value}><b>{q.label}:</b> {breedingTip(q)}</li>)}</ul></details>}
      <p className="muted" style={{ margin: "8px 0" }}>
        Breed one this week. The first three gardeners win {c.rewards.map((r, i) => <span key={i}>{i ? (i === c.rewards.length - 1 ? " and " : ", ") : ""}<Coins n={r} /></span>)}.
        {prizesLeft === 0 ? " All prizes have been won, but you can still complete it." : ""}
      </p>
      {open && c.claims.length > 0 && <div className="claims">
        {c.claims.map((x) => <Link key={x.place} to={`/b/${x.bloomId}`} className="claim">
          <Flower genome={framed(x.genome)} uid={"cl" + x.place} head />
          <span><b>{PLACES[x.place - 1] ?? `#${x.place}`}</b> {x.username}{x.status === "owed" ? " · reward on its way" : ""}</span>
        </Link>)}
      </div>}
      {me && (c.mine
        ? <p className="commission-done">You completed this week's commission ({PLACES[c.mine.place - 1] ?? `#${c.mine.place}`}).{c.mine.status === "owed" || c.mine.status === "paying" ? " Your coins are on their way." : c.mine.status === "paid" ? " Your coins have been sent." : ""}</p>
        : c.eligible.length
          ? <div className="row">
              <button className="btn accent" disabled={busy} onClick={async () => {
                const r = await run(() => api<{ place: number; reward: string; status: string }>("/api/commission/claim", { bloomId: c.eligible[0] }),
                  (r) => r.reward !== "0" ? `Commission complete! ${PLACES[r.place - 1]} place: ${r.reward} coins ${r.status === "paid" ? "sent to your Serble balance" : "coming soon"}.` : "Commission complete!");
                if (r) { reload(); refreshBalance(); }
              }}>Hand in a matching flower</button>
              <span className="faint">You have {c.eligible.length} that qualif{c.eligible.length === 1 ? "ies" : "y"}.</span>
            </div>
          : <p className="faint">Flowers you grow this week that match will show up here. Only flowers you grew yourself count.</p>)}
      {!me && <a className="btn small accent" href="/auth/login">Sign in to take part</a>}
      {compact && c.claims.length > 0 && <button className="linkish" onClick={() => setOpen((o) => !o)}>{open ? "Hide winners" : `Winners so far (${c.claims.length})`}</button>}
    </div>
  </section>;
}
