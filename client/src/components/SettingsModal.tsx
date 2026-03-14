import { useState, useEffect } from 'react';
import * as api from '../services/api';
import type { AppSettings } from '../services/api';
import { COLOR_SCHEMES, applyColorScheme, getSchemeById } from '../colorSchemes';

interface Props {
  open: boolean;
  onClose: () => void;
  showNotification: (msg: string) => void;
}

export default function SettingsModal({ open, onClose, showNotification }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [colorScheme, setColorScheme] = useState('default-dark');
  const [similarityThreshold, setSimilarityThreshold] = useState(0.15);
  const [cardFontSize, setCardFontSize] = useState<AppSettings['cardFontSize']>('medium');
  const [verifying, setVerifying] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      setShowKey(false);
      api.getSettings().then(settings => {
        setApiKey(settings.claudeApiKey);
        setColorScheme(settings.colorScheme);
        setSimilarityThreshold(settings.similarityThreshold);
        setCardFontSize(settings.cardFontSize);
        setLoading(false);
      }).catch(() => {
        setLoading(false);
      });
    }
  }, [open]);

  if (!open) return null;

  const handleSchemeChange = (schemeId: string) => {
    setColorScheme(schemeId);
    const scheme = getSchemeById(schemeId);
    if (scheme) {
      applyColorScheme(scheme);
    }
  };

  const handleSave = async () => {
    try {
      await api.saveSettings({ claudeApiKey: apiKey.trim(), colorScheme, similarityThreshold, cardFontSize });
      api.applyCardFontSize(cardFontSize);
      showNotification('Settings saved');
      onClose();
    } catch {
      showNotification('Failed to save settings');
    }
  };

  const handleFontSizeChange = (size: AppSettings['cardFontSize']) => {
    setCardFontSize(size);
    api.applyCardFontSize(size);
  };

  const handleCancel = () => {
    // Revert color scheme and font size to saved values
    const visualPrefs = api.getVisualPrefsSync();
    const scheme = getSchemeById(visualPrefs.colorScheme);
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
      await api.saveSettings({ claudeApiKey: '', colorScheme, similarityThreshold, cardFontSize });
      showNotification('API key removed');
    } catch {
      showNotification('Failed to remove API key');
    }
  };

  const maskedKey = apiKey ? apiKey.slice(0, 10) + '...' + apiKey.slice(-4) : '';

  return (
    <div className="settings-overlay" onClick={handleCancel}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="btn-icon" onClick={handleCancel}>&times;</button>
        </div>

        {loading ? (
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
                    className={`scheme-card ${colorScheme === scheme.id ? 'active' : ''}`}
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
                    <span className="scheme-type">{scheme.type}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-section" style={{ marginTop: 24 }}>
              <h3>Card Font Size</h3>
              <p className="settings-description">
                Adjust the font size of paper titles and abstracts in browse and library cards.
              </p>

              <div className="font-size-options">
                {(['small', 'medium', 'large'] as const).map(size => (
                  <button
                    key={size}
                    className={`font-size-option ${cardFontSize === size ? 'active' : ''}`}
                    onClick={() => handleFontSizeChange(size)}
                  >
                    <span className="font-size-label">{size.charAt(0).toUpperCase() + size.slice(1)}</span>
                    <span className={`font-size-preview font-size-preview-${size}`}>Aa</span>
                  </button>
                ))}
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
                When browsing ArXiv, papers are scored against your existing worldlines using text similarity.
                Adjust the threshold to control how sensitive the matching is.
                Lower values show more matches, higher values require closer relevance.
              </p>

              <div className="settings-field">
                <label>Similarity Threshold: {similarityThreshold.toFixed(2)}</label>
                <div className="settings-threshold-row">
                  <span className="settings-threshold-label">0.05</span>
                  <input
                    type="range"
                    min="0.05"
                    max="0.50"
                    step="0.01"
                    value={similarityThreshold}
                    onChange={e => setSimilarityThreshold(parseFloat(e.target.value))}
                    className="settings-threshold-slider"
                  />
                  <span className="settings-threshold-label">0.50</span>
                </div>
                <p className="settings-hint">
                  Default: 0.15. Lower = more matches (less strict), Higher = fewer matches (more strict).
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="settings-footer">
          <button className="btn btn-secondary" onClick={handleCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>Save</button>
        </div>
      </div>
    </div>
  );
}
