// A small pointer-based drag-and-drop layer. HTML5 drag-and-drop doesn't work with touch, so this
// follows the pointer itself, draws a ghost, and finds the drop target under the finger with
// elementFromPoint. Sources can require a short press-and-hold on touch so the page still scrolls.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type Payload =
  | { kind: "seed"; id: string }
  | { kind: "can" }
  | { kind: "fertiliser" }
  | { kind: "bloom"; id: string };

interface Target { accepts: (p: Payload) => boolean; onDrop: (p: Payload) => void }
interface DragState { payload: Payload; ghost: ReactNode; x: number; y: number; over: string | null; tilt: number }

const Ctx = createContext<{
  drag: DragState | null;
  start: (payload: Payload, ghost: ReactNode, x: number, y: number) => void;
  targets: React.MutableRefObject<Map<string, Target>>;
}>(null!);

export function DragProvider({ children }: { children: ReactNode }) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const targets = useRef(new Map<string, Target>());
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const targetAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest("[data-drop]") as HTMLElement | null;
    const key = el?.dataset.drop ?? null;
    const t = key ? targets.current.get(key) : undefined;
    return t && dragRef.current && t.accepts(dragRef.current.payload) ? key : null;
  };

  const start = useCallback((payload: Payload, ghost: ReactNode, x: number, y: number) => {
    setDrag({ payload, ghost, x, y, over: null, tilt: 0 });
    navigator.vibrate?.(8);
  }, []);

  useEffect(() => {
    if (!drag) return;
    // The held item swings with sideways speed and settles when the pointer rests (#11).
    let last = { x: dragRef.current?.x ?? 0, t: performance.now() };
    let settle: number | undefined;
    const move = (e: PointerEvent) => {
      const t = performance.now();
      const vx = (e.clientX - last.x) / Math.max(8, t - last.t);   // px per ms
      last = { x: e.clientX, t };
      const tilt = Math.max(-28, Math.min(28, vx * 14));
      setDrag((d) => d && { ...d, x: e.clientX, y: e.clientY, over: targetAt(e.clientX, e.clientY), tilt: d.tilt * 0.4 + tilt * 0.6 });
      clearTimeout(settle);
      settle = window.setTimeout(() => setDrag((d) => d && { ...d, tilt: 0 }), 90);
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      const key = targetAt(e.clientX, e.clientY);
      setDrag(null);
      if (d && key) targets.current.get(key)?.onDrop(d.payload);
    };
    const cancel = () => setDrag(null);
    // While dragging, a touch must not scroll the page.
    const noScroll = (e: TouchEvent) => e.preventDefault();
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", cancel);
    addEventListener("touchmove", noScroll, { passive: false });
    document.body.classList.add("dragging");
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", cancel);
      removeEventListener("touchmove", noScroll);
      clearTimeout(settle);
      document.body.classList.remove("dragging");
    };
  }, [!!drag]);

  return <Ctx.Provider value={{ drag, start, targets }}>
    {children}
    {drag && <div className="drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden>
      <div className="drag-swing" style={{ transform: `rotate(${drag.tilt.toFixed(1)}deg)` }}>{drag.ghost}</div>
    </div>}
  </Ctx.Provider>;
}

/**
 * Props for a drag source. A tap (no drag) calls onTap. On touch, `hold` ms of press-and-hold
 * starts the drag instead of movement, so sources inside scrolling lists don't block scrolling.
 */
export function useDraggable(payload: Payload, ghost: () => ReactNode, opts: { onTap?: () => void; hold?: number; disabled?: boolean } = {}) {
  const { start } = useContext(Ctx);
  const ref = useRef<{ x: number; y: number; timer?: number; started: boolean; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (opts.disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
    const touchHold = e.pointerType !== "mouse" && opts.hold ? opts.hold : 0;
    const st = { x: e.clientX, y: e.clientY, started: false, id: e.pointerId } as NonNullable<typeof ref.current>;
    ref.current = st;
    const begin = (x: number, y: number) => {
      if (st.started) return;
      st.started = true;
      cleanup();
      start(payload, ghost(), x, y);
    };
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== st.id) return;
      last = { x: ev.clientX, y: ev.clientY };
      const dist = Math.hypot(ev.clientX - st.x, ev.clientY - st.y);
      if (touchHold) { if (dist > 10) cleanup(); return; }   // moved before the hold: it's a scroll
      if (dist > 6) begin(ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== st.id) return;
      const tapped = !st.started && Math.hypot(ev.clientX - st.x, ev.clientY - st.y) < 10;
      cleanup();
      if (tapped) opts.onTap?.();
    };
    const cleanup = () => {
      clearTimeout(st.timer);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", cleanup);
    };
    if (touchHold) st.timer = window.setTimeout(() => begin(last.x, last.y), touchHold);
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", cleanup);
  };
  return {
    onPointerDown,
    onContextMenu: (e: React.MouseEvent) => opts.hold && e.preventDefault(),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onTap?.(); } },
    "data-draggable": opts.hold ? "hold" : "move",
  };
}

/** Register a drop target. Spread the returned props on the element; `state` drives styling. */
export function useDropTarget(key: string, accepts: (p: Payload) => boolean, onDrop: (p: Payload) => void) {
  const { drag, targets } = useContext(Ctx);
  const latest = useRef({ accepts, onDrop });
  latest.current = { accepts, onDrop };
  useEffect(() => {
    targets.current.set(key, { accepts: (p) => latest.current.accepts(p), onDrop: (p) => latest.current.onDrop(p) });
    return () => { targets.current.delete(key); };
  }, [key]);
  const ok = !!drag && accepts(drag.payload);
  return { props: { "data-drop": key }, state: !drag ? "" : drag.over === key ? " drop-over" : ok ? " drop-ok" : " drop-no" };
}

export const useDragging = () => useContext(Ctx).drag;
