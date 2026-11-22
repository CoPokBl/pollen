import { useEffect, useState } from "react";
import { api, useApi, useAction, useSession, useNow, Flower, Link } from "./lib";
import { BloomCard, RarityTag, Traits, type Bloom } from "./blooms";
import { CommissionCard } from "./Commission";
import { Reactions, FlowerOfTheDay } from "./Social";
import { wildGenome, mulberry32, type Genome } from "../../shared/genome";

interface Stats { gardeners: number; blooms: number; species: number; onSerble: number }

const heroFlowers = (() => {
  const r = mulberry32(20261117);
  return [wildGenome(r, 4), { ...wildGenome(r, 6), glow: true, layers: 2 }, wildGenome(r, 4)];
})();

export function Landing() {
  const { me } = useSession();
  const { data: stats } = useApi<Stats>("/api/public/stats");
  const { data: top } = useApi<Bloom[]>("/api/public/blooms?sort=top");
  const signin = new URLSearchParams(location.search).get("signin");
  return <div className="wrap">
    <section className="hero">
      <div>
        <h1>Grow flowers nobody has ever seen.</h1>
        <p className="lead">Pollen is a slow, friendly garden for your Serble account. Plant seeds, cross-pollinate your favourites, and breed rare hybrids. Then trade them with other gardeners as real Serble items.</p>
        {signin && <p className="banner">{signin === "cancelled" ? "Sign-in was cancelled." : "Sign-in didn't work. Please try again."}</p>}
        <div className="row" style={{ marginTop: 18 }}>
          {me ? <Link to="/garden" className="btn accent big">Go to your garden</Link>
            : <a href="/auth/login" className="btn accent big">Start growing with Serble</a>}
          <Link to="/almanac" className="btn ghost big">Browse the Almanac</Link>
        </div>
        {stats && <div className="stats" style={{ marginTop: 26 }}>
          <div><b>{stats.gardeners}</b><span>gardeners</span></div>
          <div><b>{stats.blooms}</b><span>flowers grown</span></div>
          <div><b>{stats.species}</b><span>species found</span></div>
        </div>}
      </div>
      <div className="hero-art">
        {heroFlowers.map((g, i) => <Flower key={i} genome={g as Genome} className="f" animate uid={"h" + i} />)}
      </div>
    </section>

    <section className="section steps">
      <div className="card pad"><h3><span className="num">1</span>Plant</h3><p className="muted">Free wild seeds turn up every few hours. Plant them and watch them sprout, bud and bloom in real time. Watering helps.</p></div>
      <div className="card pad"><h3><span className="num">2</span>Breed</h3><p className="muted">Cross two flowers to make a hybrid seed. Colours blend, forms mix, and now and then something glows.</p></div>
      <div className="card pad"><h3><span className="num">3</span>Trade</h3><p className="muted">Send a flower to Serble as an item, sell it on the Market, or bring someone else's bloom home to breed from.</p></div>
    </section>

    <section className="section"><FlowerOfTheDay /></section>

    {top && top.length > 0 && <section className="section">
      <div className="section-head"><h2>Finest blooms</h2><Link to="/almanac" className="linkish">see all</Link></div>
      <div className="blooms">{top.slice(0, 12).map((b) => <BloomCard key={b.id} b={b} to={`/b/${b.id}`} extra={<div className="faint">by {b.grower}</div>} />)}</div>
    </section>}
  </div>;
}

interface Species { name: string; rarity: string; count: number; discoveredAt: number; discoverer: string; bloomId: string; genome: Genome | null; alive?: boolean }

export function Almanac() {
  const [tab, setTab] = useState<"species" | "recent" | "top">("species");
  const { data: species } = useApi<Species[]>("/api/public/almanac");
  const { data: leaders } = useApi<{ username: string; species: number }[]>("/api/public/leaders");
  const { data: blooms } = useApi<Bloom[]>(tab === "species" ? null : `/api/public/blooms?sort=${tab}`, [tab]);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const searching = debounced.length >= 2;
  const { data: found } = useApi<{ gardeners: { username: string; species: number }[]; species: Species[] }>(
    searching ? `/api/public/search?q=${encodeURIComponent(debounced)}` : null, [debounced]);
  return <div className="wrap section">
    <div className="almanac-top"><FlowerOfTheDay /><CommissionCard /></div>
    <div className="section-head">
      <h2>Almanac</h2>
      <input className="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search gardeners and species" aria-label="Search gardeners and species" />
      {!searching && <div className="tabs">
        {(["species", "recent", "top"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
          {t === "species" ? `Species${species ? ` · ${species.length}` : ""}` : t === "recent" ? "Just grown" : "Rarest"}</button>)}
      </div>}
    </div>
    {searching && <div className="search-results">
      {!found ? <span className="spin" /> : <>
        {found.gardeners.length > 0 && <div className="row" style={{ marginBottom: 14 }}>
          {found.gardeners.map((g) => <Link key={g.username} to={`/u/${encodeURIComponent(g.username)}`} className="claim">
            <b>{g.username}</b><span className="faint">{g.species} species</span></Link>)}
        </div>}
        {found.species.length > 0 && <div className="blooms">
          {found.species.map((s) => s.genome && <BloomCard key={s.name} to={s.alive ? `/b/${s.bloomId}` : undefined}
            b={{ id: s.bloomId, genome: s.genome, species: s.name, rarity: s.rarity } as Bloom}
            extra={<div className="faint">found by {s.discoverer} · {s.count} grown</div>} />)}
        </div>}
        {!found.gardeners.length && !found.species.length && <p className="muted">Nothing matches "{debounced}".</p>}
      </>}
    </div>}
    {!searching && tab === "species" && <div className="side almanac-grid" style={{ gridTemplateColumns: "minmax(0,3fr) minmax(0,1fr)", alignItems: "start" }}>
      <div className="blooms">
        {species?.map((s) => s.genome && <BloomCard key={s.name} to={s.alive ? `/b/${s.bloomId}` : undefined}
          b={{ id: s.bloomId, genome: s.genome, species: s.name, rarity: s.rarity } as Bloom}
          extra={<div className="faint">found by {s.discoverer} · {s.count} grown</div>} />)}
        {species?.length === 0 && <p className="muted">Nothing discovered yet. Be the first!</p>}
      </div>
      <div className="card pad">
        <h3>Top discoverers</h3>
        <table className="lb"><tbody>
          {leaders?.map((l, i) => <tr key={l.username}><td>{i + 1}. <Link to={`/u/${encodeURIComponent(l.username)}`}>{l.username}</Link></td><td>{l.species}</td></tr>)}
        </tbody></table>
        {leaders?.length === 0 && <p className="faint">No one yet.</p>}
      </div>
    </div>}
    {!searching && tab !== "species" && <div className="blooms">
      {blooms?.map((b) => <BloomCard key={b.id} b={b} to={`/b/${b.id}`} extra={<div className="faint">by {b.grower}</div>} />)}
    </div>}
  </div>;
}

export function BloomPage({ id }: { id: string }) {
  const { data: b, error } = useApi<Bloom & { parentBlooms: (Bloom & { missing?: boolean })[] | null; children: Bloom[] }>(`/api/public/bloom/${id}`, [id]);
  const now = useNow(60_000);
  const { config, me } = useSession();
  if (error) return <div className="wrap section empty-state"><h2>Not found</h2><p>{error}</p><Link to="/almanac" className="btn">Browse the Almanac</Link></div>;
  if (!b) return <div className="wrap section"><span className="spin" /></div>;
  return <div className="wrap section">
    <div className="card pad">
      <div className="detail" style={{ gridTemplateColumns: "minmax(0, 320px) 1fr" }}>
        <div className="art"><Flower genome={b.genome} animate uid="page" /></div>
        <div>
          <RarityTag r={b.rarity} />
          <h1 style={{ fontSize: "2.2rem", marginTop: 8 }}>{b.species}</h1>
          <p className="muted">Grown by {b.grower ? <Link to={`/u/${encodeURIComponent(b.grower)}`}><b>{b.grower}</b></Link> : <b>someone</b>}
            {b.state === "exported" ? ". It now lives in someone's Serble inventory as a tradable item."
            : b.owner && b.owner !== b.grower ? <>, now in <Link to={`/u/${encodeURIComponent(b.owner)}`}>{b.owner}</Link>'s vase.</> : "."}</p>
          <Traits g={b.genome} b={b} now={now} />
          <Reactions bloomId={b.id} own={!!me && (me.username === b.grower || me.username === b.owner)} />
          {b.state === "exported" && <a className="btn ghost" href={config?.marketUrl} target="_blank" rel="noreferrer">Look for it on the Market</a>}
        </div>
      </div>
    </div>
    {b.parentBlooms && <div className="section">
      <h3>Parents</h3>
      <div className="lineage">
        {b.parentBlooms.map((p) => p.missing ? <span key={p.id} className="faint">(composted)</span>
          : <BloomCard key={p.id} b={p} to={`/b/${p.id}`} />)}
      </div>
    </div>}
    {b.children.length > 0 && <div className="section">
      <h3>Offspring</h3>
      <div className="lineage">{b.children.map((c) => <BloomCard key={c.id} b={c} to={`/b/${c.id}`} />)}</div>
    </div>}
  </div>;
}

interface Profile {
  username: string; bio: string; joined: number;
  stats: { grown: number; inVase: number; species: number; bestGeneration: number };
  featured: Bloom[]; discoveries: Bloom[];
}

export function ProfilePage({ username }: { username: string }) {
  const { me } = useSession();
  const { data: p, error, reload } = useApi<Profile>(`/api/public/u/${encodeURIComponent(username)}`, [username]);
  const [editing, setEditing] = useState(false);
  const [bio, setBio] = useState("");
  const { busy, run } = useAction();
  if (error) return <div className="wrap section empty-state"><h2>No gardener by that name</h2><Link to="/almanac" className="btn">Browse the Almanac</Link></div>;
  if (!p) return <div className="wrap section"><span className="spin" /></div>;
  const mine = me?.username.toLowerCase() === p.username.toLowerCase();
  return <div className="wrap section">
    <div className="card pad profile-head">
      <div className="avatar" aria-hidden>{p.featured[0] ? <Flower genome={p.featured[0].genome} uid="av" head /> : <img src="/favicon.svg" alt="" />}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ fontSize: "2rem", marginBottom: 4 }}>{p.username}</h1>
        <p className="faint">Gardening since {new Date(p.joined).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</p>
        {editing ? <div className="bio-edit">
          <textarea value={bio} maxLength={280} rows={3} onChange={(e) => setBio(e.target.value)} placeholder="A little about you and your garden" autoFocus />
          <div className="row"><span className="faint">{bio.length}/280</span><span className="spacer" />
            <button className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn accent small" disabled={busy} onClick={async () => {
              if (await run(() => api("/api/profile", { bio }), "Saved.")) { setEditing(false); reload(); }
            }}>Save</button></div>
        </div> : <>
          {p.bio ? <p className="bio">{p.bio}</p> : mine ? <p className="faint">No description yet.</p> : null}
          {mine && <button className="linkish" onClick={() => { setBio(p.bio); setEditing(true); }}>{p.bio ? "Edit description" : "Add a description"}</button>}
        </>}
        <div className="stats" style={{ marginTop: 14 }}>
          <div><b>{p.stats.grown}</b><span>flowers grown</span></div>
          <div><b>{p.stats.species}</b><span>species discovered</span></div>
          <div><b>{p.stats.bestGeneration}</b><span>best generation</span></div>
          <div><b>{p.stats.inVase}</b><span>in vase</span></div>
        </div>
      </div>
    </div>

    <div className="section">
      <h3>Featured flowers</h3>
      {p.featured.length ? <div className="blooms">{p.featured.map((b) => <BloomCard key={b.id} b={b} to={`/b/${b.id}`} />)}</div>
        : <p className="muted">{mine ? <>Nothing featured yet. Drag your best flowers onto the Featured shelf in your <Link to="/vase">vase</Link>.</> : "Nothing featured yet."}</p>}
    </div>
    {p.discoveries.length > 0 && <div className="section">
      <h3>First to discover</h3>
      <div className="blooms">{p.discoveries.map((b) => <BloomCard key={b.id} b={b} to={`/b/${b.id}`} />)}</div>
    </div>}
  </div>;
}
