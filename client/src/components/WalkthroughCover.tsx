import { useMemo, type ReactElement } from 'react';
import { WalkthroughVisualKind } from '../types';

/**
 * The card graphic for a walkthrough.
 *
 * There is no screenshot to show: a bundle is a live document that typesets
 * MathJax and may run WebGL, so a gallery of thumbnails would mean a gallery of
 * iframes — several megabytes and several seconds each, for a picture. What the
 * gallery has instead is the *outline*, which says what each scene manipulates,
 * and that is enough to draw from.
 *
 * So the cover is generated: the motif comes from the walkthrough's dominant
 * `visual.kind` (a field of arrows really is a field; a node-link sketch really
 * is a graph), its density from the scene count, and every random choice from a
 * hash of the arXiv id. Deterministic, so a paper's cover never changes under
 * the reader; distinct, so a wall of them is scannable; and honest, in that two
 * papers look alike exactly when their walkthroughs are alike.
 *
 * Colours are CSS custom properties, not literals, so the covers follow the
 * app's theme (including the light schemes) with no work here.
 */

interface Props {
  /** Seeds every random choice; the same paper always draws the same cover. */
  seed: string;
  /** One entry per scene, in order. */
  kinds: WalkthroughVisualKind[];
  /** Dimmed treatment for a walkthrough that was outlined but never built. */
  muted?: boolean;
}

// --- Seeded randomness -------------------------------------------------------

function hashString(text: string): number {
  // FNV-1a. Small, dependency-free, and well spread for short ids.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — a compact, well-distributed PRNG for a fixed 32-bit seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Palette -----------------------------------------------------------------

const CAT_VARS = [
  '--mono-cat-1', '--mono-cat-2', '--mono-cat-3', '--mono-cat-4', '--mono-cat-5',
  '--mono-cat-6', '--mono-cat-8', '--mono-cat-9', '--mono-cat-10', '--mono-cat-11',
  '--mono-cat-12', '--mono-cat-14', '--mono-cat-15',
];

/** Two hues far enough apart in the ring to read as a deliberate pairing. */
function pickPalette(rand: () => number): [string, string] {
  const first = Math.floor(rand() * CAT_VARS.length);
  const step = 4 + Math.floor(rand() * 5);
  const second = (first + step) % CAT_VARS.length;
  return [`var(${CAT_VARS[first]})`, `var(${CAT_VARS[second]})`];
}

// --- Geometry helpers --------------------------------------------------------

const W = 200;
const H = 120;

/** A smooth polyline through sampled points, as an SVG path. */
function polyline(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The kind the cover draws. Scenes with no visual do not get a vote unless
 * every scene is like that — a prose walkthrough is a real thing and gets its
 * own (reading-shaped) motif rather than a misleading chart.
 */
export function dominantKind(kinds: WalkthroughVisualKind[]): WalkthroughVisualKind {
  const counts = new Map<WalkthroughVisualKind, number>();
  for (const kind of kinds) {
    if (kind === 'none') continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  let best: WalkthroughVisualKind = 'none';
  let bestCount = 0;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

// --- Motifs ------------------------------------------------------------------
//
// Each returns raw SVG children. They all draw inside the same 200×120 box and
// leave the bottom 12 units clear for the scene strip.

function plot2dMotif(rand: () => number, scenes: number, a: string, b: string) {
  const curves = clamp(2 + Math.floor(scenes / 3), 2, 4);
  const paths: ReactElement[] = [];
  for (let c = 0; c < curves; c++) {
    const amp = 14 + rand() * 22;
    const freq = 0.9 + rand() * 2.4;
    const phase = rand() * Math.PI * 2;
    const drift = (rand() - 0.5) * 26;
    const points: [number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const x = 26 + t * 158;
      const y = 60 + drift - amp * Math.sin(freq * t * Math.PI + phase) * (0.35 + t * 0.75);
      points.push([x, clamp(y, 12, 96)]);
    }
    paths.push(
      <path
        key={`c${c}`}
        d={polyline(points)}
        fill="none"
        stroke={c % 2 === 0 ? a : b}
        strokeWidth={c === 0 ? 2.1 : 1.3}
        strokeLinecap="round"
        opacity={c === 0 ? 0.95 : 0.55}
      />
    );
  }
  // A couple of read-off markers, which is what a reader actually drags.
  const markers = Array.from({ length: 3 }, (_, i) => {
    const x = 46 + rand() * 130;
    const y = 26 + rand() * 60;
    return <circle key={`m${i}`} cx={x} cy={y} r={2.6} fill={a} opacity={0.9} />;
  });
  return (
    <>
      <path d="M26 100 L26 12" stroke="var(--mono-line-strong)" strokeWidth="1" opacity="0.7" />
      <path d="M26 100 L188 100" stroke="var(--mono-line-strong)" strokeWidth="1" opacity="0.7" />
      {paths}
      {markers}
    </>
  );
}

function fieldMotif(rand: () => number, _scenes: number, a: string, b: string) {
  // A seeded mix of a rotation and a saddle: enough to look like a real flow
  // rather than noise, and different for every paper.
  const rot = (rand() - 0.5) * 2;
  const sad = (rand() - 0.5) * 2;
  const cx = 70 + rand() * 60;
  const cy = 40 + rand() * 30;
  const arrows: ReactElement[] = [];
  for (let ix = 0; ix < 10; ix++) {
    for (let iy = 0; iy < 6; iy++) {
      const x = 18 + ix * 18;
      const y = 14 + iy * 15;
      const dx = x - cx;
      const dy = y - cy;
      let vx = rot * -dy + sad * dx;
      let vy = rot * dx + sad * -dy;
      const mag = Math.hypot(vx, vy) || 1;
      const len = clamp(mag * 0.12, 3, 8);
      vx = (vx / mag) * len;
      vy = (vy / mag) * len;
      arrows.push(
        <line
          key={`${ix}-${iy}`}
          x1={x - vx}
          y1={y - vy}
          x2={x + vx}
          y2={y + vy}
          stroke={mag < 40 ? a : b}
          strokeWidth={1.4}
          strokeLinecap="round"
          opacity={clamp(0.3 + mag / 120, 0.3, 0.95)}
        />
      );
    }
  }
  return (
    <>
      {arrows}
      <circle cx={cx} cy={cy} r={4} fill="none" stroke={a} strokeWidth="1.6" opacity="0.9" />
    </>
  );
}

function graphMotif(rand: () => number, scenes: number, a: string, b: string) {
  const count = clamp(6 + scenes, 7, 13);
  const nodes: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    // A jittered ring keeps every node visible without a layout pass.
    const angle = (i / count) * Math.PI * 2 + rand() * 0.4;
    const radius = 26 + rand() * 20;
    nodes.push([100 + Math.cos(angle) * radius * 1.9, 54 + Math.sin(angle) * radius * 0.95]);
  }
  const edges: ReactElement[] = [];
  for (let i = 0; i < count; i++) {
    const targets = 1 + Math.floor(rand() * 2);
    for (let t = 0; t < targets; t++) {
      const j = Math.floor(rand() * count);
      if (j === i) continue;
      edges.push(
        <line
          key={`e${i}-${t}`}
          x1={nodes[i][0]} y1={nodes[i][1]}
          x2={nodes[j][0]} y2={nodes[j][1]}
          stroke={b}
          strokeWidth={0.9}
          opacity={0.45}
        />
      );
    }
  }
  return (
    <>
      {edges}
      {nodes.map(([x, y], i) => (
        <circle
          key={`n${i}`}
          cx={x} cy={y}
          r={i % 3 === 0 ? 4.4 : 2.8}
          fill={i % 3 === 0 ? a : 'var(--mono-surface-paper)'}
          stroke={a}
          strokeWidth={1.3}
        />
      ))}
    </>
  );
}

function geometryMotif(rand: () => number, scenes: number, a: string, b: string) {
  // Nested rotated polygons plus their chords: a wireframe read, with no
  // projection maths that would look wrong at this size.
  const sides = 5 + Math.floor(rand() * 3);
  const rings = clamp(2 + Math.floor(scenes / 3), 2, 4);
  const shapes: ReactElement[] = [];
  const outer: [number, number][] = [];
  for (let r = 0; r < rings; r++) {
    const scale = 1 - r * (0.22 + rand() * 0.08);
    const spin = rand() * 0.9;
    const points: [number, number][] = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2 + spin;
      points.push([100 + Math.cos(angle) * 62 * scale, 54 + Math.sin(angle) * 40 * scale]);
    }
    if (r === 0) outer.push(...points);
    shapes.push(
      <path
        key={`r${r}`}
        d={`${polyline(points)} Z`}
        fill="none"
        stroke={r === 0 ? a : b}
        strokeWidth={r === 0 ? 1.9 : 1.1}
        strokeLinejoin="round"
        opacity={r === 0 ? 0.95 : 0.55}
      />
    );
  }
  const chords = outer.map((p, i) => (
    <line
      key={`d${i}`}
      x1={p[0]} y1={p[1]}
      x2={outer[(i + 2) % outer.length][0]} y2={outer[(i + 2) % outer.length][1]}
      stroke={b}
      strokeWidth={0.8}
      opacity={0.4}
    />
  ));
  return <>{chords}{shapes}</>;
}

function processMotif(rand: () => number, scenes: number, a: string, b: string) {
  const boxes = clamp(3 + Math.floor(scenes / 3), 3, 4);
  const gap = 12;
  const width = (176 - gap * (boxes - 1)) / boxes;
  const parts: ReactElement[] = [];
  for (let i = 0; i < boxes; i++) {
    const x = 12 + i * (width + gap);
    const height = 34 + rand() * 22;
    const y = 54 - height / 2;
    parts.push(
      <rect
        key={`b${i}`}
        x={x} y={y} width={width} height={height} rx={4}
        fill={i === 0 ? a : 'none'}
        opacity={i === 0 ? 0.16 : 1}
        stroke={i === 0 ? a : b}
        strokeWidth={1.6}
      />
    );
    // Contents, hinted rather than drawn.
    for (let line = 0; line < 3; line++) {
      parts.push(
        <line
          key={`l${i}-${line}`}
          x1={x + 6} y1={y + 10 + line * 8}
          x2={x + width - 6 - rand() * (width * 0.35)} y2={y + 10 + line * 8}
          stroke={b}
          strokeWidth={1.1}
          opacity={0.4}
        />
      );
    }
    if (i < boxes - 1) {
      const ax = x + width;
      parts.push(
        <path
          key={`a${i}`}
          d={`M${ax + 2} 54 L${ax + gap - 3} 54 M${ax + gap - 7} 51 L${ax + gap - 3} 54 L${ax + gap - 7} 57`}
          stroke={a}
          strokeWidth={1.5}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
  }
  return <>{parts}</>;
}

function customMotif(rand: () => number, scenes: number, a: string, b: string) {
  // Layered arcs: the catch-all motif, and the one that reads as "something
  // built for this paper alone" rather than a chart type.
  const bands = clamp(4 + scenes, 5, 9);
  const spread = 0.5 + rand() * 1.1;
  const tilt = rand() * Math.PI;
  const parts: ReactElement[] = [];
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    const radius = 14 + t * 52;
    const start = tilt + t * spread;
    const sweep = 2.0 + rand() * 2.4;
    const points: [number, number][] = [];
    for (let s = 0; s <= 24; s++) {
      const angle = start + (s / 24) * sweep;
      points.push([100 + Math.cos(angle) * radius * 1.5, 56 + Math.sin(angle) * radius * 0.86]);
    }
    parts.push(
      <path
        key={`b${i}`}
        d={polyline(points)}
        fill="none"
        stroke={i % 2 === 0 ? a : b}
        strokeWidth={clamp(2.6 - t * 1.6, 0.9, 2.6)}
        strokeLinecap="round"
        opacity={clamp(0.95 - t * 0.5, 0.4, 0.95)}
      />
    );
  }
  return <>{parts}</>;
}

function proseMotif(rand: () => number, scenes: number, a: string, b: string) {
  // No scene asked for a visual, so the cover says so honestly: a column of
  // prose with a display equation set into it.
  const parts: ReactElement[] = [];
  const rows = clamp(6 + scenes, 7, 11);
  let y = 16;
  for (let i = 0; i < rows; i++) {
    if (i === Math.floor(rows / 2)) {
      parts.push(
        <rect key="eq" x={44} y={y - 4} width={112} height={18} rx={3}
          fill={a} opacity={0.12} stroke={a} strokeWidth={1.2} />
      );
      parts.push(
        <path key="eqg" d={`M56 ${y + 5} L74 ${y + 5} M84 ${y} L84 ${y + 10} M92 ${y + 5} L112 ${y + 5} M122 ${y + 1} L140 ${y + 9}`}
          stroke={a} strokeWidth={1.5} strokeLinecap="round" opacity={0.85} />
      );
      y += 24;
      continue;
    }
    parts.push(
      <line key={`t${i}`} x1={26} y1={y} x2={26 + 118 + rand() * 48} y2={y}
        stroke={b} strokeWidth={1.6} strokeLinecap="round" opacity={0.34} />
    );
    y += 9;
  }
  return <>{parts}</>;
}

const MOTIFS: Record<
  WalkthroughVisualKind,
  (rand: () => number, scenes: number, a: string, b: string) => ReactElement
> = {
  plot2d: plot2dMotif,
  field: fieldMotif,
  graph: graphMotif,
  geometry: geometryMotif,
  process: processMotif,
  custom: customMotif,
  none: proseMotif,
};

// --- The component -----------------------------------------------------------

export default function WalkthroughCover({ seed, kinds, muted = false }: Props) {
  const art = useMemo(() => {
    const rand = makeRandom(hashString(seed));
    const [a, b] = pickPalette(rand);
    const kind = dominantKind(kinds);
    const scenes = kinds.length;
    // A stored outline is normalized server-side, but a cover is not worth
    // crashing the whole gallery over if an unknown kind ever reaches here.
    const motif = MOTIFS[kind] ?? proseMotif;
    return { body: motif(rand, scenes, a, b), accent: a, kind };
  }, [seed, kinds]);

  return (
    <svg
      className={`wtg-cover ${muted ? 'is-muted' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={`${art.kind === 'none' ? 'Prose' : art.kind} walkthrough cover`}
    >
      <rect x="0" y="0" width={W} height={H} fill="var(--mono-surface-sunken)" />
      {art.body}
      {/* One tick per scene: the cover doubles as a length indicator. */}
      <g className="wtg-cover-strip">
        {kinds.map((kind, i) => (
          <rect
            key={i}
            x={12 + i * 9}
            y={109}
            width={6}
            height={3}
            rx={1.5}
            fill={kind === 'none' ? 'var(--mono-text-faint)' : art.accent}
            opacity={kind === 'none' ? 0.5 : 0.85}
          />
        ))}
      </g>
    </svg>
  );
}
