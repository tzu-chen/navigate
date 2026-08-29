import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * The build contract, the helper library and the smoke test — the four files
 * seeded into every build's scratch directory.
 *
 * They are real files in `server/assets/walkthrough/` rather than string
 * literals so they stay readable, syntax-checkable and diffable (the helper is
 * genuine JavaScript; the contract is genuine Markdown). They live in the repo
 * rather than in a setting because they are part of a build's identity:
 * `CONTRACT_VERSION` is their hash and feeds the cache key, so editing any of
 * them correctly invalidates every stored bundle instead of silently mixing
 * outputs built to different rules.
 *
 * The path resolves the same from `src/services` under tsx and from
 * `dist/services` after a build, because both sit two levels under `server/` —
 * the same reasoning `paths.ts` documents for its fallback.
 */

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'walkthrough');

function readAsset(name: string): string {
  return fs.readFileSync(path.join(ASSET_DIR, name), 'utf8');
}

/**
 * The helper library, inlined into every bundle rather than linked, so a built
 * walkthrough is frozen: it keeps behaving the way it did on the day it was
 * built even after this library changes.
 *
 * Deliberately minimal — axes, sliders, a scene stepper, MathJax wiring, theme
 * variables. Too little and every build reinvents axes; too much and generated
 * walkthroughs converge back onto a fixed component vocabulary, which is the
 * thing this feature exists not to be. Grow it from what real builds actually
 * reimplement.
 */
export const HELPER_JS = readAsset('wt.js');
export const HELPER_CSS = readAsset('wt.css');
export const CONTRACT_MD = readAsset('CONTRACT.md');

/**
 * The contract's identity, and part of the build cache key. Changing the
 * contract, the helpers or the smoke test re-keys every future build.
 */
export const CONTRACT_VERSION = crypto
  .createHash('sha256')
  .update(CONTRACT_MD)
  .update(HELPER_JS)
  .update(HELPER_CSS)
  .digest('hex')
  .slice(0, 12);
