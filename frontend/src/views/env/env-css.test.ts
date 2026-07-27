import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/views/env/env.css', 'utf8')
const controlCss = readFileSync('src/styles/control-surface.css', 'utf8')

describe('Environment screen CSS contract', () => {
  it('keeps the shadowed-variable warning a full-width band, not a subtle hint', () => {
    // It explains the one failure mode operators cannot diagnose on their own.
    expect(css).toMatch(/\.control-surface \.env-warning \{[\s\S]*?display: flex;/)
    expect(css).toMatch(/\.control-surface \.env-warning \{[\s\S]*?border: 1px solid/)
  })

  it('uses a four-way filter row that collapses to two columns on mobile', () => {
    expect(css).toMatch(
      /\.control-surface \.env-filters \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/,
    )
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.control-surface \.env-filters \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    )
  })

  it('collapses variable rows to a single column on narrow screens', () => {
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.control-surface \.env-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/,
    )
  })

  it('scopes its classes to this view instead of the shared control surface', () => {
    expect(controlCss).not.toMatch(/\.env-row|\.env-filter(?:s|\s|\.)|\.env-badge/)
  })

  it('stops the refresh spinner for reduced motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.env-spin \{[\s\S]*?animation: none;/,
    )
  })
})
