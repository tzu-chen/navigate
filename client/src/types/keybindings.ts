export type KeybindingAction =
  | 'pdfTocToggle'
  | 'pdfPanelToggle'
  | 'pdfImmersiveToggle'
  | 'pdfWorldlineToggle'
  | 'pdfSavePaper'
  | 'viewerPanePdf'
  | 'viewerPaneSplit'
  | 'viewerPaneWalkthrough'
  | 'pdfTierSet0'
  | 'pdfTierSet1'
  | 'pdfTierSet2'
  | 'pdfTierSet3'
  | 'pdfTierSet4'
  | 'goToLibrary'
  | 'goToBrowse';

export interface KeybindingMeta {
  action: KeybindingAction;
  label: string;
  scope: string;
  defaultKey: string;
}

export const KEYBINDING_META: KeybindingMeta[] = [
  { action: 'pdfTocToggle', label: 'Toggle table of contents', scope: 'PDF viewer', defaultKey: 't' },
  { action: 'pdfPanelToggle', label: 'Toggle right panel', scope: 'PDF viewer', defaultKey: 'p' },
  { action: 'pdfImmersiveToggle', label: 'Toggle fullscreen / immersive mode', scope: 'PDF viewer', defaultKey: 'f' },
  { action: 'pdfWorldlineToggle', label: 'Open worldline navigator', scope: 'PDF viewer', defaultKey: 'w' },
  { action: 'pdfSavePaper', label: 'Save paper to library', scope: 'PDF viewer', defaultKey: 's' },
  // The three pane layouts, on adjacent keys whose positions mirror the layout
  // itself: `[` is the left pane, `]` the right, `\` the pair. Bracket keys also
  // stay clear of the tier digits and the single-letter viewer actions.
  { action: 'viewerPanePdf', label: 'Show the PDF pane only', scope: 'Pane layout', defaultKey: '[' },
  { action: 'viewerPaneSplit', label: 'Split — PDF and walkthrough', scope: 'Pane layout', defaultKey: '\\' },
  { action: 'viewerPaneWalkthrough', label: 'Show the walkthrough pane only', scope: 'Pane layout', defaultKey: ']' },
  { action: 'pdfTierSet0', label: 'Set tier T0 (Mirror)', scope: 'PDF viewer', defaultKey: '0' },
  { action: 'pdfTierSet1', label: 'Set tier T1 (Exalted)', scope: 'PDF viewer', defaultKey: '1' },
  { action: 'pdfTierSet2', label: 'Set tier T2 (Rare)', scope: 'PDF viewer', defaultKey: '2' },
  { action: 'pdfTierSet3', label: 'Set tier T3 (Magic)', scope: 'PDF viewer', defaultKey: '3' },
  { action: 'pdfTierSet4', label: 'Set tier T4 (Normal)', scope: 'PDF viewer', defaultKey: '4' },
  { action: 'goToLibrary', label: 'Go to Library', scope: 'Global', defaultKey: 'l' },
  { action: 'goToBrowse', label: 'Browse new papers', scope: 'Global', defaultKey: 'b' },
];

export type KeybindingsConfig = Record<KeybindingAction, string>;

export const DEFAULT_KEYBINDINGS: KeybindingsConfig = KEYBINDING_META.reduce(
  (acc, m) => ({ ...acc, [m.action]: m.defaultKey }),
  {} as KeybindingsConfig,
);
