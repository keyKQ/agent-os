import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const controlCss = readFileSync('src/styles/control-surface.css', 'utf8')
const globalsCss = readFileSync('src/styles/globals.css', 'utf8')
const setupCss = readFileSync('src/views/setup/setup.css', 'utf8')
const cronCss = readFileSync('src/views/cron/cron.css', 'utf8')

describe('Control surface CSS contract', () => {
  it('keeps the collapsed desktop sidebar as a centered floating icon rail', () => {
    expect(controlCss).toMatch(
      /\.shell\[data-design='unified'\] \.shell-sidebar\[data-collapsed='true'\] \{\s*width: 5rem;/,
    )
    expect(controlCss).toMatch(
      /\.shell\[data-design='unified'\][\s\S]*?\.shell-sidebar\[data-collapsed='true'\][\s\S]*?\.shell-nav-link \{[\s\S]*?justify-content: center;[\s\S]*?padding-inline: 0;/,
    )
  })

  it('shares the modern shell tokens across Chat and Control routes', () => {
    expect(controlCss).toMatch(/:root\[data-theme='dark'\] \.shell\[data-design='unified'\]/)
    expect(controlCss).toMatch(
      /\.shell\[data-design='unified'\] \.shell-sidebar \{[\s\S]*?border-radius: var\(--radius-dialog\);[\s\S]*?box-shadow:/,
    )
    expect(controlCss).not.toMatch(/\.shell-header--unified/)
  })

  it('takes the mobile drawer out of flex flow so route content keeps the viewport width', () => {
    expect(controlCss).toMatch(
      /@media \(max-width: 768px\)[\s\S]*?\.shell\[data-design='unified'\] \.shell-sidebar \{[\s\S]*?position: fixed;/,
    )
  })

  it('uses one semantic soft-radius scale across controls, surfaces, and dialogs', () => {
    expect(globalsCss).toMatch(/--radius-compact: 6px;/)
    expect(globalsCss).toMatch(/--radius-control: 8px;/)
    expect(globalsCss).toMatch(/--radius: 10px;/)
    expect(globalsCss).toMatch(/--radius-surface: 14px;/)
    expect(globalsCss).toMatch(/--radius-dialog: 18px;/)
    expect(globalsCss).toMatch(/--radius-pill: 999px;/)

    expect(controlCss).toMatch(
      /\.control-surface \.panel,[\s\S]*?border-radius: var\(--radius-surface\);/,
    )
    expect(controlCss).toMatch(
      /:is\(\.ag-modal, \.sess-modal, \.sk-modal, \.cron-modal, \.cron-panel\) \{[\s\S]*?border-radius: var\(--radius-dialog\);/,
    )
  })

  it('retires square legacy Setup and Cron controls while preserving structural seams', () => {
    expect(setupCss).not.toMatch(/border-radius:\s*(?:0|[1-3]px)/)
    expect(cronCss).not.toMatch(/border-radius:\s*(?:0|[1-3]px)/)
    expect(controlCss.match(/border-radius:\s*0;/g)).toHaveLength(1)
    expect(controlCss).toMatch(
      /:is\([\s\S]*?\.ov-stats,[\s\S]*?\.ap-stats[\s\S]*?\) \{[\s\S]*?border: 0;[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/,
    )
  })

  it('mirrors Control tokens into every portalled dialog family including Cron', () => {
    expect(controlCss).toMatch(
      /:root\[data-theme='dark'\][\s\S]*?:is\(\.ag-modal__overlay, \.sess-modal__overlay, \.sk-modal__overlay, \.cron-modal__overlay\)/,
    )
    expect(controlCss).toMatch(
      /:root\[data-theme='light'\][\s\S]*?:is\(\.ag-modal__overlay, \.sess-modal__overlay, \.sk-modal__overlay, \.cron-modal__overlay\)/,
    )
  })

  it('lets the session workflow dialog use the wider control-page measure', () => {
    expect(controlCss).toMatch(/\.sess-modal,\s*\.sk-modal \{\s*max-width: 46rem;/)
    expect(controlCss).toMatch(/\.sess-modal\.sess-confirm \{\s*max-width: 32rem;/)
  })

  it('renders an unframed ASCII signal field behind Control headers with safe motion fallbacks', () => {
    expect(controlCss).toMatch(
      /\.control-surface > \.ascii-field \{[\s\S]*?height: 10rem;[\s\S]*?border: 0;[\s\S]*?box-shadow: none;/,
    )
    expect(controlCss).toMatch(
      /@keyframes control-signal-sweep \{[\s\S]*?transform: translate3d\([\s\S]*?opacity:/,
    )
    expect(controlCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.control-surface > \.ascii-field::after \{[\s\S]*?animation: none;/,
    )
  })

  it('keeps data surfaces separated from their page header without doubling Setup or Cron gaps', () => {
    expect(controlCss).toMatch(
      /\.control-surface\s+:is\([\s\S]*?\.ov-stage__header,[\s\S]*?\.cfg-stage__header[\s\S]*?\) \{\s*margin-bottom: 1\.5rem;/,
    )
    expect(controlCss).not.toMatch(
      /:is\([\s\S]*?\.setup-stage__header,[\s\S]*?\.cron-stage__header[\s\S]*?\) \{\s*margin-bottom: 1\.5rem;/,
    )
  })
})
