/**
 * Palette and the material -> section-pattern table.
 *
 * Colours are sampled from the reference film at native resolution rather than
 * eyeballed. The pattern table follows drafting convention (ISO 128 / ANSI
 * Y14.2 section lining) — which conveniently solves "how do arbitrary subjects
 * read as different substances" without inventing anything.
 */

export const PALETTE = {
  paper:     '#eaeef2',
  paperHi:   '#f0f3f6',
  surface:   '#dde2ea',
  ink:       '#1b2745',
  inkSoft:   '#5e6b87',
  accent:    '#a82629',
  active:    '#253951',
  grid:      '#d3dde8',
  gridMajor: '#c2cfdd',
  axis:      '#7fae8e',
  label:     '#8792a6',
  /** Dimension lines are drawn in a distinct teal in the reference, not in ink. */
  dim:       '#3d8f7a',
  /** Dash-dot datum and centre lines. */
  datum:     '#7d93ad',
};

/** Shader branch index per material. Must match hatch-material.mjs. */
export const MATERIAL_INDEX = {
  metal: 0,
  casting: 1,
  plastic: 2,
  glass: 3,
  rubber: 4,
  wood: 5,
  concrete: 6,
  masonry: 7,
  liquid: 8,
  insulation: 9,
  fabric: 10,
  earth: 11,
};

/** Human labels, shown in the hover card. */
export const MATERIAL_LABEL = {
  metal: 'machined metal',
  casting: 'casting',
  plastic: 'moulded plastic',
  glass: 'glazing',
  rubber: 'elastomer',
  wood: 'timber',
  concrete: 'concrete',
  masonry: 'masonry',
  liquid: 'fluid',
  insulation: 'insulation',
  fabric: 'fabric',
  earth: 'earth / fill',
};

/**
 * Per-material tone bias. Rubber and earth read dark on a drawing, glass reads
 * near-white; without this every substance lands in the same mid grey.
 */
export const MATERIAL_TONE_BIAS = {
  metal: 1.0, casting: 1.05, plastic: 0.85, glass: 0.35, rubber: 1.35,
  wood: 0.95, concrete: 1.1, masonry: 1.1, liquid: 0.6, insulation: 0.8,
  fabric: 0.9, earth: 1.2,
};

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
