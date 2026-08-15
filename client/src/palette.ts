/**
 * Categorical palette — the JS side of `src/styles/monolith-theme.css`.
 *
 * These are the colours the app *stores* rather than the ones it renders chrome
 * with: a tag's colour, a worldline's colour. They are written to the database,
 * so they cannot be CSS variables that flip with the theme — a tag picked in
 * Parchment must keep the same colour in Graphite.
 *
 * The values are `--mono-cat-1…15`, Parchment column. All carry roughly the
 * same perceived weight, so no tag shouts louder than another, and all are dark
 * enough to take `--text-on-accent` as ink when used as a solid fill.
 */

export const CATEGORICAL_PALETTE = [
  '#8b5e3c', // brown
  '#3d6b8e', // blue
  '#7a5a99', // violet
  '#3d8080', // teal
  '#b07830', // amber
  '#b04a4a', // red
  '#6b6358', // neutral
  '#6f7a3d', // olive
  '#a4517a', // rose
  '#4f5a99', // indigo
  '#3d8060', // sea
  '#a06a45', // clay
  '#4a5a6b', // slate
  '#6b4a7a', // plum
  '#5a7a4a', // moss
] as const;

/** The colour a freshly created tag or worldline starts on. */
export const DEFAULT_ENTITY_COLOR: string = CATEGORICAL_PALETTE[0];

export function randomCategorical(): string {
  return CATEGORICAL_PALETTE[Math.floor(Math.random() * CATEGORICAL_PALETTE.length)];
}
