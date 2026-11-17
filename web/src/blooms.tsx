import { SHAPES, PATTERNS, colorName, type Genome } from "../../shared/genome";
import { Flower, Link, fmtDuration } from "./lib";

export interface Bloom {
  id: string; genome: Genome; species: string; rarity: string; score: number; origin: string; generation: number;
  parents: string[] | null; state: string; itemId: string | null; pollenReadyAt: number | null; createdAt: number;
  grower?: string; owner?: string | null;
}

export function RarityTag({ r }: { r: string }) {
  return <span className={"rar " + r}>{r}</span>;
}

export function BloomCard({ b, selected, onClick, to, extra }: { b: Bloom; selected?: boolean; onClick?: () => void; to?: string; extra?: React.ReactNode }) {
  const inner = <>
    <span className="tag"><RarityTag r={b.rarity} /></span>
    <Flower genome={b.genome} uid={"c" + b.id} />
    <div className="nm">{b.species}</div>
    {extra}
  </>;
  if (to) return <Link to={to} className="card bloom">{inner}</Link>;
  return <div className={"card bloom" + (selected ? " sel" : "")} onClick={onClick} role="button" tabIndex={0}
    aria-pressed={selected} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick?.())}>{inner}</div>;
}

const CENTRES = ["Button", "Seeded", "Starburst", "Target"];
export function Traits({ g, b, now }: { g: Genome; b?: Bloom; now?: number }) {
  const sw = (h: number, s: number, l: number) => <span className="swatch" style={{ background: `hsl(${h} ${s}% ${l}%)` }} />;
  return <dl className="traits">
    <dt>Colour</dt><dd>{sw(g.hue, g.sat, g.lum)}{colorName(g)}</dd>
    <dt>Form</dt><dd>{SHAPES[g.shape]}, {g.petals} petals{g.layers > 1 ? ` × ${g.layers} layers` : ""}</dd>
    <dt>Pattern</dt><dd>{PATTERNS[g.pattern] ? <>{sw(g.hue2, g.sat, g.lum)}{PATTERNS[g.pattern]}</> : "Plain"}</dd>
    <dt>Centre</dt><dd>{sw(g.centerHue, 70, 48)}{CENTRES[g.center]}</dd>
    {(g.glow || g.iridescent) && <><dt>Rare traits</dt><dd>{[g.glow && "Luminous", g.iridescent && "Opaline"].filter(Boolean).join(", ")}</dd></>}
    {b && <><dt>Generation</dt><dd>{b.generation === 0 ? `Wild${b.origin === "packet" ? " (packet)" : ""}` : `Hybrid, gen ${b.generation}`}</dd></>}
    {b?.pollenReadyAt && now && b.pollenReadyAt > now && <><dt>Pollen</dt><dd>ready in {fmtDuration(b.pollenReadyAt - now)}</dd></>}
  </dl>;
}
