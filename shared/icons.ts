import { colorName, type Genome } from "./genome.ts";

/** Item icons are made per flower form and colour family; this is the lookup key. */
export const iconKey = (g: Pick<Genome, "shape" | "hue" | "sat" | "lum">) => `${g.shape}-${colorName(g).toLowerCase()}`;
