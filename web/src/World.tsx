// The world view (#20, phase 1): one continuous 2D scene with a camera, instead of separate pages.
// Potting table and noticeboard on the left, garden beds in the middle, greenhouse on the right.
// Phase 1 hosts the existing garden and vase inside the world, so nothing is lost while later
// phases turn them into objects.
import { useEffect, useMemo, useRef, useState } from "react";
import Garden from "./Garden";
import Vase from "./Vase";
import { CommissionCard } from "./Commission";
import { FlowerOfTheDay } from "./Social";
import { setEdgePanner } from "./drag";
import { Link } from "./lib";

const AREAS = [
  { key: "table", label: "Potting table", x: 0, w: 900 },
  { key: "garden", label: "Garden", x: 980, w: 1200 },
  { key: "greenhouse", label: "Greenhouse", x: 2260, w: 1200 },
] as const;
const WORLD_W = 3460;
const MIN_Z = 0.3, MAX_Z = 1.6;

type Cam = { x: number; y: number; z: number };

export default function World() {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const cam = useRef<Cam>({ x: AREAS[1].x, y: 0, z: 1 });
  const worldH = useRef(1400);
  const anim = useRef(0);
  const [area, setArea] = useState<string>("garden");
  const [zoom, setZoom] = useState(1);

  const size = () => ({ w: viewport.current?.clientWidth ?? innerWidth, h: viewport.current?.clientHeight ?? innerHeight });
  const clamp = (c: Cam): Cam => {
    const { w, h } = size();
    const z = Math.min(MAX_Z, Math.max(MIN_Z, c.z));
    const maxX = WORLD_W - w / z + 150, maxY = Math.max(0, worldH.current - h / z + 120);
    return { z, x: Math.min(maxX, Math.max(-150, c.x)), y: Math.min(maxY, Math.max(-60, c.y)) };
  };
  const apply = (c: Cam) => {
    cam.current = clamp(c);
    const { x, y, z } = cam.current;
    if (world.current) world.current.style.transform = `translate(${(-x * z).toFixed(1)}px, ${(-y * z).toFixed(1)}px) scale(${z})`;
    const { w } = size();
    const centre = x + w / (2 * z);
    const here = AREAS.reduce((best, a) => Math.abs(a.x + a.w / 2 - centre) < Math.abs(best.x + best.w / 2 - centre) ? a : best);
    setArea(here.key);
    setZoom(Math.round(z * 100) / 100);
  };
  const stop = () => cancelAnimationFrame(anim.current);
  /** Glide the camera somewhere, easing in and out. */
  const glide = (to: Partial<Cam>, ms = 650) => {
    stop();
    const from = { ...cam.current }, target = clamp({ ...from, ...to }), t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      apply({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e });
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };
  const goTo = (key: string) => {
    const a = AREAS.find((x) => x.key === key)!;
    const { w } = size();
    const z = Math.min(1, Math.max(MIN_Z, w / (a.w + 60)));
    glide({ z, x: a.x + a.w / 2 - w / (2 * z), y: 0 });
    try { localStorage.setItem("pollen.world.area", key); } catch { /* ignore */ }
  };
  /** Zoom by a factor, keeping the world point under (px, py) on screen where it is. */
  const zoomAt = (factor: number, px: number, py: number) => {
    const c = cam.current, z = Math.min(MAX_Z, Math.max(MIN_Z, c.z * factor));
    const wx = c.x + px / c.z, wy = c.y + py / c.z;
    apply({ z, x: wx - px / z, y: wy - py / z });
  };

  // world height follows its content (the vase can be long)
  useEffect(() => {
    const el = world.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { worldH.current = Math.max(1100, el.scrollHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // start where you left off, framed to fit
  useEffect(() => {
    let start = "garden";
    try { start = localStorage.getItem("pollen.world.area") || "garden"; } catch { /* ignore */ }
    const a = AREAS.find((x) => x.key === start) ?? AREAS[1];
    const { w } = size();
    const z = Math.min(1, Math.max(MIN_Z, w / (a.w + 60)));
    apply({ z, x: a.x + a.w / 2 - w / (2 * z), y: 0 });
    const onResize = () => apply(cam.current);
    addEventListener("resize", onResize);
    setEdgePanner((dx, dy) => {
      const before = cam.current;
      apply({ ...before, x: before.x + dx / before.z, y: before.y + dy / before.z });
      return cam.current.x !== before.x || cam.current.y !== before.y;
    });
    return () => { removeEventListener("resize", onResize); setEdgePanner(null); stop(); };
  }, []);

  // pan (drag), pinch zoom, wheel/trackpad, momentum
  useEffect(() => {
    const el = viewport.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let panning = false, start = { x: 0, y: 0 }, lastT = 0, vel = { x: 0, y: 0 }, pinchD = 0;
    const blocked = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("[data-draggable], input, select, textarea, .modal, .scrim");
    const down = (e: PointerEvent) => {
      if (blocked(e.target) || (e.pointerType === "mouse" && e.button !== 0)) return;
      stop();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { start = { x: e.clientX, y: e.clientY }; panning = false; vel = { x: 0, y: 0 }; lastT = performance.now(); }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinchD = Math.hypot(a.x - b.x, a.y - b.y); panning = true; }
    };
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      if (document.body.classList.contains("dragging")) { pts.clear(); panning = false; return; }   // an object is being carried
      const now = { x: e.clientX, y: e.clientY };
      if (pts.size >= 2) {
        pts.set(e.pointerId, now);
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = el.getBoundingClientRect();
        if (pinchD > 0) zoomAt(d / pinchD, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        pinchD = d;
        return;
      }
      if (!panning && Math.hypot(now.x - start.x, now.y - start.y) > 6) { panning = true; el.classList.add("panning"); }
      if (panning) {
        const c = cam.current, t = performance.now(), dt = Math.max(1, t - lastT);
        const dx = now.x - prev.x, dy = now.y - prev.y;
        vel = { x: 0.8 * (dx / dt) + 0.2 * vel.x, y: 0.8 * (dy / dt) + 0.2 * vel.y };
        lastT = t;
        apply({ ...c, x: c.x - dx / c.z, y: c.y - dy / c.z });
      }
      pts.set(e.pointerId, now);
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size > 0) { pinchD = 0; return; }
      el.classList.remove("panning");
      if (!panning) return;
      // a pan is not a click on whatever was under the pointer
      const swallow = (ce: MouseEvent) => { ce.stopPropagation(); ce.preventDefault(); };
      addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", swallow, { capture: true }), 250);
      // momentum
      if (performance.now() - lastT < 80 && Math.hypot(vel.x, vel.y) > 0.15 && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        let v = { ...vel }, t0 = performance.now();
        const step = (t: number) => {
          const dt = t - t0; t0 = t;
          const c = cam.current;
          apply({ ...c, x: c.x - (v.x * dt) / c.z, y: c.y - (v.y * dt) / c.z });
          v = { x: v.x * Math.pow(0.92, dt / 16), y: v.y * Math.pow(0.92, dt / 16) };
          if (Math.hypot(v.x, v.y) > 0.02) anim.current = requestAnimationFrame(step);
        };
        anim.current = requestAnimationFrame(step);
      }
      panning = false;
    };
    const wheel = (e: WheelEvent) => {
      if (blocked(e.target)) return;
      e.preventDefault();
      stop();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
      else {
        const c = cam.current;
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        apply({ ...c, x: c.x + dx / c.z, y: c.y + dy / c.z });
      }
    };
    // Only the camera moves the world. Focus or scrollIntoView must never scroll the viewport itself.
    const unscroll = () => { if (el.scrollTop || el.scrollLeft) { el.scrollTop = 0; el.scrollLeft = 0; } };
    // Keyboard focus on something off-screen glides the camera to it (what scrolling would do on a page).
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (!t?.getBoundingClientRect || !(e.target as Element).closest?.(".world")) return;
      const r = t.getBoundingClientRect(), v = el.getBoundingClientRect();
      if (r.top >= v.top && r.bottom <= v.bottom && r.left >= v.left && r.right <= v.right) return;
      const c = cam.current;
      const wx = c.x + (r.left + r.width / 2 - v.left) / c.z, wy = c.y + (r.top + r.height / 2 - v.top) / c.z;
      glide({ x: wx - v.width / (2 * c.z), y: wy - v.height / (2 * c.z) }, 400);
    };
    el.addEventListener("focusin", onFocus);
    el.addEventListener("scroll", unscroll);
    el.addEventListener("pointerdown", down);
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", unscroll);
      el.removeEventListener("focusin", onFocus);
      el.removeEventListener("pointerdown", down);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  // Stable elements, so camera updates never re-render the garden or the vase.
  const garden = useMemo(() => <Garden />, []);
  const vase = useMemo(() => <Vase />, []);
  const notices = useMemo(() => <div className="noticeboard"><FlowerOfTheDay /><CommissionCard /></div>, []);
  const backdrop = useMemo(() => <WorldBackdrop />, []);
  const { w } = size();
  return <div className="world-shell">
    <div className="world-bar">
      <div className="tabs" role="tablist" aria-label="Areas">
        {AREAS.map((a) => <button key={a.key} role="tab" aria-selected={area === a.key} className={area === a.key ? "on" : ""} onClick={() => goTo(a.key)}>{a.label}</button>)}
      </div>
      <span className="spacer" />
      <div className="row zoom-ctl">
        <button className="btn small ghost" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.25, w / 2, 200)}>−</button>
        <span className="faint">{Math.round(zoom * 100)}%</span>
        <button className="btn small ghost" aria-label="Zoom in" onClick={() => zoomAt(1.25, w / 2, 200)}>+</button>
      </div>
      <Link to="/garden" className="linkish faint">Classic view</Link>
    </div>
    <div className="world-viewport" ref={viewport}>
      <div className="world" ref={world} style={{ width: WORLD_W }}>
        {backdrop}
        <section className="area area-table" style={{ left: AREAS[0].x, width: AREAS[0].w }} aria-label="Potting table">
          <h2 className="area-title">Potting table</h2>
          {notices}
        </section>
        <section className="area area-garden" style={{ left: AREAS[1].x, width: AREAS[1].w }} aria-label="Garden">{garden}</section>
        <section className="area area-greenhouse" style={{ left: AREAS[2].x, width: AREAS[2].w }} aria-label="Greenhouse">{vase}</section>
      </div>
    </div>
  </div>;
}

/** Sky, ground, the potting table, garden fence and greenhouse frame, drawn behind the areas. */
function WorldBackdrop() {
  const T = AREAS[0], G = AREAS[1], H = AREAS[2];
  return <svg className="world-backdrop" width={WORLD_W} height="2400" aria-hidden>
    <defs>
      <linearGradient id="w-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--sky-top)" /><stop offset="1" stopColor="var(--sky-bottom)" /></linearGradient>
      <pattern id="w-grass" width="40" height="40" patternUnits="userSpaceOnUse"><rect width="40" height="40" fill="var(--grass)" /><path d="M8 30l3-8 3 8M26 18l2-6 2 6" stroke="var(--grass-dark)" strokeWidth="1.5" fill="none" /></pattern>
    </defs>
    <rect width={WORLD_W} height="260" fill="url(#w-sky)" />
    <rect y="240" width={WORLD_W} height="2160" fill="url(#w-grass)" opacity=".55" />
    {/* potting table */}
    <rect x={T.x + 30} y="80" width={T.w - 60} height="16" rx="6" fill="var(--wood)" />
    <rect x={T.x + 60} y="96" width="18" height="140" fill="var(--wood-dark)" /><rect x={T.x + T.w - 78} y="96" width="18" height="140" fill="var(--wood-dark)" />
    {/* garden fence */}
    {Array.from({ length: Math.floor(G.w / 60) + 1 }, (_, i) => <rect key={i} x={G.x + i * 60} y="150" width="12" height="90" rx="5" fill="var(--wood)" opacity=".8" />)}
    <rect x={G.x} y="175" width={G.w + 12} height="8" fill="var(--wood)" opacity=".8" /><rect x={G.x} y="210" width={G.w + 12} height="8" fill="var(--wood)" opacity=".8" />
    {/* greenhouse frame with a see-through roof */}
    <path d={`M${H.x} 230 L${H.x + H.w / 2} 40 L${H.x + H.w} 230`} fill="var(--glass)" stroke="var(--frame)" strokeWidth="6" strokeLinejoin="round" />
    {Array.from({ length: 7 }, (_, i) => <path key={i} d={`M${H.x + H.w / 2} 40 L${H.x + (H.w / 6) * i} 230`} stroke="var(--frame)" strokeWidth="2" opacity=".5" />)}
    <rect x={H.x} y="230" width={H.w} height="2170" fill="var(--glass)" stroke="var(--frame)" strokeWidth="6" />
  </svg>;
}
