// Apply helper-library fixes to walkthrough bundles that were already built.
//
// `wt.js` and `wt.css` are **inlined** into each bundle so a built walkthrough is
// frozen against later helper changes. That is right for behaviour and wrong for
// bugs: every helper fix then has to be carried to each stored artifact by hand,
// and rebuilding is not an option — a build costs minutes and dollars, and the
// bundle is the thing the user paid for.
//
// So: named, idempotent migrations, each guarded so re-running is a no-op, and
// every result re-checked with the same authoritative validators that gate a
// fresh build. A bundle that would fail those is left untouched.
//
// Run:  npm run migrate:bundles --prefix server           (report only)
//       npm run migrate:bundles --prefix server -- --apply
//
// A backup is written beside each bundle before it is changed.

import fs from 'fs';
import path from 'path';

interface Migration {
  name: string;
  /** True when this bundle still needs the fix. */
  applies: (html: string) => boolean;
  /** Returns the migrated html, or null when the expected text was not found. */
  run: (html: string) => string | null;
}

/** Replace `from` with `to`, or return null so the caller can report a miss. */
function replaceOnce(html: string, from: string, to: string): string | null {
  return html.includes(from) ? html.replace(from, to) : null;
}

/**
 * The same edit against several source shapes, first match wins.
 *
 * Bundles on disk are not all byte-identical even where they are semantically
 * current: an earlier migration rewrote `WT.typeset` into a differently
 * indented, differently chained form than a fresh build emits, so a later
 * migration of the same function meets two shapes. Listing them beats a loose
 * regex — an exact string that fails is *reported* as a miss, which is how the
 * second shape was noticed at all.
 */
function replaceFirstOf(html: string, variants: { from: string; to: string }[]): string | null {
  for (const variant of variants) {
    if (html.includes(variant.from)) return html.replace(variant.from, variant.to);
  }
  return null;
}

/**
 * The containment half of `typeset-failure-is-loud-and-contained`, shared by
 * both source shapes that migration has to match. Kept byte-identical to the
 * copy in `server/assets/walkthrough/wt.js`, so a migrated bundle and a freshly
 * built one behave the same.
 */
const RETRY_PIECEWISE = `
  function retryPiecewise(mj, el) {
    var blocks = Array.prototype.slice.call(el.querySelectorAll('.wt-equation-body, p, li, figcaption, .wt-control-label'));
    return blocks.reduce(function (chain, block) {
      return chain.then(function () {
        if (!/[$\\\\]/.test(block.textContent || '')) return;
        return mj.typesetPromise([block]).catch(function () { /* this one stays raw */ });
      });
    }, Promise.resolve());
  }`;

const MIGRATIONS: Migration[] = [
  {
    // The tag was absolutely positioned at the right edge. Display maths is
    // centred, so any equation wide enough to reach that edge rendered
    // underneath its own tag. Giving the tag its own grid track makes the
    // overlap structurally impossible instead of width-dependent.
    name: 'equation-label-own-track',
    applies: html => /\.wt-equation-label\s*\{\s*\n?\s*position:\s*absolute/.test(html),
    run: html =>
      replaceOnce(
        html,
        `.wt-equation {
  position: relative; margin: 16px 0; padding: 4px 0;
  overflow-x: auto; overflow-y: hidden;
}
.wt-equation-label {
  position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
  font-family: var(--wt-mono); font-size: 11px; color: var(--mono-text-faint);
}`,
        `.wt-equation {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 14px;
  margin: 16px 0;
}
.wt-equation-body,
.wt-equation > div {
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 6px 0;
}
.wt-equation-label {
  justify-self: end;
  max-width: 34%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--wt-mono);
  font-size: 11px;
  color: var(--mono-text-faint);
}
@media (max-width: 640px) {
  .wt-equation { grid-template-columns: minmax(0, 1fr); }
  .wt-equation-label { max-width: 100%; padding-top: 2px; }
}`
      ),
  },
  {
    // The tag truncates when long, so the full text has to stay reachable.
    name: 'equation-label-tooltip',
    applies: html => html.includes("tag.className = 'wt-equation-label';") && !html.includes('tag.title = label'),
    run: html =>
      replaceOnce(
        html,
        `      tag.className = 'wt-equation-label';
      tag.textContent = label;`,
        `      tag.className = 'wt-equation-label';
      tag.textContent = label;
      tag.title = label;`
      ),
  },
  {
    // MathJax 4 kept every glyph path in one body-level cache and gave each
    // equation only <use> references into it; 'local' inlines each equation's
    // defs so there is no shared element outside every scroll container.
    name: 'mathjax-font-cache-local',
    applies: html => html.includes("fontCache: 'global'"),
    run: html => replaceOnce(html, "fontCache: 'global'", "fontCache: 'local'"),
  },
  {
    // MathJax sizes its SVG from measured font metrics; in a display:none pane
    // those measure 0 and every equation comes out enormous.
    name: 'typeset-waits-for-layout',
    applies: html => html.includes('WT.typeset = function') && !html.includes('whenSized'),
    run: html =>
      replaceOnce(
        html,
        `  WT.typeset = function (root) {
    var el = root || document.body;
    if (!/[$\\\\]/.test(el.textContent || '')) return Promise.resolve();
    return WT.mathReady().then(function (mj) {`,
        `  function whenSized() {
    if (document.documentElement.clientWidth > 0) return Promise.resolve();
    return new Promise(function (resolve) {
      if (typeof ResizeObserver !== 'function') { resolve(); return; }
      var ro = new ResizeObserver(function () {
        if (document.documentElement.clientWidth > 0) { ro.disconnect(); resolve(); }
      });
      ro.observe(document.documentElement);
    });
  }
  WT.typeset = function (root) {
    var el = root || document.body;
    if (!/[$\\\\]/.test(el.textContent || '')) return Promise.resolve();
    return whenSized().then(function () { return WT.mathReady(); }).then(function (mj) {`
      ),
  },
  {
    // `typesetPromise` rejects for the **whole element** if anything in it goes
    // wrong, and the rejection was swallowed — so one unresolvable macro left an
    // entire scene as literal TeX with nothing logged anywhere. That is how a
    // total failure hid across seven builds: MathJax's `autoload` reached for a
    // TeX extension (\boldsymbol, and ML papers are full of them) that the asset
    // route did not serve, the fetch 404'd, and every equation in the scene
    // stayed raw.
    //
    // The route now serves the full TeX build, so nothing is fetched at typeset
    // time and the cause is gone. This carries the two guards that would have
    // caught it into the bundles already on disk: report the rejection through
    // `WT.error` (which the app shows as a notification), then retry block by
    // block so a single bad equation costs one equation instead of the page.
    name: 'typeset-failure-is-loud-and-contained',
    applies: html => html.includes('WT.typeset = function') && !html.includes('retryPiecewise'),
    // Two shapes are in the wild: what a fresh build emits, and what the
    // `typeset-waits-for-layout` migration above rewrote older bundles into
    // (one-line chain, two spaces less indentation). Both are listed rather
    // than matched loosely — an exact string that misses gets *reported*, which
    // is how the second shape was noticed instead of silently skipped.
    run: html =>
      replaceFirstOf(html, [
        {
          from: `        if (!mj) return;
        return mj.typesetPromise([el]).catch(function () { /* leave the source visible */ });
      });
  };`,
          to: `        if (!mj) {
          WT.error('MathJax did not load; equations are showing as raw TeX.');
          return;
        }
        return mj.typesetPromise([el]).catch(function (err) {
          WT.error('Typesetting failed: ' + ((err && err.message) || err));
          return retryPiecewise(mj, el);
        });
      });
  };
${RETRY_PIECEWISE}`,
        },
        {
          from: `      if (!mj) return;
      return mj.typesetPromise([el]).catch(function () { /* leave the source visible */ });
    });
  };`,
          to: `      if (!mj) {
        WT.error('MathJax did not load; equations are showing as raw TeX.');
        return;
      }
      return mj.typesetPromise([el]).catch(function (err) {
        WT.error('Typesetting failed: ' + ((err && err.message) || err));
        return retryPiecewise(mj, el);
      });
    });
  };
${RETRY_PIECEWISE}`,
        },
      ]),
  },
  {
    // The app binds its shortcuts on its own `window`. Clicking anywhere in the
    // bundle moves focus into the iframe, and from then on every keystroke goes
    // to the frame's document instead — so the pane-layout keys that exist to
    // get you back *out* of the walkthrough stopped working precisely once you
    // were using it. The opaque origin means the host cannot listen for them, so
    // the frame has to hand them over explicitly.
    name: 'forward-keystrokes-to-host',
    applies: html => html.includes('WT.gotoPage = function') && !html.includes("type: 'key'"),
    run: html =>
      replaceOnce(
        html,
        `  WT.gotoPage = function (page) {
    var n = Number(page);
    if (Number.isInteger(n) && n > 0) post({ type: 'gotoPage', page: n });
  };`,
        `  WT.gotoPage = function (page) {
    var n = Number(page);
    if (Number.isInteger(n) && n > 0) post({ type: 'gotoPage', page: n });
  };

  document.addEventListener('keydown', function (e) {
    if (!e.isTrusted || e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (typeof e.key !== 'string' || e.key.length !== 1) return;
    var t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    post({ type: 'key', key: e.key });
  });`
      ),
  },
];

(async () => {
  const apply = process.argv.includes('--apply');

  const { DATA_DIR } = await import('../src/services/paths');
  const { scanForExternalOrigins, checkBundleStructure, checkScriptSyntax } = await import(
    '../src/services/walkthrough'
  );

  const root = path.join(DATA_DIR, 'walkthroughs');
  if (!fs.existsSync(root)) {
    console.log('No walkthroughs directory; nothing to migrate.');
    return;
  }

  const bundles: string[] = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (/^bundle-\d+\.html$/.test(file)) bundles.push(path.join(full, file));
    }
  }

  if (bundles.length === 0) {
    console.log('No bundles found.');
    return;
  }

  console.log(`${bundles.length} bundle(s) under ${root}`);
  console.log(apply ? 'Applying migrations.\n' : 'Report only — pass --apply to write.\n');

  let changed = 0;
  let clean = 0;
  let refused = 0;

  for (const file of bundles) {
    const original = fs.readFileSync(file, 'utf8');
    let html = original;
    const done: string[] = [];
    const missed: string[] = [];

    for (const migration of MIGRATIONS) {
      if (!migration.applies(html)) continue;
      const next = migration.run(html);
      if (next === null) {
        missed.push(migration.name);
        continue;
      }
      html = next;
      done.push(migration.name);
    }

    const label = path.relative(root, file);
    if (done.length === 0 && missed.length === 0) {
      clean++;
      console.log(`  ✓ ${label} — already current`);
      continue;
    }

    // The same gate a fresh build has to pass. A migration that would produce an
    // unusable bundle is discarded rather than written.
    const problems = [
      ...scanForExternalOrigins(html).map(o => `external origin ${o}`),
      ...checkBundleStructure(html),
      ...checkScriptSyntax(html),
    ];
    if (problems.length > 0) {
      refused++;
      console.log(`  ✗ ${label} — migration REFUSED: ${problems.join('; ')}`);
      continue;
    }

    changed++;
    console.log(
      `  → ${label} — ${done.join(', ')}${missed.length ? ` (could not locate: ${missed.join(', ')})` : ''}`
    );

    if (apply) {
      fs.writeFileSync(`${file}.bak`, original);
      fs.writeFileSync(file, html);
    }
  }

  console.log(
    `\n${changed} to migrate, ${clean} already current, ${refused} refused` +
      (apply ? ' — written, with .bak beside each.' : ' — nothing written.')
  );
  if (refused > 0) process.exitCode = 1;
})();
