// Reactions (#13) and the flower of the day (#14).
import { api, useApi, useAction, useSession, Flower, Link } from "./lib";
import { RarityTag } from "./blooms";
import type { Genome } from "../../shared/genome";

const EMOJI: Record<string, [string, string]> = { love: ["❤️", "Love it"], sparkle: ["✨", "Dazzling"], wow: ["😮", "Wow"], bloom: ["🌸", "Lovely"] };
interface Summary { counts: Record<string, number>; total: number; mine: string | null }

export function Reactions({ bloomId, own }: { bloomId: string; own: boolean }) {
  const { me } = useSession();
  const { data, setData } = useApi<Summary>(`/api/reactions/${bloomId}`, [bloomId, me?.id]);
  const { busy, run } = useAction();
  if (!data) return null;
  const can = !!me && !own;
  return <div className="reactions" aria-label="Reactions">
    {Object.entries(EMOJI).map(([k, [emoji, label]]) => {
      const n = data.counts[k] ?? 0;
      const mine = data.mine === k;
      return <button key={k} className={"react" + (mine ? " on" : "")} disabled={!can || busy} aria-pressed={mine}
        title={!me ? "Sign in to react" : own ? "You can't react to your own flower" : mine ? `${label} (tap to remove)` : label}
        onClick={async () => { const r = await run(() => api<Summary>("/api/react", { bloomId, kind: k })); if (r) setData(r); }}>
        <span aria-hidden>{emoji}</span><span className="n">{n || ""}</span><span className="sr">{label}</span>
      </button>;
    })}
    {!me && <a className="linkish faint" href={`/auth/login?next=/b/${bloomId}`}>Sign in to react</a>}
  </div>;
}

interface Daily { bloomId: string; genome: Genome; species: string; rarity: string; grower: string | null; reactions: number; reason: string; alive: boolean }

export function FlowerOfTheDay() {
  const { data } = useApi<{ flower: Daily | null }>("/api/public/flower-of-the-day");
  const f = data?.flower;
  if (!f) return null;
  const inner = <>
    <div className="fotd-art"><Flower genome={{ ...f.genome, stem: 0.35, curl: 0.1 }} animate uid="fotd" head /></div>
    <div className="fotd-body">
      <div className="faint fotd-kicker">Flower of the day</div>
      <h3>{f.species}</h3>
      <div className="row" style={{ gap: 8 }}>
        <RarityTag r={f.rarity} />
        <span className="faint">{f.grower ? <>grown by <b>{f.grower}</b></> : null}
          {f.reason === "reactions" ? ` · ${f.reactions} reaction${f.reactions === 1 ? "" : "s"} this week` : " · the rarest new flower"}</span>
      </div>
      {!f.alive && <p className="faint" style={{ margin: "6px 0 0" }}>Since composted, but not forgotten.</p>}
    </div>
  </>;
  return f.alive ? <Link to={`/b/${f.bloomId}`} className="card pad fotd">{inner}</Link> : <div className="card pad fotd">{inner}</div>;
}
