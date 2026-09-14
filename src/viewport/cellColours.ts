/**
 * Shape Builder region colours, shared by the viewport and the region list so
 * the swatch beside a region's name is always the colour it is drawn in.
 *
 * Chosen to stay distinct from one another under transparency and from the
 * teal hover and amber "add back" highlights the tool already uses.
 */
export const CELL_COLOURS = [
  "#4f8fd9", // blue
  "#e0884a", // orange
  "#58b36c", // green
  "#a67bd4", // purple
  "#dd6a8c", // pink
  "#c9a53a", // gold
  "#5aa9b8", // steel teal
  "#9c7a5b", // brown
] as const;

/** Every region's colour when "Colour each region" is off. */
export const CELL_SINGLE_COLOUR = "#43aede";

export function cellColour(index: number, coloured: boolean): string {
  return coloured ? CELL_COLOURS[index % CELL_COLOURS.length] : CELL_SINGLE_COLOUR;
}

/** How Shape Builder draws its regions. */
export interface CellDisplay {
  /** See-through shows regions buried inside others; solid reads shapes best. */
  style: "transparent" | "solid";
  /** Outline draws real edges only; all draws every mesh line, facets included. */
  lines: "outline" | "all" | "none";
  colours: boolean;
  /** Draw removed regions as faint ghosts, or not at all. */
  showRemoved: boolean;
}

export const DEFAULT_CELL_DISPLAY: CellDisplay = {
  style: "transparent",
  lines: "outline",
  colours: true,
  showRemoved: true,
};
