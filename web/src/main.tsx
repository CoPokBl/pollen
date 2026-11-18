import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { api, Router, useRouter, Toasts, SessionCtx, Link, Coins, type Me, type AppConfig } from "./lib";
import Garden from "./Garden";
import { DragProvider } from "./drag";
import Vase from "./Vase";
import { Landing, Almanac, BloomPage } from "./Public";

const icons = {
  garden: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 21v-8M12 13c0-3 2-5 5-5 0 3-2 5-5 5ZM12 15c0-3-2-5-5-5 0 3 2 5 5 5ZM4 21h16" /></svg>,
  vase: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 3h6M10 3v4c-3 1-4 4-4 7 0 4 3 7 6 7s6-3 6-7c0-3-1-6-4-7V3" /></svg>,
  book: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5ZM4 21a2 2 0 0 1 2-2h13" /></svg>,
};

function Shell() {
  const { path } = useRouter();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const refreshBalance = useCallback(() => { api<{ coins: string | null }>("/api/balance").then((b) => setBalance(b.coins), () => {}); }, []);
  useEffect(() => {
    api<{ user: Me | null }>("/api/me").then((r) => { setMe(r.user); if (r.user) refreshBalance(); }, () => setMe(null));
    api<AppConfig>("/api/config").then(setConfig, () => {});
  }, []);

  const route = path.split("?")[0];
  const needsUser = route === "/garden" || route === "/vase";
  let page: React.ReactNode;
  const bloom = /^\/b\/([A-Za-z0-9_-]+)$/.exec(route);
  if (needsUser && me === null) page = <div className="wrap section empty-state"><h2>Sign in to garden</h2><p>Pollen uses your Serble account.</p><a className="btn accent big" href={`/auth/login?next=${route}`}>Sign in with Serble</a></div>;
  else if (needsUser && me === undefined) page = <div className="wrap section"><span className="spin" /></div>;
  else if (route === "/garden") page = <Garden />;
  else if (route === "/vase") page = <Vase />;
  else if (route === "/almanac") page = <Almanac />;
  else if (bloom) page = <BloomPage id={bloom[1]} />;
  else if (route === "/") page = <Landing />;
  else page = <div className="wrap section empty-state"><h2>Nothing grows here</h2><Link to="/" className="btn">Go home</Link></div>;

  const nav = [
    ["/garden", "Garden", icons.garden],
    ["/vase", "Vase", icons.vase],
    ["/almanac", "Almanac", icons.book],
  ] as const;

  return <SessionCtx.Provider value={{ me, config, balance, refreshBalance }}>
    <header className="top"><div className="wrap">
      <Link to="/" className="brand"><img src="/favicon.svg" alt="" />Pollen</Link>
      <nav className="nav">{nav.map(([to, label]) => <Link key={to} to={to} className={route === to ? "on" : ""}>{label}</Link>)}</nav>
      <span className="spacer" />
      {me && balance !== null && <Coins n={balance} />}
      {me ? <button className="btn small ghost" onClick={async () => { await api("/auth/logout", {}); location.href = "/"; }} title={`Signed in as ${me.username}`}>Sign out</button>
        : me === null && <a className="btn small accent" href="/auth/login">Sign in</a>}
    </div></header>
    <main>{page}</main>
    <nav className="bottom-nav">{nav.map(([to, label, icon]) => <Link key={to} to={to} className={route === to ? "on" : ""}>{icon}{label}</Link>)}</nav>
    <footer className="footer"><div className="wrap row">
      <span>Pollen is an unofficial community app built on <a href={config?.serbleWebsite ?? "https://serble.net"}>Serble</a>.</span>
      <span className="spacer" />
      {config?.mock && <span className="pill">mock Serble</span>}
    </div></footer>
  </SessionCtx.Provider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Router><Toasts><DragProvider><Shell /></DragProvider></Toasts></Router></StrictMode>);
