/* wt.js — walkthrough helper library.
 *
 * Inlined into the bundle rather than linked, so a built walkthrough is frozen:
 * it keeps behaving the way it did on the day it was built even after this
 * library changes. Classic script — available as window.WT before any module
 * script runs.
 */
(function (global) {
  'use strict';

  var WT = {};

  // --- Host protocol -------------------------------------------------------
  // The page runs in an opaque origin (sandbox without allow-same-origin), so
  // it cannot reach the app's DOM, storage or API. These four messages are the
  // entire vocabulary; the host validates the shape of every one and ignores
  // anything else.

  function post(msg) {
    try { global.parent.postMessage(msg, '*'); } catch (e) { /* detached */ }
  }

  WT.ready = function () { post({ type: 'ready' }); };
  WT.error = function (message) { post({ type: 'error', message: String(message) }); };
  /** Ask the host's PDF viewer to jump to a page. Ignored if out of range. */
  WT.gotoPage = function (page) {
    var n = Number(page);
    if (Number.isInteger(n) && n > 0) post({ type: 'gotoPage', page: n });
  };

  // --- Theme ---------------------------------------------------------------
  // CSS custom properties do not cross an iframe boundary, so the host sends
  // its resolved palette and we paint it onto our own :root. The defaults below
  // are the app's light theme, so the page looks right before that arrives.

  var DEFAULT_THEME = {
    '--mono-surface-paper': '#fffef9',
    '--mono-surface-chrome': '#faf8f4',
    '--mono-surface-sunken': '#f3f0ea',
    '--mono-line': '#e2ddd3',
    '--mono-line-strong': '#cdc6b8',
    '--mono-text': '#2c2820',
    '--mono-text-muted': '#6b6358',
    '--mono-text-faint': '#9e9588',
    '--mono-accent': '#8b5e3c',
    '--mono-accent-hover': '#b07d56',
    '--mono-cat-2': '#3d6b8e',
    '--mono-cat-3': '#7a5a99',
    '--mono-cat-4': '#3d8080',
    '--mono-cat-5': '#b07830',
    '--mono-cat-6': '#b04a4a'
  };

  WT.applyTheme = function (vars) {
    var root = document.documentElement;
    var merged = Object.assign({}, DEFAULT_THEME, vars || {});
    Object.keys(merged).forEach(function (k) {
      if (typeof merged[k] === 'string' && merged[k]) root.style.setProperty(k, merged[k]);
    });
    WT.colors = {
      text: css('--mono-text'), muted: css('--mono-text-muted'),
      faint: css('--mono-text-faint'), line: css('--mono-line-strong'),
      accent: css('--mono-accent'), surface: css('--mono-surface-paper'),
      series: ['--mono-accent', '--mono-cat-2', '--mono-cat-3', '--mono-cat-4',
               '--mono-cat-5', '--mono-cat-6'].map(css)
    };
    if (WT._onTheme) WT._onTheme(WT.colors);
  };

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  WT.css = css;
  /** Register a redraw hook so canvases repaint when the host's theme flips. */
  WT.onTheme = function (fn) { WT._onTheme = fn; };

  global.addEventListener('message', function (e) {
    if (e.source !== global.parent) return;
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'theme' && msg.vars && typeof msg.vars === 'object') WT.applyTheme(msg.vars);
    else if (msg.type === 'setScene' && Number.isInteger(msg.index) && WT._stepper) {
      WT._stepper.go(msg.index);
    }
  });

  // --- Scene stepper -------------------------------------------------------

  /**
   * Build the scene chrome: one section per scene, prev/next, dots, arrow keys.
   * `scenes` is [{ title, render(el) }]; render is called once, lazily.
   */
  WT.scenes = function (container, scenes) {
    var index = -1;
    var built = [];

    var nav = document.createElement('div');
    nav.className = 'wt-nav';
    var prev = document.createElement('button');
    prev.className = 'wt-btn'; prev.type = 'button'; prev.textContent = '← Prev';
    var next = document.createElement('button');
    next.className = 'wt-btn'; next.type = 'button'; next.textContent = 'Next →';
    var dots = document.createElement('div');
    dots.className = 'wt-dots';
    var counter = document.createElement('span');
    counter.className = 'wt-counter';

    scenes.forEach(function (s, i) {
      var dot = document.createElement('button');
      dot.className = 'wt-dot'; dot.type = 'button';
      dot.setAttribute('aria-label', 'Scene ' + (i + 1) + ': ' + (s.title || ''));
      dot.title = s.title || ('Scene ' + (i + 1));
      dot.addEventListener('click', function () { go(i); });
      dots.appendChild(dot);
    });

    nav.appendChild(prev); nav.appendChild(dots); nav.appendChild(counter); nav.appendChild(next);

    var stage = document.createElement('div');
    stage.className = 'wt-stage';
    container.appendChild(stage);
    container.appendChild(nav);

    function go(i) {
      if (i < 0 || i >= scenes.length || i === index) return;
      index = i;
      for (var k = 0; k < built.length; k++) if (built[k]) built[k].hidden = true;
      if (!built[i]) {
        var el = document.createElement('section');
        el.className = 'wt-scene';
        var h = document.createElement('h2');
        h.className = 'wt-scene-title';
        h.textContent = scenes[i].title || '';
        el.appendChild(h);
        var body = document.createElement('div');
        el.appendChild(body);
        stage.appendChild(el);
        built[i] = el;
        try {
          scenes[i].render(body);
        } catch (err) {
          body.appendChild(WT.fallback('This scene failed to start: ' + err.message));
          WT.error('Scene ' + (i + 1) + ' failed: ' + err.message);
        }
      }
      built[i].hidden = false;
      prev.disabled = i === 0;
      next.disabled = i === scenes.length - 1;
      counter.textContent = (i + 1) + ' / ' + scenes.length;
      Array.prototype.forEach.call(dots.children, function (d, k) {
        d.className = 'wt-dot' + (k === i ? ' wt-dot-active' : '');
      });
      stage.scrollTop = 0;
      WT.typeset(built[i]);
    }

    prev.addEventListener('click', function () { go(index - 1); });
    next.addEventListener('click', function () { go(index + 1); });
    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') go(index - 1);
      else if (e.key === 'ArrowRight') go(index + 1);
    });

    var api = { go: go, count: scenes.length, current: function () { return index; } };
    WT._stepper = api;
    go(0);
    return api;
  };

  // --- Controls ------------------------------------------------------------

  /** Labelled range input with a live value readout. Returns the wrapper element. */
  WT.slider = function (opts) {
    var wrap = document.createElement('label');
    wrap.className = 'wt-control';
    var name = document.createElement('span');
    name.className = 'wt-control-label';
    name.textContent = opts.label || '';
    var input = document.createElement('input');
    input.type = 'range';
    input.min = opts.min; input.max = opts.max;
    input.step = opts.step != null ? opts.step : 'any';
    input.value = opts.value;
    var out = document.createElement('output');
    out.className = 'wt-control-value';

    var fmt = opts.format || function (v) {
      return Math.abs(v) >= 100 || v === Math.round(v) ? String(v) : v.toFixed(2);
    };
    function emit() {
      var v = parseFloat(input.value);
      out.textContent = fmt(v);
      if (opts.onInput) opts.onInput(v);
    }
    input.addEventListener('input', emit);
    wrap.appendChild(name); wrap.appendChild(input); wrap.appendChild(out);
    out.textContent = fmt(parseFloat(input.value));
    if (opts.onInput) opts.onInput(parseFloat(input.value));
    wrap.input = input;
    wrap.set = function (v) { input.value = v; emit(); };
    return wrap;
  };

  WT.button = function (label, onClick) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'wt-btn'; b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  WT.controls = function () {
    var row = document.createElement('div');
    row.className = 'wt-controls';
    for (var i = 0; i < arguments.length; i++) row.appendChild(arguments[i]);
    return row;
  };

  /** A labelled static state — what every visual must degrade to. */
  WT.fallback = function (text) {
    var el = document.createElement('div');
    el.className = 'wt-fallback';
    el.textContent = text;
    return el;
  };

  WT.caption = function (text) {
    var el = document.createElement('p');
    el.className = 'wt-caption';
    el.textContent = text;
    return el;
  };

  // --- 2D plotting ---------------------------------------------------------

  /**
   * A hidpi canvas with linear axes. Returns { canvas, ctx, x, y, clear, axes }
   * where x()/y() map data coordinates to device pixels.
   */
  WT.canvas2d = function (opts) {
    var width = opts.width || 560, height = opts.height || 320;
    var pad = Object.assign({ l: 48, r: 16, t: 16, b: 40 }, opts.pad);
    var canvas = document.createElement('canvas');
    canvas.className = 'wt-canvas';
    var dpr = global.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = '100%';
    canvas.style.maxWidth = width + 'px';
    canvas.style.aspectRatio = width + ' / ' + height;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var xr = opts.xRange || [0, 1], yr = opts.yRange || [0, 1];
    function x(v) { return pad.l + ((v - xr[0]) / (xr[1] - xr[0])) * (width - pad.l - pad.r); }
    function y(v) { return height - pad.b - ((v - yr[0]) / (yr[1] - yr[0])) * (height - pad.t - pad.b); }

    function clear() { ctx.clearRect(0, 0, width, height); }

    function axes(cfg) {
      cfg = cfg || {};
      var c = WT.colors || {};
      ctx.save();
      ctx.strokeStyle = c.line || '#cdc6b8';
      ctx.fillStyle = c.muted || '#6b6358';
      ctx.lineWidth = 1;
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';

      var ticksX = cfg.ticksX || niceTicks(xr[0], xr[1], 5);
      var ticksY = cfg.ticksY || niceTicks(yr[0], yr[1], 4);

      ctx.beginPath();
      ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, height - pad.b);
      ctx.lineTo(width - pad.r, height - pad.b);
      ctx.stroke();

      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ticksX.forEach(function (t) {
        var px = x(t);
        ctx.beginPath(); ctx.moveTo(px, height - pad.b); ctx.lineTo(px, height - pad.b + 4); ctx.stroke();
        ctx.fillText(fmtTick(t), px, height - pad.b + 7);
      });
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ticksY.forEach(function (t) {
        var py = y(t);
        ctx.beginPath(); ctx.moveTo(pad.l - 4, py); ctx.lineTo(pad.l, py); ctx.stroke();
        ctx.fillText(fmtTick(t), pad.l - 7, py);
      });

      if (cfg.xLabel) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(cfg.xLabel, (pad.l + width - pad.r) / 2, height - 2);
      }
      if (cfg.yLabel) {
        ctx.save();
        ctx.translate(11, (pad.t + height - pad.b) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(cfg.yLabel, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    }

    /** Plot f over the x range as a stroked path. */
    function curve(f, style) {
      ctx.save();
      ctx.strokeStyle = style && style.color ? style.color : (WT.colors ? WT.colors.accent : '#8b5e3c');
      ctx.lineWidth = style && style.width ? style.width : 2;
      if (style && style.dash) ctx.setLineDash(style.dash);
      ctx.beginPath();
      var steps = (style && style.steps) || 240, started = false;
      for (var i = 0; i <= steps; i++) {
        var vx = xr[0] + (i / steps) * (xr[1] - xr[0]);
        var vy = f(vx);
        if (!isFinite(vy)) { started = false; continue; }
        var py = y(vy);
        if (!started) { ctx.moveTo(x(vx), py); started = true; } else { ctx.lineTo(x(vx), py); }
      }
      ctx.stroke();
      ctx.restore();
    }

    return { canvas: canvas, ctx: ctx, x: x, y: y, clear: clear, axes: axes, curve: curve,
             width: width, height: height, pad: pad,
             setRanges: function (nx, ny) { if (nx) xr = nx; if (ny) yr = ny; } };
  };

  function niceTicks(lo, hi, count) {
    var span = hi - lo;
    if (!(span > 0)) return [lo];
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = (span / count) / step;
    if (err >= 7.5) step *= 10; else if (err >= 3) step *= 5; else if (err >= 1.5) step *= 2;
    var out = [], t = Math.ceil(lo / step) * step;
    for (; t <= hi + step * 1e-9; t += step) out.push(Math.round(t / step) * step);
    return out;
  }
  function fmtTick(t) {
    if (t === 0) return '0';
    var a = Math.abs(t);
    if (a >= 1e4 || a < 1e-3) return t.toExponential(0);
    return String(Math.round(t * 1e6) / 1e6);
  }
  WT.niceTicks = niceTicks;

  // --- WebGL ---------------------------------------------------------------

  /** Every visual must degrade to a labelled static state if WebGL is missing. */
  WT.hasWebGL = function () {
    try {
      var c = document.createElement('canvas');
      return !!(global.WebGLRenderingContext &&
                (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  };

  // --- Math ----------------------------------------------------------------
  // MathJax is vendored and served from the app, never a CDN — the CSP forbids
  // the alternative anyway. It is configured with the menu and assistive-MathML
  // off so it never attempts a runtime component fetch, which connect-src 'none'
  // would block silently.

  var mathPromise = null;
  WT.mathReady = function () {
    if (mathPromise) return mathPromise;
    mathPromise = new Promise(function (resolve) {
      global.MathJax = {
        tex: { inlineMath: [['$', '$'], ['\\(', '\\)']],
               displayMath: [['$$', '$$'], ['\\[', '\\]']] },
        // 'local', not 'global'. With 'global' MathJax keeps every glyph path in
        // one body-level <svg id="MJX-SVG-global-cache"> and each equation only
        // carries <use> references into it. That cache sits outside every
        // scroll container we own, so when it paints — as it did — the glyphs
        // land on top of the page at raw font coordinates and nothing clips
        // them. 'local' inlines each equation's <defs> into its own <svg>, so an
        // equation is self-contained and there is no shared element to go wrong.
        // Costs ~7 KB per equation, which is nothing against a 2 MB MathJax.
        svg: { fontCache: 'local' },
        options: { enableMenu: false },
        // Load nothing beyond the bundled component, and if anything ever tries,
        // resolve it against our own origin rather than a CDN the CSP would
        // block. (MathJax 4 fetched font chunks from jsDelivr here and aborted
        // typesetting when they were refused.)
        loader: { load: [], paths: { mathjax: '/api/walkthrough/asset' } },
        startup: { typeset: false, ready: function () {
          global.MathJax.startup.defaultReady();
          resolve(global.MathJax);
        } }
      };
      var s = document.createElement('script');
      s.src = '/api/walkthrough/asset/mathjax-tex-svg.js';
      s.async = true;
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return mathPromise;
  };

  /**
   * Resolve once the document actually has a box.
   *
   * MathJax sizes its SVG output from measured font metrics — `nodeSize()` reads
   * `offsetWidth`/`offsetHeight` off test nodes. Inside a zero-size subtree,
   * which is exactly what this page is while its host pane is `display: none`,
   * those measure 0, the derived `ex` collapses toward zero, and every equation
   * comes out with an enormous `ex` width that the viewBox then scales the
   * glyphs up to fill. The symptom is giant glyphs sprawling across the page,
   * and it only ever affects whatever was typeset before the pane was revealed.
   *
   * There is deliberately no timeout: if the page is never shown, waiting
   * forever costs nothing and nobody sees the untypeset source, whereas giving
   * up and typesetting anyway would reproduce the bug.
   */
  function whenSized() {
    if (document.documentElement.clientWidth > 0) return Promise.resolve();
    return new Promise(function (resolve) {
      if (typeof ResizeObserver !== 'function') { resolve(); return; }
      var ro = new ResizeObserver(function () {
        if (document.documentElement.clientWidth > 0) { ro.disconnect(); resolve(); }
      });
      ro.observe(document.documentElement);
    });
  }

  /** Typeset any TeX inside `root`. Safe to call on a subtree with no math. */
  WT.typeset = function (root) {
    var el = root || document.body;
    if (!/[$\\]/.test(el.textContent || '')) return Promise.resolve();
    return whenSized()
      .then(function () { return WT.mathReady(); })
      .then(function (mj) {
        if (!mj) return;
        return mj.typesetPromise([el]).catch(function () { /* leave the source visible */ });
      });
  };

  /** A display equation element. `latex` is raw TeX without delimiters. */
  WT.equation = function (latex, label) {
    var wrap = document.createElement('div');
    wrap.className = 'wt-equation';
    var body = document.createElement('div');
    body.textContent = '\\[' + latex + '\\]';
    wrap.appendChild(body);
    if (label) {
      var tag = document.createElement('span');
      tag.className = 'wt-equation-label';
      tag.textContent = label;
      wrap.appendChild(tag);
    }
    return wrap;
  };

  // --- Figures -------------------------------------------------------------

  /** A raster figure copied into the bundle directory, with its caption. */
  WT.figure = function (src, caption) {
    var fig = document.createElement('figure');
    fig.className = 'wt-figure';
    var img = document.createElement('img');
    img.src = src; img.loading = 'lazy'; img.alt = caption || '';
    fig.appendChild(img);
    if (caption) {
      var cap = document.createElement('figcaption');
      cap.textContent = caption;
      fig.appendChild(cap);
    }
    return fig;
  };

  WT.applyTheme({});
  global.WT = WT;
})(window);
