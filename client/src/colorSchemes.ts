export interface ColorScheme {
  id: string;
  name: string;
  type: 'dark' | 'light';
  colors: {
    bgPrimary: string;
    bgSecondary: string;
    bgTertiary: string;
    bgCard: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    borderColor: string;
    accent: string;
    accentHover: string;
    success: string;
    successHover: string;
    danger: string;
    dangerHover: string;
    warning: string;
    shadow: string;
    shadowLg: string;
  };
}

export const COLOR_SCHEMES: ColorScheme[] = [
  {
    id: 'default-dark',
    name: 'Default Dark',
    type: 'dark',
    colors: {
      bgPrimary: '#0f172a',
      bgSecondary: '#1e293b',
      bgTertiary: '#334155',
      bgCard: '#1e293b',
      textPrimary: '#f1f5f9',
      textSecondary: '#94a3b8',
      textMuted: '#64748b',
      borderColor: '#334155',
      accent: '#6366f1',
      accentHover: '#818cf8',
      success: '#10b981',
      successHover: '#34d399',
      danger: '#ef4444',
      dangerHover: '#f87171',
      warning: '#f59e0b',
      shadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
      shadowLg: '0 4px 12px rgba(0, 0, 0, 0.4)',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    type: 'dark',
    colors: {
      bgPrimary: '#002b36',
      bgSecondary: '#073642',
      bgTertiary: '#586e75',
      bgCard: '#073642',
      textPrimary: '#fdf6e3',
      textSecondary: '#93a1a1',
      textMuted: '#657b83',
      borderColor: '#586e75',
      accent: '#268bd2',
      accentHover: '#2aa198',
      success: '#859900',
      successHover: '#b58900',
      danger: '#dc322f',
      dangerHover: '#cb4b16',
      warning: '#b58900',
      shadow: '0 1px 3px rgba(0, 0, 0, 0.4)',
      shadowLg: '0 4px 12px rgba(0, 0, 0, 0.5)',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    type: 'light',
    colors: {
      bgPrimary: '#fdf6e3',
      bgSecondary: '#eee8d5',
      bgTertiary: '#93a1a1',
      bgCard: '#eee8d5',
      textPrimary: '#073642',
      textSecondary: '#586e75',
      textMuted: '#93a1a1',
      borderColor: '#93a1a1',
      accent: '#268bd2',
      accentHover: '#2aa198',
      success: '#859900',
      successHover: '#6c7c00',
      danger: '#dc322f',
      dangerHover: '#cb4b16',
      warning: '#b58900',
      shadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
      shadowLg: '0 4px 12px rgba(0, 0, 0, 0.15)',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    type: 'dark',
    colors: {
      bgPrimary: '#2e3440',
      bgSecondary: '#3b4252',
      bgTertiary: '#434c5e',
      bgCard: '#3b4252',
      textPrimary: '#eceff4',
      textSecondary: '#d8dee9',
      textMuted: '#4c566a',
      borderColor: '#434c5e',
      accent: '#88c0d0',
      accentHover: '#8fbcbb',
      success: '#a3be8c',
      successHover: '#b4d09a',
      danger: '#bf616a',
      dangerHover: '#d08770',
      warning: '#ebcb8b',
      shadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
      shadowLg: '0 4px 12px rgba(0, 0, 0, 0.4)',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    type: 'dark',
    colors: {
      bgPrimary: '#282a36',
      bgSecondary: '#44475a',
      bgTertiary: '#6272a4',
      bgCard: '#44475a',
      textPrimary: '#f8f8f2',
      textSecondary: '#bd93f9',
      textMuted: '#6272a4',
      borderColor: '#6272a4',
      accent: '#bd93f9',
      accentHover: '#ff79c6',
      success: '#50fa7b',
      successHover: '#69ff94',
      danger: '#ff5555',
      dangerHover: '#ff6e6e',
      warning: '#f1fa8c',
      shadow: '0 1px 3px rgba(0, 0, 0, 0.4)',
      shadowLg: '0 4px 12px rgba(0, 0, 0, 0.5)',
    },
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    type: 'light',
    colors: {
      bgPrimary: '#ffffff',
      bgSecondary: '#f6f8fa',
      bgTertiary: '#d0d7de',
      bgCard: '#f6f8fa',
      textPrimary: '#1f2328',
      textSecondary: '#656d76',
      textMuted: '#8b949e',
      borderColor: '#d0d7de',
      accent: '#0969da',
      accentHover: '#0550ae',
      success: '#1a7f37',
      successHover: '#116329',
      danger: '#cf222e',
      dangerHover: '#a40e26',
      warning: '#9a6700',
      shadow: '0 1px 3px rgba(31, 35, 40, 0.12)',
      shadowLg: '0 4px 12px rgba(31, 35, 40, 0.15)',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    type: 'dark',
    colors: {
      bgPrimary: '#272822',
      bgSecondary: '#3e3d32',
      bgTertiary: '#75715e',
      bgCard: '#3e3d32',
      textPrimary: '#f8f8f2',
      textSecondary: '#a6e22e',
      textMuted: '#75715e',
      borderColor: '#75715e',
      accent: '#66d9ef',
      accentHover: '#a6e22e',
      success: '#a6e22e',
      successHover: '#b6f23e',
      danger: '#f92672',
      dangerHover: '#fd5da8',
      warning: '#e6db74',
      shadow: '0 1px 3px rgba(0, 0, 0, 0.4)',
      shadowLg: '0 4px 12px rgba(0, 0, 0, 0.5)',
    },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    type: 'light',
    colors: {
      bgPrimary: '#eff1f5',
      bgSecondary: '#e6e9ef',
      bgTertiary: '#9ca0b0',
      bgCard: '#e6e9ef',
      textPrimary: '#4c4f69',
      textSecondary: '#6c6f85',
      textMuted: '#9ca0b0',
      borderColor: '#9ca0b0',
      accent: '#8839ef',
      accentHover: '#7287fd',
      success: '#40a02b',
      successHover: '#179299',
      danger: '#d20f39',
      dangerHover: '#e64553',
      warning: '#df8e1d',
      shadow: '0 1px 3px rgba(76, 79, 105, 0.1)',
      shadowLg: '0 4px 12px rgba(76, 79, 105, 0.15)',
    },
  },
];

export function getSchemeById(id: string): ColorScheme | undefined {
  return COLOR_SCHEMES.find(s => s.id === id);
}

export function applyColorScheme(scheme: ColorScheme): void {
  const root = document.documentElement;
  root.style.setProperty('--bg-primary', scheme.colors.bgPrimary);
  root.style.setProperty('--bg-secondary', scheme.colors.bgSecondary);
  root.style.setProperty('--bg-tertiary', scheme.colors.bgTertiary);
  root.style.setProperty('--bg-card', scheme.colors.bgCard);
  root.style.setProperty('--text-primary', scheme.colors.textPrimary);
  root.style.setProperty('--text-secondary', scheme.colors.textSecondary);
  root.style.setProperty('--text-muted', scheme.colors.textMuted);
  root.style.setProperty('--border-color', scheme.colors.borderColor);
  root.style.setProperty('--accent', scheme.colors.accent);
  root.style.setProperty('--accent-hover', scheme.colors.accentHover);
  root.style.setProperty('--success', scheme.colors.success);
  root.style.setProperty('--success-hover', scheme.colors.successHover);
  root.style.setProperty('--danger', scheme.colors.danger);
  root.style.setProperty('--danger-hover', scheme.colors.dangerHover);
  root.style.setProperty('--warning', scheme.colors.warning);
  root.style.setProperty('--shadow', scheme.colors.shadow);
  root.style.setProperty('--shadow-lg', scheme.colors.shadowLg);
  root.setAttribute('data-theme-type', scheme.type);
}
