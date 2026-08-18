// Verification harness for automatic PDF margin trimming (auto-crop).
//
// Runs unit-level checks against the pure detection core in
// client/src/utils/autoTrim.ts, which needs no pdf.js, no canvas and no PDF:
// `detectContentCrop` takes raw RGBA pixels and `aggregateCrops` takes measured
// boxes, so synthetic pages exercise every decision the feature makes.
//
// The property that matters most is checked directly: the document-wide box must
// never cut into a page it measured (see aggregateCrops' comment for why that is
// the guarantee this app wants, unlike Scribe).
//
// Run:  npm run verify:autotrim --prefix server
// Exits non-zero if any check fails.

import { detectContentCrop, aggregateCrops } from '../../client/src/utils/autoTrim';
import type { CropBox } from '../../client/src/types';

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function near(actual: number, expected: number, msg: string, eps = 0.015) {
  ok(Math.abs(actual - expected) < eps, `${msg} (got ${actual.toFixed(4)}, want ~${expected})`);
}

const W = 800;
const H = 1000;

interface PageSpec {
  /** Content box as fractions of the page, [left, top, right, bottom] insets. */
  inset?: { left: number; top: number; right: number; bottom: number };
  /** Ink polarity: dark text on a light page, or the inverse (a dark scan). */
  invert?: boolean;
  /** A speck of dirt in the top-left margin, `size` pixels square. */
  dust?: number;
  /** Draw nothing at all. */
  blank?: boolean;
  /** A rotated marginal stamp (arXiv's ID banner), as fractions of the page:
   *  where it starts, how thick, how tall, and on which side. */
  stamp?: { at: number; thickness: number; height: number; side?: 'left' | 'right' };
}

/** Render a synthetic page of ruled "text lines" into RGBA pixels. */
function page(spec: PageSpec): Uint8ClampedArray {
  const bg = spec.invert ? 15 : 255;
  const fg = spec.invert ? 240 : 20;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = bg;
    data[i * 4 + 3] = 255;
  }
  const put = (x: number, y: number, v: number) => {
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
  };
  if (!spec.blank) {
    const ins = spec.inset ?? { left: 0.12, top: 0.10, right: 0.12, bottom: 0.15 };
    const x0 = Math.round(W * ins.left);
    const x1 = Math.round(W * (1 - ins.right));
    const y0 = Math.round(H * ins.top);
    const y1 = Math.round(H * (1 - ins.bottom));
    for (let y = y0; y <= y1 - 6; y += 20) {
      for (let dy = 0; dy < 6; dy++) for (let x = x0; x < x1; x++) put(x, y + dy, fg);
    }
    // Close the content box on the bottom edge so the measurement is exact
    // regardless of where the 20px line rhythm happens to stop.
    for (let dy = 0; dy < 6; dy++) for (let x = x0; x < x1; x++) put(x, y1 - 5 + dy, fg);
  }
  if (spec.dust) {
    for (let x = 4; x < 4 + spec.dust; x++) for (let y = 4; y < 4 + spec.dust; y++) put(x, y, fg);
  }
  if (spec.stamp) {
    const { at, thickness, height, side = 'left' } = spec.stamp;
    const sx = side === 'left' ? Math.round(W * at) : Math.round(W * (1 - at - thickness));
    const sy = Math.round(H * (1 - height) / 2);
    for (let x = sx; x < sx + Math.round(W * thickness); x++) {
      for (let y = sy; y < sy + Math.round(H * height); y++) put(x, y, fg);
    }
  }
  return data;
}

const measure = (spec: PageSpec) => detectContentCrop(page(spec), W, H);

console.log('Content detection\n');

const plain = measure({});
ok(plain !== null, 'an ordinary text page is measurable');
if (plain) {
  // The detector pads outwards by ~0.9% so rounding can never shave a glyph,
  // hence a measured margin slightly under the true inset.
  near(plain.left, 0.12 - 0.009, 'left margin of a 12% inset');
  near(plain.right, 0.12 - 0.009, 'right margin of a 12% inset');
  near(plain.top, 0.10 - 0.009, 'top margin of a 10% inset');
  near(plain.bottom, 0.15 - 0.009, 'bottom margin of a 15% inset');
  ok(plain.left <= 0.12 && plain.top <= 0.10, 'padding only ever loosens the box, never tightens it');
}

const inverted = measure({ invert: true });
ok(inverted !== null, 'a light-on-dark page is measurable (polarity-agnostic)');
if (inverted && plain) {
  near(inverted.left, plain.left, 'inverted page measures the same box as its positive');
}

ok(measure({ blank: true }) === null, 'a blank page is rejected as untrustworthy');
ok(
  measure({ inset: { left: 0.45, top: 0.47, right: 0.45, bottom: 0.47 } }) === null,
  'a page with only a scrap of content (a lone page number) is rejected',
);
ok(
  measure({ inset: { left: 0, top: 0, right: 0, bottom: 0 } })?.left === 0,
  'a full-bleed page measures no margin rather than failing',
);

const speck = measure({ dust: 2 });
if (speck) {
  near(speck.left, 0.12 - 0.009, 'a single-block speck of dust is eroded away');
  near(speck.top, 0.10 - 0.009, 'a single-block speck does not pin the top margin');
}

// A larger speck survives erosion on its own page; the document-wide aggregation
// is the layer that absorbs it (checked below).
const bigSpeck = measure({ dust: 6 });
ok(bigSpeck !== null && bigSpeck.left === 0, 'a large margin blot does defeat a single page');

console.log('\nMarginal stamps (arXiv ID banner)\n');

// arXiv sets the ID down the left margin of page 1 in rotated ~9pt type: a thin,
// tall band well outside the text block. It must not count as content, or that
// one page sets the left margin for the whole document.
const stamped = measure({ stamp: { at: 0.030, thickness: 0.029, height: 0.25 } });
if (stamped) {
  near(stamped.left, 0.12 - 0.009, "the arXiv banner does not open up page 1's left margin");
  near(stamped.right, 0.12 - 0.009, '...and the far side is untouched');
}

// The banner routinely overhangs the text block vertically, so the rows have to
// be counted across the surviving columns rather than the whole page.
const tallStamp = measure({ stamp: { at: 0.030, thickness: 0.029, height: 0.9 } });
if (tallStamp) {
  near(tallStamp.top, 0.10 - 0.009, 'a banner taller than the text block does not pin the top');
  near(tallStamp.bottom, 0.15 - 0.009, '...nor the bottom');
}

// Narrow margins leave the banner almost touching the body — the tight end of
// what this library actually contains (measured gaps run 0.008 to 0.16).
const tightStamp = measure({
  inset: { left: 0.075, top: 0.10, right: 0.075, bottom: 0.15 },
  stamp: { at: 0.030, thickness: 0.029, height: 0.25 },
});
near(tightStamp!.left, 0.075 - 0.009, 'a banner nearly touching the text block is still separable');

const rightStamp = measure({ stamp: { at: 0.030, thickness: 0.029, height: 0.25, side: 'right' } });
near(rightStamp!.right, 0.12 - 0.009, 'a stamp in the right margin is dropped the same way');

// The three ways real content in the margin differs from a stamp; each must be
// kept, since dropping it would clip the page.
const wideBleed = measure({ inset: { left: 0.02, top: 0.10, right: 0.12, bottom: 0.15 } })!;
near(wideBleed.left, 0.02 - 0.009, 'a figure reaching the margin is too thick to be a stamp');

const thickBand = measure({ stamp: { at: 0.03, thickness: 0.10, height: 0.5 } })!;
ok(thickBand.left < 0.04, 'a band thicker than a line of type is kept (it is not rotated text)');

const shortBand = measure({ stamp: { at: 0.03, thickness: 0.029, height: 0.10 } })!;
ok(shortBand.left < 0.04, 'a short blot in the margin is kept (a stamp is far taller than wide)');

// Stamp-shaped, but too far into the page to be in anyone's margin — a rule or a
// rotated axis label belonging to the layout.
const inboard = measure({
  inset: { left: 0.30, top: 0.10, right: 0.12, bottom: 0.15 },
  stamp: { at: 0.18, thickness: 0.029, height: 0.25 },
})!;
near(inboard.left, 0.18 - 0.009, 'a thin tall band away from the page edge is kept');

console.log('\nDocument-wide aggregation\n');

const body = plain!;
const wideFigure = measure({ inset: { left: 0.04, top: 0.10, right: 0.04, bottom: 0.15 } })!;
const shortPage = measure({ inset: { left: 0.12, top: 0.10, right: 0.12, bottom: 0.40 } })!;

const box = aggregateCrops([body, body, body, body, wideFigure, shortPage]);
near(box.left, wideFigure.left, 'the box opens up to fit the widest page');
near(box.bottom, body.bottom, 'a page with a short text block does not loosen the bottom');

// The guarantee: no measured page is ever clipped.
const noClip = (b: CropBox, pages: CropBox[]) =>
  pages.every(p => b.top <= p.top && b.right <= p.right && b.bottom <= p.bottom && b.left <= p.left);
const bleedLeft = measure({ inset: { left: 0, top: 0.10, right: 0.12, bottom: 0.15 } })!;
const document = [body, body, wideFigure, shortPage, bleedLeft, body];
const documentBox = aggregateCrops(document);
ok(noClip(documentBox, document), 'the document box clips no page it measured');
ok(
  documentBox.left === 0,
  'one page bleeding off the left disables trimming on that side (the accepted cost of never clipping)',
);
ok(documentBox.top > 0 && documentBox.right > 0, '...while the other sides keep trimming');

// The whole point of the stamp rule: a paper is one stamped first page plus a
// body, and the box is the smallest margin of any page.
const paper = [stamped!, body, body, body];
near(
  aggregateCrops(paper).left,
  body.left,
  "a stamped first page no longer sets the paper's left margin",
);

const empty = aggregateCrops([]);
ok(
  empty.top === 0 && empty.right === 0 && empty.bottom === 0 && empty.left === 0,
  'a document with nothing measurable trims nothing',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
