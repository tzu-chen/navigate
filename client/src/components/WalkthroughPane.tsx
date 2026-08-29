import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Walkthrough,
  WalkthroughBuildEvent,
  WalkthroughOutline,
  WalkthroughPaperState,
  WalkthroughScene,
} from '../types';
import * as api from '../services/api';

/**
 * The walkthrough side of the viewer's left pane.
 *
 * Three states matter: no outline yet (offer the cheap pass), an outline that
 * can be read and *edited* before any money is spent (the main quality lever in
 * the feature), and a finished bundle in a sandboxed iframe.
 *
 * The bundle runs in an opaque origin — `allow-scripts` without
 * `allow-same-origin` — so it cannot reach this app's DOM, storage or API
 * session. Everything that crosses the boundary goes through the narrow
 * postMessage protocol below, validated on both ends.
 */

interface Props {
  arxivId: string;
  paperTitle: string;
  /** Drive the PDF viewer beside this pane when a scene says "this is Figure 3". */
  onGotoPage?: (page: number) => void;
  showNotification: (msg: string) => void;
}

/** The theme variables `wt.js` knows how to apply. CSS custom properties do not
 *  cross an iframe boundary, so the palette is sent rather than inherited. */
const THEME_VARS = [
  '--mono-surface-paper', '--mono-surface-chrome', '--mono-surface-sunken',
  '--mono-line', '--mono-line-strong',
  '--mono-text', '--mono-text-muted', '--mono-text-faint',
  '--mono-accent', '--mono-accent-hover',
  '--mono-cat-2', '--mono-cat-3', '--mono-cat-4', '--mono-cat-5', '--mono-cat-6',
];

function readThemeVars(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  return vars;
}

const FITNESS_LABEL: Record<string, string> = {
  strong: 'Strong fit',
  partial: 'Partial fit',
  none: 'Not worth animating',
};

function costLabel(usd: number, backend: string | null): string {
  // '≈' on the CLI backend: that figure is the list-price equivalent of work
  // billed to the Claude Code plan, not money charged to an API account.
  return `${backend === 'cli' ? '≈' : ''}$${usd.toFixed(2)}`;
}

export default function WalkthroughPane({ arxivId, paperTitle, onGotoPage, showNotification }: Props) {
  const [state, setState] = useState<WalkthroughPaperState | null>(null);
  const [selected, setSelected] = useState<Walkthrough | null>(null);
  const [loading, setLoading] = useState(true);
  const [outlining, setOutlining] = useState(false);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WalkthroughOutline | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const abortStream = useRef<(() => void) | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getWalkthroughsForPaper(arxivId);
      setState(data);
      setSelected(data.current);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load walkthroughs');
    } finally {
      setLoading(false);
    }
  }, [arxivId]);

  useEffect(() => {
    setFrameReady(false);
    setProgress([]);
    setEditing(false);
    load();
  }, [load]);

  // Tear the SSE stream down when the pane unmounts or the paper changes.
  useEffect(() => () => abortStream.current?.(), [arxivId]);

  useEffect(() => {
    progressRef.current?.scrollTo({ top: progressRef.current.scrollHeight });
  }, [progress]);

  // --- The postMessage boundary ---------------------------------------------
  //
  // Only three message types are honoured, and only from this pane's own iframe.
  // The frame is in an opaque origin, so its `event.origin` is the string
  // "null" and identity has to be established by comparing the source window —
  // which is the reliable check regardless.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;

      const message = event.data;
      if (!message || typeof message !== 'object') return;

      if (message.type === 'ready') {
        setFrameReady(true);
        frame.contentWindow?.postMessage({ type: 'theme', vars: readThemeVars() }, '*');
      } else if (message.type === 'gotoPage') {
        const page = Number(message.page);
        if (Number.isInteger(page) && page > 0) onGotoPage?.(page);
      } else if (message.type === 'error') {
        showNotification(`Walkthrough: ${String(message.message).slice(0, 200)}`);
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onGotoPage, showNotification]);

  // Repaint the frame when the app's theme changes under it.
  useEffect(() => {
    if (!frameReady) return;
    const observer = new MutationObserver(() => {
      frameRef.current?.contentWindow?.postMessage(
        { type: 'theme', vars: readThemeVars() },
        '*'
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });
    return () => observer.disconnect();
  }, [frameReady]);

  // --- Actions ---------------------------------------------------------------

  async function handleOutline(force = false) {
    if (outlining) return;
    setOutlining(true);
    setError('');
    try {
      const result = await api.outlineWalkthrough(arxivId, force);
      await load();
      setSelected(result);
      if (result.outline?.fitness.verdict === 'none') {
        showNotification('Outlined — this paper has nothing worth animating');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to outline this paper');
    } finally {
      setOutlining(false);
    }
  }

  async function handleBuild(row: Walkthrough, force = false) {
    if (building) return;
    setBuilding(true);
    setError('');
    setProgress([]);
    setActivity('starting…');
    try {
      const response = await api.buildWalkthrough(arxivId, row.id, force);

      if (response.cached && response.walkthrough) {
        setSelected(response.walkthrough);
        await load();
        showNotification('Reused the stored build — identical source and outline');
        setBuilding(false);
        return;
      }
      if (!response.jobId) throw new Error('The server did not start a build.');

      abortStream.current?.();
      abortStream.current = api.streamWalkthroughBuild(response.jobId, {
        onEvent: (event: WalkthroughBuildEvent) => {
          if (event.type === 'stage') {
            setActivity(event.detail ? `${event.stage} — ${event.detail}` : event.stage);
            setProgress(p => [...p, `▸ ${event.stage}${event.detail ? `: ${event.detail}` : ''}`]);
          } else if (event.type === 'tool') {
            setActivity(`${event.name}${event.detail ? ` ${event.detail}` : ''}`);
            setProgress(p => [...p, `  ${event.name}${event.detail ? ` — ${event.detail}` : ''}`]);
          } else if (event.type === 'tool_result') {
            // Only failures are worth a line; a successful result is implied by
            // the next tool call. A refusal, though, is the thing you would
            // otherwise sit and wait through.
            if (!event.ok) {
              setProgress(p => [...p, `  ✗ ${event.detail ?? 'tool call failed'}`]);
            }
          } else if (event.type === 'status') {
            if (event.status === 'queued') setActivity(event.detail ?? 'queued');
          } else if (event.type === 'error') {
            setProgress(p => [...p, `✗ ${event.message}`]);
          }
        },
        onComplete: result => {
          setBuilding(false);
          setActivity('');
          if (result.walkthrough) setSelected(result.walkthrough);
          load();
          if (result.status === 'error') {
            setError(result.walkthrough?.error ?? 'The build failed.');
          } else {
            showNotification('Walkthrough built');
          }
        },
        onError: message => {
          setBuilding(false);
          setError(message);
        },
      });
    } catch (err) {
      setBuilding(false);
      setError(err instanceof Error ? err.message : 'Failed to start the build');
    }
  }

  async function handleSaveOutline() {
    if (!selected || !draft) return;
    try {
      const knownLabels = (selected.outline?.scenes ?? []).flatMap(s => s.equations);
      const saved = await api.saveWalkthroughOutline(selected.id, draft, knownLabels);
      setEditing(false);
      setDraft(null);
      await load();
      setSelected(saved);
      showNotification('Outline saved');
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Failed to save the outline');
    }
  }

  async function handleDelete(row: Walkthrough) {
    if (!confirm('Delete this walkthrough? It cost money to build and cannot be recovered.')) return;
    try {
      await api.deleteWalkthrough(row.id);
      await load();
      showNotification('Walkthrough deleted');
    } catch {
      showNotification('Failed to delete the walkthrough');
    }
  }

  function updateScene(index: number, patch: Partial<WalkthroughScene>) {
    setDraft(d =>
      d ? { ...d, scenes: d.scenes.map((s, i) => (i === index ? { ...s, ...patch } : s)) } : d
    );
  }

  // --- Render ----------------------------------------------------------------

  if (loading) {
    return <div className="wtp-empty">Loading walkthroughs…</div>;
  }

  const outline = editing ? draft : selected?.outline ?? null;

  return (
    <div className="wtp">
      <div className="wtp-header">
        <span className="wtp-title">Walkthrough</span>
        {selected && (
          <span className="wtp-meta" title={statusTooltip(selected, state)}>
            {selected.fitness && (
              <span className={`wtp-fitness wtp-fitness-${selected.fitness}`}>
                {FITNESS_LABEL[selected.fitness]}
              </span>
            )}
            {selected.sourceVersion && <span className="wtp-chip">{selected.sourceVersion}</span>}
            {selected.model && <span className="wtp-chip">{selected.model}</span>}
            {selected.usage.estimated_cost > 0 && (
              <span className="wtp-chip">
                {costLabel(selected.usage.estimated_cost, selected.backend)}
              </span>
            )}
          </span>
        )}
        <span className="wtp-header-spacer" />
        {state && state.all.length > 1 && (
          <button className="btn btn-secondary btn-sm" onClick={() => setShowHistory(h => !h)}>
            {state.all.length} builds
          </button>
        )}
        {selected?.status === 'ready' && !building && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => handleBuild(selected, true)}
            title={`Rebuild from the same outline (up to ${costLabel(state?.budgetUsd ?? 1.5, state?.backend ?? null)})`}
          >
            Rebuild
          </button>
        )}
      </div>

      {showHistory && state && (
        <div className="wtp-history">
          {state.all.map(row => (
            <button
              key={row.id}
              className={`wtp-history-row ${selected?.id === row.id ? 'is-active' : ''}`}
              onClick={() => { setSelected(row); setShowHistory(false); setFrameReady(false); }}
            >
              <span className={`wtp-status wtp-status-${row.status}`}>{row.status}</span>
              <span className="wtp-history-when">{new Date(row.createdAt).toLocaleString()}</span>
              <span className="wtp-history-cost">
                {costLabel(row.usage.estimated_cost, row.backend)}
              </span>
              <span
                className="wtp-history-delete"
                onClick={e => { e.stopPropagation(); handleDelete(row); }}
                title="Delete this build"
              >
                ✕
              </span>
            </button>
          ))}
        </div>
      )}

      {error && <div className="wtp-error">{error}</div>}

      {selected && selected.warnings.length > 0 && selected.status !== 'ready' && (
        <ul className="wtp-warnings">
          {selected.warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}

      {/* No outline yet — offer the cheap pass. */}
      {!selected && !outlining && (
        <div className="wtp-empty">
          <p className="wtp-lede">
            Build an interactive explainer of this paper from its LaTeX source.
          </p>
          <p className="wtp-note">
            The first step reads the paper and proposes a scene outline — cheap, and it
            can come back saying the paper has nothing worth animating, which is a
            correct answer. Nothing is built until you approve the outline.
          </p>
          <button className="btn btn-primary" onClick={() => handleOutline(false)}>
            Read the paper &amp; outline scenes
          </button>
        </div>
      )}

      {outlining && (
        <div className="wtp-empty">
          <p>Reading the paper's LaTeX source…</p>
          <p className="wtp-note">Fetching the source package, distilling it, and asking for an outline.</p>
        </div>
      )}

      {/* Building — the progress log. */}
      {building && (
        <div className="wtp-building">
          <div className="wtp-building-head">
            <span className="wtp-spinner" />
            <span>{activity || 'building…'}</span>
          </div>
          <div className="wtp-progress" ref={progressRef}>
            {progress.map((line, i) => <div key={i} className="wtp-progress-line">{line}</div>)}
          </div>
          <p className="wtp-note">
            Capped at {costLabel(state?.budgetUsd ?? 1.5, state?.backend ?? null)} per build.
            You can leave this pane — the build keeps running.
          </p>
        </div>
      )}

      {/* A finished bundle. */}
      {!building && selected?.status === 'ready' && selected.hasBundle && (
        <div className="wtp-frame-wrap">
          {!frameReady && <div className="wtp-frame-loading">Starting the walkthrough…</div>}
          <iframe
            key={selected.id}
            ref={frameRef}
            className="wtp-frame"
            title={`Walkthrough of ${paperTitle}`}
            src={api.getWalkthroughBundleUrl(selected.id)}
            /* allow-scripts WITHOUT allow-same-origin: the bundle is generated
               code, and this puts it in an opaque origin with no access to the
               app's DOM, storage, cookies or API session. */
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        </div>
      )}

      {/* An outline waiting to be reviewed, edited, and built. */}
      {!building && selected && selected.status !== 'ready' && outline && (
        <div className="wtp-outline">
          <div className="wtp-verdict">
            <strong>{FITNESS_LABEL[outline.fitness.verdict] ?? outline.fitness.verdict}</strong>
            <span> — {outline.fitness.reason}</span>
          </div>

          {editing ? (
            <textarea
              className="wtp-input wtp-thesis-input"
              value={outline.thesis}
              rows={3}
              onChange={e => setDraft(d => (d ? { ...d, thesis: e.target.value } : d))}
            />
          ) : (
            <p className="wtp-thesis">{outline.thesis}</p>
          )}

          <div className="wtp-scenes">
            {outline.scenes.map((scene, i) => (
              <div key={i} className="wtp-scene">
                <div className="wtp-scene-head">
                  <span className="wtp-scene-num">{i + 1}</span>
                  {editing ? (
                    <input
                      className="wtp-input"
                      value={scene.title}
                      onChange={e => updateScene(i, { title: e.target.value })}
                    />
                  ) : (
                    <span className="wtp-scene-title">{scene.title}</span>
                  )}
                  <span className={`wtp-kind wtp-kind-${scene.visual.kind}`}>
                    {scene.visual.kind}
                  </span>
                  {editing && (
                    <button
                      className="wtp-scene-remove"
                      title="Remove this scene"
                      onClick={() =>
                        setDraft(d => (d ? { ...d, scenes: d.scenes.filter((_, k) => k !== i) } : d))
                      }
                    >
                      ✕
                    </button>
                  )}
                </div>

                {editing ? (
                  <>
                    <textarea
                      className="wtp-input"
                      rows={3}
                      value={scene.narration}
                      onChange={e => updateScene(i, { narration: e.target.value })}
                    />
                    <div className="wtp-scene-visual-edit">
                      <select
                        className="wtp-input wtp-select"
                        value={scene.visual.kind}
                        onChange={e =>
                          updateScene(i, {
                            visual: { ...scene.visual, kind: e.target.value as WalkthroughScene['visual']['kind'] },
                          })
                        }
                      >
                        {['none', 'plot2d', 'field', 'graph', 'geometry', 'process', 'custom'].map(k => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
                      <textarea
                        className="wtp-input"
                        rows={2}
                        placeholder="What the reader manipulates, and what they learn by manipulating it"
                        value={scene.visual.spec}
                        onChange={e =>
                          updateScene(i, { visual: { ...scene.visual, spec: e.target.value } })
                        }
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <p className="wtp-scene-narration">{scene.narration}</p>
                    {scene.visual.kind !== 'none' && (
                      <p className="wtp-scene-spec">{scene.visual.spec}</p>
                    )}
                  </>
                )}

                {(scene.equations.length > 0 || scene.sourceRefs.length > 0) && !editing && (
                  <div className="wtp-scene-refs">
                    {scene.equations.map(eq => (
                      <span key={eq} className="wtp-ref-chip">{eq}</span>
                    ))}
                    {scene.sourceRefs.map((ref, k) => (
                      <span
                        key={k}
                        className={`wtp-ref-chip ${ref.page ? 'is-clickable' : ''}`}
                        onClick={() => ref.page && onGotoPage?.(ref.page)}
                        title={ref.page ? `Jump to page ${ref.page}` : undefined}
                      >
                        §{ref.section}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="wtp-actions">
            {editing ? (
              <>
                <button className="btn btn-primary btn-sm" onClick={handleSaveOutline}>
                  Save outline
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => { setEditing(false); setDraft(null); }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => handleBuild(selected)}
                  disabled={outline.scenes.length === 0}
                  title={`Runs an agentic build, capped at ${costLabel(state?.budgetUsd ?? 1.5, state?.backend ?? null)}`}
                >
                  Build walkthrough · up to {costLabel(state?.budgetUsd ?? 1.5, state?.backend ?? null)}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => { setDraft(structuredClone(outline)); setEditing(true); }}
                >
                  Edit outline
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleOutline(true)}
                  title="Re-read the paper and propose a fresh outline"
                >
                  Re-outline
                </button>
              </>
            )}
          </div>

          {outline.fitness.verdict === 'none' && (
            <p className="wtp-note">
              Building is still offered: it produces a prose-and-equations walkthrough with
              static figures, at a fraction of the cost of an animated one.
            </p>
          )}
        </div>
      )}

      {!building && selected?.status === 'failed' && (
        <div className="wtp-empty">
          <p className="wtp-error">{selected.error}</p>
          <p className="wtp-note">
            The outline survived, so a retry costs only the build.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => handleBuild(selected, true)}>
            Retry build
          </button>
        </div>
      )}
    </div>
  );
}

function statusTooltip(row: Walkthrough, state: WalkthroughPaperState | null): string {
  const parts = [
    `status: ${row.status}`,
    row.model ? `model: ${row.model}` : '',
    row.backend === 'cli'
      ? 'billed to your Claude Code plan (cost shown at list price)'
      : row.backend === 'api'
        ? 'billed to your Anthropic API account'
        : '',
    row.sourceVersion ? `built from arXiv ${row.sourceVersion}` : '',
    row.usage.outline_cost ? `outline ${row.usage.outline_cost.toFixed(3)}` : '',
    row.usage.build_cost ? `build ${row.usage.build_cost.toFixed(3)}` : '',
    state ? `contract ${state.contractVersion}` : '',
    ...row.warnings,
  ];
  return parts.filter(Boolean).join('\n');
}
