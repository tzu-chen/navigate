import { useState, useEffect, useMemo, useRef } from 'react';
import * as api from '../services/api';
import { MAX_FAVORITE_CATEGORIES, type AutoSwitchSettings } from '../services/api';
import {
  COLOR_SCHEMES,
  applyColorScheme,
  getSchemeById,
  DEFAULT_SCHEME_ID,
  DEFAULT_LIGHT_SCHEME_ID,
  DEFAULT_DARK_SCHEME_ID,
} from '../colorSchemes';
import { useKeybindings } from '../contexts/KeybindingsContext';
import { KEYBINDING_META, type KeybindingAction, type KeybindingsConfig } from '../types/keybindings';
import { CategoryGroup } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  showNotification: (msg: string) => void;
}

type Tab = 'general' | 'categories' | 'shortcuts';

function formatKey(key: string): string {
  if (!key) return '—';
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function ShortcutRow({ action, label, scope }: { action: KeybindingAction; label: string; scope: string }) {
  const { keybindings, setKeybinding } = useKeybindings();
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1) return;
      setKeybinding(action, e.key.toLowerCase());
      setRecording(false);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recording, action, setKeybinding]);

  return (
    <div className="shortcut-row">
      <div className="shortcut-info">
        <span className="shortcut-label">{label}</span>
        <span className="shortcut-scope">{scope}</span>
      </div>
      <button
        type="button"
        className={`key-button ${recording ? 'key-button-recording' : ''}`}
        onClick={() => setRecording(r => !r)}
        title={recording ? 'Press a key (Esc to cancel)' : 'Click to rebind'}
      >
        {recording ? 'Press a key…' : formatKey(keybindings[action])}
      </button>
    </div>
  );
}

function findDuplicate(action: KeybindingAction, key: string, all: KeybindingsConfig): KeybindingAction | null {
  for (const other of Object.keys(all) as KeybindingAction[]) {
    if (other !== action && all[other] === key) return other;
  }
  return null;
}

const DEFAULT_AUTO_SWITCH: AutoSwitchSettings = {
  enabled: false,
  lightSchemeId: DEFAULT_LIGHT_SCHEME_ID,
  darkSchemeId: DEFAULT_DARK_SCHEME_ID,
  dayStartHour: 7,
  nightStartHour: 19,
};

export default function SettingsModal({ open, onClose, showNotification }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [colorScheme, setColorScheme] = useState(DEFAULT_SCHEME_ID);
  const [autoSwitch, setAutoSwitch] = useState<AutoSwitchSettings>(DEFAULT_AUTO_SWITCH);
  const [similarityEnabled, setSimilarityEnabled] = useState(false);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.82);
  const [cardFontSize, setCardFontSize] = useState<number>(1);
  const [favoriteCategories, setFavoriteCategories] = useState<string[]>([]);
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([]);
  const [categorySearch, setCategorySearch] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('general');
  const overlayMouseDownRef = useRef(false);

  const { keybindings, resetKeybindings } = useKeybindings();
  const hasConflict = KEYBINDING_META.some(m => findDuplicate(m.action, keybindings[m.action], keybindings));

  useEffect(() => {
    if (open) {
      setLoading(true);
      setShowKey(false);
      setCategorySearch('');
      api.getSettings().then(settings => {
        setApiKey(settings.claudeApiKey);
        setColorScheme(settings.colorScheme);
        setAutoSwitch(settings.autoSwitch);
        setSimilarityEnabled(settings.similarityEnabled);
        setSimilarityThreshold(settings.similarityThreshold);
        setCardFontSize(settings.cardFontSize);
        setFavoriteCategories(settings.favoriteCategories);
        setLoading(false);
      }).catch(() => {
        setLoading(false);
      });
      if (categoryGroups.length === 0) {
        api.getCategories().then(setCategoryGroups).catch(() => {});
      }
    }
  }, [open]);

  const filteredCategoryGroups = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return categoryGroups;
    return categoryGroups
      .map(group => {
        const matches: Record<string, string> = {};
        for (const [key, name] of Object.entries(group.categories)) {
          if (key.toLowerCase().includes(q) || name.toLowerCase().includes(q)) {
            matches[key] = name;
          }
        }
        return { label: group.label, categories: matches };
      })
      .filter(group => Object.keys(group.categories).length > 0);
  }, [categoryGroups, categorySearch]);

  if (!open) return null;

  const handleSchemeChange = (schemeId: string) => {
    setColorScheme(schemeId);
    if (autoSwitch.enabled) {
      setAutoSwitch(prev => ({ ...prev, enabled: false }));
    }
    const scheme = getSchemeById(schemeId);
    if (scheme) {
      applyColorScheme(scheme);
    }
  };

  const handleAutoSwitchToggle = () => {
    setAutoSwitch(prev => {
      const next = { ...prev, enabled: !prev.enabled };
      if (next.enabled) {
        const id = api.getSchemeForCurrentTime(next);
        setColorScheme(id);
        const scheme = getSchemeById(id);
        if (scheme) applyColorScheme(scheme);
      }
      return next;
    });
  };

  const handleSave = async () => {
    try {
      await api.saveSettings({
        claudeApiKey: apiKey.trim(),
        colorScheme,
        similarityEnabled,
        similarityThreshold,
        cardFontSize,
        favoriteCategories,
        autoSwitch,
      });
      api.applyCardFontSize(cardFontSize);
      showNotification('Settings saved');
      onClose();
    } catch {
      showNotification('Failed to save settings');
    }
  };

  const handleFontSizeChange = (size: number) => {
    setCardFontSize(size);
    api.applyCardFontSize(size);
  };

  const handleCancel = () => {
    // Revert color scheme and font size to saved values
    const visualPrefs = api.getVisualPrefsSync();
    const restoredId = visualPrefs.autoSwitch.enabled
      ? api.getSchemeForCurrentTime(visualPrefs.autoSwitch)
      : visualPrefs.colorScheme;
    const scheme = getSchemeById(restoredId);
    if (scheme) {
      applyColorScheme(scheme);
    }
    api.applyCardFontSize(visualPrefs.cardFontSize);
    onClose();
  };

  const handleVerify = async () => {
    const key = apiKey.trim();
    if (!key) {
      showNotification('Please enter an API key first');
      return;
    }

    setVerifying(true);
    try {
      const result = await api.verifyApiKey(key);
      if (result.valid) {
        showNotification('API key is valid');
      } else {
        showNotification(`Invalid API key: ${result.error || 'Unknown error'}`);
      }
    } catch {
      showNotification('Failed to verify API key');
    } finally {
      setVerifying(false);
    }
  };

  const handleClear = async () => {
    setApiKey('');
    try {
      await api.saveSettings({
        claudeApiKey: '',
        colorScheme,
        similarityEnabled,
        similarityThreshold,
        cardFontSize,
        favoriteCategories,
        autoSwitch,
      });
      showNotification('API key removed');
    } catch {
      showNotification('Failed to remove API key');
    }
  };

  const toggleFavoriteCategory = (key: string) => {
    setFavoriteCategories(prev => {
      if (prev.includes(key)) {
        return prev.filter(c => c !== key);
      }
      if (prev.length >= MAX_FAVORITE_CATEGORIES) {
        showNotification(`You can pick at most ${MAX_FAVORITE_CATEGORIES} favorite categories`);
        return prev;
      }
      return [...prev, key];
    });
  };

  const maskedKey = apiKey ? apiKey.slice(0, 10) + '...' + apiKey.slice(-4) : '';

  return (
    <div
      className="settings-overlay"
      onMouseDown={e => { overlayMouseDownRef.current = e.target === e.currentTarget; }}
      onClick={e => {
        if (overlayMouseDownRef.current && e.target === e.currentTarget) handleCancel();
        overlayMouseDownRef.current = false;
      }}
    >
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <div className="settings-tabs">
            <button
              className={`settings-tab ${tab === 'general' ? 'active' : ''}`}
              onClick={() => setTab('general')}
            >
              General
            </button>
            <button
              className={`settings-tab ${tab === 'categories' ? 'active' : ''}`}
              onClick={() => setTab('categories')}
            >
              Categories
            </button>
            <button
              className={`settings-tab ${tab === 'shortcuts' ? 'active' : ''}`}
              onClick={() => setTab('shortcuts')}
            >
              Shortcuts
            </button>
          </div>
          <button className="btn-icon" onClick={handleCancel}>&times;</button>
        </div>

        {tab === 'general' && (loading ? (
          <div className="settings-body" style={{ textAlign: 'center', padding: '2rem' }}>
            Loading settings...
          </div>
        ) : (
          <div className="settings-body">
            <div className="settings-section">
              <h3>Color Scheme</h3>
              <p className="settings-description">
                Choose a color scheme for the application. Changes preview instantly.
              </p>

              <div className="scheme-grid">
                {COLOR_SCHEMES.map(scheme => (
                  <button
                    key={scheme.id}
                    className={`scheme-card ${!autoSwitch.enabled && colorScheme === scheme.id ? 'active' : ''}`}
                    onClick={() => handleSchemeChange(scheme.id)}
                  >
                    <div className="scheme-preview">
                      <div
                        className="scheme-swatch-bg"
                        style={{ background: scheme.colors.bgPrimary }}
                      >
                        <div
                          className="scheme-swatch-bar"
                          style={{ background: scheme.colors.bgSecondary, borderBottom: `2px solid ${scheme.colors.borderColor}` }}
                        />
                        <div className="scheme-swatch-body">
                          <div
                            className="scheme-swatch-card"
                            style={{ background: scheme.colors.bgCard, border: `1px solid ${scheme.colors.borderColor}` }}
                          >
                            <div
                              className="scheme-swatch-text"
                              style={{ background: scheme.colors.textPrimary }}
                            />
                            <div
                              className="scheme-swatch-text short"
                              style={{ background: scheme.colors.textSecondary }}
                            />
                          </div>
                          <div
                            className="scheme-swatch-accent"
                            style={{ background: scheme.colors.accent }}
                          />
                        </div>
                      </div>
                    </div>
                    <span className="scheme-name">{scheme.name}</span>
                  </button>
                ))}
              </div>

              <div className="auto-switch-row">
                <div className="auto-switch-info">
                  <span className="auto-switch-label">Auto switch</span>
                  <span className="auto-switch-desc">
                    Light theme by day ({autoSwitch.dayStartHour}:00), dark by night ({autoSwitch.nightStartHour}:00)
                  </span>
                </div>
                <button
                  type="button"
                  className={`toggle-switch ${autoSwitch.enabled ? 'on' : ''}`}
                  onClick={handleAutoSwitchToggle}
                  role="switch"
                  aria-checked={autoSwitch.enabled}
                  aria-label="Auto theme switching"
                >
                  <span className="toggle-switch-thumb" />
                </button>
              </div>
            </div>

            <div className="settings-section" style={{ marginTop: 24 }}>
              <h3>Card Font Size</h3>
              <p className="settings-description">
                Adjust the font size of paper titles and abstracts in browse and library cards.
              </p>

              <div className="font-size-slider-container">
                <input
                  type="range"
                  className="font-size-slider"
                  min="0.7"
                  max="2.5"
                  step="0.05"
                  value={cardFontSize}
                  onChange={e => handleFontSizeChange(parseFloat(e.target.value))}
                />
                <div className="font-size-slider-labels">
                  <span>A</span>
                  <span style={{ fontSize: '1.4em' }}>A</span>
                  <span style={{ fontSize: '2em' }}>A</span>
                </div>
                <span className="font-size-preview" style={{ fontSize: `${cardFontSize * 16}px` }}>
                  Aa — Preview
                </span>
              </div>
            </div>

            <div className="settings-section" style={{ marginTop: 24 }}>
              <h3>Claude API</h3>
              <p className="settings-description">
                Connect your Claude API key to use the AI chat feature when viewing papers.
                Your key is stored securely on the server.
              </p>

              <div className="settings-field">
                <label htmlFor="claude-api-key">API Key</label>
                <div className="settings-key-row">
                  <input
                    id="claude-api-key"
                    type={showKey ? 'text' : 'password'}
                    value={showKey ? apiKey : (apiKey ? maskedKey : '')}
                    onChange={e => {
                      setShowKey(true);
                      setApiKey(e.target.value);
                    }}
                    onFocus={() => setShowKey(true)}
                    placeholder="sk-ant-..."
                    className="settings-key-input"
                  />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setShowKey(!showKey)}
                    type="button"
                  >
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p className="settings-hint">
                  Get your API key from{' '}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    console.anthropic.com
                  </a>
                </p>
              </div>

              <div className="settings-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleVerify}
                  disabled={!apiKey.trim() || verifying}
                >
                  {verifying ? 'Verifying...' : 'Verify Key'}
                </button>
                {apiKey && (
                  <button className="btn btn-danger btn-sm" onClick={handleClear}>
                    Remove Key
                  </button>
                )}
              </div>
            </div>

            <div className="settings-section" style={{ marginTop: 24 }}>
              <h3>Worldline Similarity</h3>
              <p className="settings-description">
                When browsing ArXiv, papers can be scored against your existing worldlines using SPECTER2
                embeddings. This runs on the CPU and re-embeds each new category of papers, so it is
                <strong> off by default</strong>. Enable it only if you want live worldline suggestions while browsing.
              </p>

              <div className="settings-field">
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={similarityEnabled}
                    onChange={e => setSimilarityEnabled(e.target.checked)}
                  />
                  <span>Enable similarity matching while browsing (CPU-intensive)</span>
                </label>
              </div>

              <div className="settings-field" style={{ opacity: similarityEnabled ? 1 : 0.5 }}>
                <label>Similarity Threshold: {similarityThreshold.toFixed(2)}</label>
                <div className="settings-threshold-row">
                  <span className="settings-threshold-label">0.70</span>
                  <input
                    type="range"
                    min="0.70"
                    max="0.95"
                    step="0.01"
                    value={similarityThreshold}
                    disabled={!similarityEnabled}
                    onChange={e => setSimilarityThreshold(parseFloat(e.target.value))}
                    className="settings-threshold-slider"
                  />
                  <span className="settings-threshold-label">0.95</span>
                </div>
                <p className="settings-hint">
                  Default: 0.82. Lower = more matches (less strict), Higher = fewer matches (more strict).
                  Only the fallback bar for small (&lt;2 member) threads; larger threads self-calibrate.
                </p>
              </div>
            </div>
          </div>
        ))}

        {tab === 'categories' && (
          <div className="settings-body">
            <div className="settings-section">
              <h3>Favorite ArXiv Categories</h3>
              <p className="settings-description">
                Pick up to {MAX_FAVORITE_CATEGORIES} categories. The browse page can then show new
                listings aggregated across them in one feed. Listings are cached server-side for 15
                minutes to stay within ArXiv's rate limits.
              </p>

              <div className="favorite-categories-summary">
                {favoriteCategories.length === 0 ? (
                  <span className="settings-hint">None selected.</span>
                ) : (
                  favoriteCategories.map(key => (
                    <span
                      key={key}
                      className={`category-badge cat-${key.includes('.') ? key.split('.')[0] : key}`}
                    >
                      {key}
                      <button
                        type="button"
                        className="favorite-category-remove"
                        onClick={() => toggleFavoriteCategory(key)}
                        title="Remove"
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
                <span className="favorite-categories-count">
                  {favoriteCategories.length}/{MAX_FAVORITE_CATEGORIES}
                </span>
              </div>

              <div className="settings-field" style={{ marginTop: 16 }}>
                <input
                  type="text"
                  value={categorySearch}
                  onChange={e => setCategorySearch(e.target.value)}
                  placeholder="Filter (e.g. cs.LG, machine learning)"
                  className="settings-key-input"
                />
              </div>

              <div className="favorite-categories-list">
                {filteredCategoryGroups.map(group => (
                  <div key={group.label} className="favorite-category-group">
                    <div className="favorite-category-group-label">{group.label}</div>
                    <div className="favorite-category-options">
                      {Object.entries(group.categories).map(([key, name]) => {
                        const selected = favoriteCategories.includes(key);
                        const atLimit = !selected && favoriteCategories.length >= MAX_FAVORITE_CATEGORIES;
                        return (
                          <button
                            key={key}
                            type="button"
                            className={`favorite-category-option ${selected ? 'selected' : ''}`}
                            onClick={() => toggleFavoriteCategory(key)}
                            disabled={atLimit}
                            title={atLimit ? `Limit reached (${MAX_FAVORITE_CATEGORIES})` : name}
                          >
                            <span className="favorite-category-key">{key}</span>
                            <span className="favorite-category-name">{name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {filteredCategoryGroups.length === 0 && (
                  <p className="settings-hint">No categories match.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'shortcuts' && (
          <div className="settings-body">
            <div className="settings-section">
              <h3>Keyboard Shortcuts</h3>
              <p className="settings-description">
                Click a key to rebind. Single-character keys only; Esc cancels recording.
                Shortcuts only fire when no input is focused.
              </p>
              <div className="shortcut-list">
                {KEYBINDING_META.map(m => (
                  <ShortcutRow key={m.action} action={m.action} label={m.label} scope={m.scope} />
                ))}
              </div>
              {hasConflict && (
                <p className="shortcut-warning">
                  Duplicate key assigned — only one action will fire.
                </p>
              )}
              <div className="settings-actions" style={{ marginTop: 16 }}>
                <button className="btn btn-secondary btn-sm" onClick={resetKeybindings}>
                  Reset to defaults
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="settings-footer">
          <button className="btn btn-secondary" onClick={handleCancel}>Cancel</button>
          {(tab === 'general' || tab === 'categories') && (
            <button className="btn btn-primary" onClick={handleSave} disabled={loading}>Save</button>
          )}
        </div>
      </div>
    </div>
  );
}
