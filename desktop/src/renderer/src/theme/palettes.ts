import type { PaletteId, ResolvedTheme } from '@shared/theme'

/**
 * Colour tokens. Every key becomes a `--<key>` custom property on <html>
 * (see apply.ts) and is mapped into Tailwind by tokens.css `@theme inline`.
 *
 * Adding a palette = add an entry to PALETTES. Adding a token = add it to
 * ColorTokens and every palette (the type forces completeness).
 */
export interface ColorTokens {
  background: string
  foreground: string
  surface: string
  elevated: string
  card: string
  'card-foreground': string
  popover: string
  'popover-foreground': string
  primary: string
  'primary-foreground': string
  secondary: string
  'secondary-foreground': string
  muted: string
  'muted-foreground': string
  dim: string
  accent: string
  'accent-foreground': string
  destructive: string
  'destructive-foreground': string
  border: string
  hairline: string
  input: string
  ring: string
  ok: string
  warn: string
  danger: string
  info: string
  sidebar: string
  'sidebar-foreground': string
  'sidebar-primary': string
  'sidebar-primary-foreground': string
  'sidebar-accent': string
  'sidebar-accent-foreground': string
  'sidebar-border': string
  'sidebar-ring': string
  /** Opacity of the atmospheric grain overlay, "0" disables it. */
  'grain-opacity': string
}

export interface PaletteDefinition {
  id: PaletteId
  label: string
  description: string
  light: ColorTokens
  dark: ColorTokens
}

export const COLOR_TOKEN_KEYS = [
  'background',
  'foreground',
  'surface',
  'elevated',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'dim',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'hairline',
  'input',
  'ring',
  'ok',
  'warn',
  'danger',
  'info',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'grain-opacity',
] as const satisfies readonly (keyof ColorTokens)[]

/* Tactical — the AgentOS brand system. Near-black operator ground, hairline
   panels, one lime signal (#CCFF00, sampled from the molecule logo) reserved
   for active nav, primary CTA, focus rings. Never decorate with it. */
const tactical: PaletteDefinition = {
  id: 'tactical',
  label: 'Tactical',
  description: 'AgentOS brand: operator black with a single lime signal.',
  dark: {
    background: '#060608',
    foreground: '#ececef',
    surface: '#0e0e13',
    elevated: '#17171d',
    card: '#0e0e13',
    'card-foreground': '#ececef',
    popover: '#17171d',
    'popover-foreground': '#ececef',
    primary: '#ccff00',
    'primary-foreground': '#0f1400',
    secondary: '#17171d',
    'secondary-foreground': '#ececef',
    muted: '#17171d',
    'muted-foreground': '#a1a1aa',
    dim: '#7c7c85',
    accent: '#21212a',
    'accent-foreground': '#ececef',
    destructive: '#f87171',
    'destructive-foreground': '#1a0505',
    border: 'rgba(255, 255, 255, 0.13)',
    hairline: 'rgba(255, 255, 255, 0.08)',
    input: 'rgba(255, 255, 255, 0.17)',
    ring: '#ccff00',
    ok: '#4ade80',
    warn: '#fbbf24',
    danger: '#f87171',
    info: '#60a5fa',
    sidebar: '#0e0e13',
    'sidebar-foreground': '#ececef',
    'sidebar-primary': '#ccff00',
    'sidebar-primary-foreground': '#0f1400',
    'sidebar-accent': '#21212a',
    'sidebar-accent-foreground': '#ececef',
    'sidebar-border': 'rgba(255, 255, 255, 0.13)',
    'sidebar-ring': '#ccff00',
    'grain-opacity': '0.05',
  },
  light: {
    background: '#f4f5ee',
    foreground: '#18181b',
    surface: '#ffffff',
    elevated: '#eff1e8',
    card: '#ffffff',
    'card-foreground': '#18181b',
    popover: '#ffffff',
    'popover-foreground': '#18181b',
    primary: '#556f00',
    'primary-foreground': '#ffffff',
    secondary: '#eff1e8',
    'secondary-foreground': '#18181b',
    muted: '#eff1e8',
    'muted-foreground': '#4b4b53',
    dim: '#66666e',
    accent: '#e4e7da',
    'accent-foreground': '#18181b',
    destructive: '#a61b1b',
    'destructive-foreground': '#ffffff',
    border: 'rgba(18, 20, 15, 0.1)',
    hairline: 'rgba(18, 20, 15, 0.08)',
    input: 'rgba(18, 20, 15, 0.14)',
    ring: '#556f00',
    ok: '#166534',
    warn: '#7a4f00',
    danger: '#a61b1b',
    info: '#1d4ed8',
    sidebar: '#ffffff',
    'sidebar-foreground': '#18181b',
    'sidebar-primary': '#556f00',
    'sidebar-primary-foreground': '#ffffff',
    'sidebar-accent': '#e4e7da',
    'sidebar-accent-foreground': '#18181b',
    'sidebar-border': 'rgba(18, 20, 15, 0.1)',
    'sidebar-ring': '#556f00',
    'grain-opacity': '0.03',
  },
}

/* Graphite — neutral blue-grey with a cool signal. Closer to stock macOS
   chrome for people who find the lime too loud. No grain. */
const graphite: PaletteDefinition = {
  id: 'graphite',
  label: 'Graphite',
  description: 'Neutral blue-grey, calmer accent, no texture.',
  dark: {
    background: '#090c11',
    foreground: '#f2f4f7',
    surface: '#10141a',
    elevated: '#171c24',
    card: '#10141a',
    'card-foreground': '#f2f4f7',
    popover: '#171c24',
    'popover-foreground': '#f2f4f7',
    primary: '#7dd3fc',
    'primary-foreground': '#04121b',
    secondary: '#191f28',
    'secondary-foreground': '#f2f4f7',
    muted: '#171c24',
    'muted-foreground': '#aeb6c3',
    dim: '#8f99a8',
    accent: '#1b222c',
    'accent-foreground': '#f2f4f7',
    destructive: '#f87171',
    'destructive-foreground': '#1a0505',
    border: 'rgba(226, 232, 240, 0.13)',
    hairline: 'rgba(226, 232, 240, 0.08)',
    input: 'rgba(226, 232, 240, 0.17)',
    ring: '#7dd3fc',
    ok: '#4ade80',
    warn: '#fbbf24',
    danger: '#f87171',
    info: '#60a5fa',
    sidebar: '#0c1016',
    'sidebar-foreground': '#f2f4f7',
    'sidebar-primary': '#7dd3fc',
    'sidebar-primary-foreground': '#04121b',
    'sidebar-accent': '#191f28',
    'sidebar-accent-foreground': '#f2f4f7',
    'sidebar-border': 'rgba(226, 232, 240, 0.1)',
    'sidebar-ring': '#7dd3fc',
    'grain-opacity': '0',
  },
  light: {
    background: '#f3f5f7',
    foreground: '#171b22',
    surface: '#ffffff',
    elevated: '#eef1f4',
    card: '#ffffff',
    'card-foreground': '#171b22',
    popover: '#ffffff',
    'popover-foreground': '#171b22',
    primary: '#0369a1',
    'primary-foreground': '#ffffff',
    secondary: '#edf0f3',
    'secondary-foreground': '#171b22',
    muted: '#edf0f3',
    'muted-foreground': '#505967',
    dim: '#677180',
    accent: '#e8edf0',
    'accent-foreground': '#171b22',
    destructive: '#a61b1b',
    'destructive-foreground': '#ffffff',
    border: 'rgba(27, 34, 45, 0.13)',
    hairline: 'rgba(27, 34, 45, 0.08)',
    input: 'rgba(27, 34, 45, 0.18)',
    ring: '#0369a1',
    ok: '#166534',
    warn: '#7a4f00',
    danger: '#a61b1b',
    info: '#1d4ed8',
    sidebar: '#fbfcfd',
    'sidebar-foreground': '#171b22',
    'sidebar-primary': '#0369a1',
    'sidebar-primary-foreground': '#ffffff',
    'sidebar-accent': '#edf1f3',
    'sidebar-accent-foreground': '#171b22',
    'sidebar-border': 'rgba(27, 34, 45, 0.11)',
    'sidebar-ring': '#0369a1',
    'grain-opacity': '0',
  },
}

export const PALETTES: Record<PaletteId, PaletteDefinition> = { tactical, graphite }

export function paletteTokens(palette: PaletteId, mode: ResolvedTheme): ColorTokens {
  return PALETTES[palette][mode]
}
