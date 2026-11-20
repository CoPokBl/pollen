import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { renderFlower, type Genome, type Stage } from "../../shared/genome";

// ------------------------------------------------------------------ api
export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg); } }

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path).then((d) => { if (live) { setData(d); setError(null); } }, (e) => live && setError(e.message));
    return () => { live = false; };
  }, [path, n, ...deps]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []), setData };
}

// ------------------------------------------------------------------ router
const RouterCtx = createContext<{ path: string; go: (to: string) => void }>({ path: "/", go: () => {} });
export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const go = useCallback((to: string) => {
    history.pushState(null, "", to);
    setPath(to);
    scrollTo({ top: 0 });
  }, []);
  return <RouterCtx.Provider value={{ path, go }}>{children}</RouterCtx.Provider>;
}
export const useRouter = () => useContext(RouterCtx);
export function Link({ to, className, children, onClick }: { to: string; className?: string; children: ReactNode; onClick?: () => void }) {
  const { go } = useRouter();
  return <a href={to} className={className} onClick={(e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); onClick?.(); go(to);
  }}>{children}</a>;
}

// ------------------------------------------------------------------ toasts
type Toast = { id: number; text: string; bad?: boolean };
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export function Toasts({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-2), { id, text, bad }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), bad ? 5500 : 3800);
  }, []);
  return <ToastCtx.Provider value={push}>
    {children}
    <div className="toasts" role="status" aria-live="polite">{list.map((t) => <div key={t.id} className={"toast" + (t.bad ? " bad" : "")}>{t.text}</div>)}</div>
  </ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/** Run an action, toast its error, and expose a busy flag. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string | undefined)) => {
    setBusy(true);
    try {
      const r = await fn();
      const msg = typeof ok === "function" ? ok(r) : ok;
      if (msg) toast(msg);
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return undefined;
    } finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

// ------------------------------------------------------------------ session
export interface Me { id: string; username: string; admin: boolean }
export interface AppConfig { plots: number; prices: { packet: { coins: string; seeds: number }; export: { coins: string } }; marketUrl: string; serbleWebsite: string; appId: string; mock: boolean }
export const SessionCtx = createContext<{ me: Me | null | undefined; config: AppConfig | null; balance: string | null; refreshBalance: () => void }>({ me: undefined, config: null, balance: null, refreshBalance: () => {} });
export const useSession = () => useContext(SessionCtx);

// ------------------------------------------------------------------ flower
export function Flower({ genome, stage, soil, animate, className, uid, head }: { genome: Genome; stage?: Stage; soil?: boolean; animate?: boolean; className?: string; uid?: string; head?: boolean }) {
  // `head` crops to the flower head (as the item icons do), for avatars and small tiles.
  const html = useMemo(() => {
    const svg = renderFlower(genome, { stage, soil, animate, uid });
    return head ? svg.replace('viewBox="0 0 200 220"', 'viewBox="25 38 150 150"') : svg;
  }, [genome, stage, soil, animate, uid, head]);
  return <div className={className} aria-hidden dangerouslySetInnerHTML={{ __html: html }} />;
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

export function fmtDuration(ms: number) {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

export function Modal({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    ref.current?.focus();
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  return <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="card modal" role="dialog" aria-label={label} tabIndex={-1} ref={ref}>
      <button className="x" onClick={onClose} aria-label="Close">×</button>
      {children}
    </div>
  </div>;
}

export function Coins({ n }: { n: string | number }) {
  return <span className="coins"><span className="coin" />{n}</span>;
}

export const hintColor = (h: { hue: number; sat: number; lum: number }) => `hsl(${h.hue} ${Math.min(h.sat, 70)}% ${Math.max(35, Math.min(h.lum, 65))}%)`;

/** Send the browser to a Serble consent page. */
export function toConsent(url: string) { location.href = url; }
