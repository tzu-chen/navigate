/**
 * Colour schemes.
 *
 * Two schemes, shared across the suite: "Parchment" (light) and "Graphite"
 * (dark). The palette itself lives in `src/styles/monolith-theme.css` — this
 * module only decides which theme is active and flips the attributes the
 * stylesheet keys off. It deliberately does NOT write colours as inline styles:
 * inline styles on <html> outrank any stylesheet, which would give the app a
 * second, silently-winning source of colour.
 *
 * `swatch` is the one exception — a handful of representative colours the
 * settings modal paints into its theme-preview thumbnails, where there is no
 * element to read the cascade from. Keep it in step with monolith-theme.css.
 */

export interface ColorScheme {
  id: string;
  name: string;
  type: 'dark' | 'light';
  /** Preview-thumbnail colours only. Everything else reads the cascade. */
  swatch: {
    bgPrimary: string;
    bgSecondary: string;
    bgCard: string;
    textPrimary: string;
    textSecondary: string;
    borderColor: string;
    accent: string;
  };
}

const parchment: ColorScheme = {
  id: 'parchment',
  name: 'Parchment',
  type: 'light',
  swatch: {
    bgPrimary: '#ffffff',
    bgSecondary: '#faf8f4',
    bgCard: '#fffef9',
    textPrimary: '#2c2820',
    textSecondary: '#6b6358',
    borderColor: '#e2ddd3',
    accent: '#8b5e3c',
  },
};

const graphite: ColorScheme = {
  id: 'graphite',
  name: 'Graphite',
  type: 'dark',
  swatch: {
    bgPrimary: '#0f1013',
    bgSecondary: '#15161a',
    bgCard: '#1c1e23',
    textPrimary: '#e4e6ea',
    textSecondary: '#c2c7cf',
    borderColor: '#2b2e35',
    accent: '#d99a4e',
  },
};

export const COLOR_SCHEMES: ColorScheme[] = [parchment, graphite];

export const DEFAULT_LIGHT_SCHEME_ID = 'parchment';
export const DEFAULT_DARK_SCHEME_ID = 'graphite';
export const DEFAULT_SCHEME_ID = DEFAULT_LIGHT_SCHEME_ID;

const LEGACY_SCHEME_MAP: Record<string, string> = {
  light: DEFAULT_LIGHT_SCHEME_ID,
  'default-light': DEFAULT_LIGHT_SCHEME_ID,
  'solarized-light': DEFAULT_LIGHT_SCHEME_ID,
  'github-light': DEFAULT_LIGHT_SCHEME_ID,
  'catppuccin-latte': DEFAULT_LIGHT_SCHEME_ID,
  'nord-light': DEFAULT_LIGHT_SCHEME_ID,
  'dracula-light': DEFAULT_LIGHT_SCHEME_ID,
  dark: DEFAULT_DARK_SCHEME_ID,
  nord: DEFAULT_DARK_SCHEME_ID,
  'default-dark': DEFAULT_DARK_SCHEME_ID,
  'solarized-dark': DEFAULT_DARK_SCHEME_ID,
  dracula: DEFAULT_DARK_SCHEME_ID,
  monokai: DEFAULT_DARK_SCHEME_ID,
  'one-dark-pro': DEFAULT_DARK_SCHEME_ID,
  'nord-dark': DEFAULT_DARK_SCHEME_ID,
  'dracula-dark': DEFAULT_DARK_SCHEME_ID,
};

export function coerceSchemeId(id: string | undefined | null, fallback = DEFAULT_SCHEME_ID): string {
  if (!id) return fallback;
  const mapped = LEGACY_SCHEME_MAP[id] ?? id;
  return COLOR_SCHEMES.some(s => s.id === mapped) ? mapped : fallback;
}

export function getSchemeById(id: string): ColorScheme | undefined {
  return COLOR_SCHEMES.find(s => s.id === id);
}

export function applyColorScheme(scheme: ColorScheme): void {
  const root = document.documentElement;
  root.dataset.theme = scheme.type;
  root.dataset.scheme = scheme.id;
  // Kept for the selectors that already key off it.
  root.dataset.themeType = scheme.type;
}
