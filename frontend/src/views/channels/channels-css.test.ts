import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/views/channels/channels.css', 'utf8')

describe('Channels integration workspace CSS contract', () => {
  it('integrates channel metrics into one posture surface', () => {
    expect(css).toMatch(
      /\.control-surface \.ch-command \.ch-stats \{[\s\S]*?grid-template-columns: 1\.25fr repeat\(4, minmax\(0, 1fr\)\);/,
    )
    expect(css).toMatch(
      /\.control-surface \.ch-command \.ch-stat \{[\s\S]*?border-left: 1px solid var\(--hairline\);[\s\S]*?border-radius: 0;/,
    )
    expect(css).toMatch(
      /\.control-surface \.ch-command \.ch-stat:first-child \{[^}]*box-shadow: none;/,
    )
    expect(css).not.toMatch(/\.ch-command \.ch-stat:first-child \{[^}]*inset 2px 0 0/)
  })

  it('presents adapters as rounded status-aware inventory surfaces', () => {
    expect(css).toMatch(
      /\.control-surface \.ch-card\.ch-card \{[\s\S]*?border-radius: var\(--radius-surface\);/,
    )
    expect(css).toMatch(
      /\.control-surface \.ch-card\.ch-card::before \{[\s\S]*?background: var\(--tone, var\(--dim\)\);/,
    )
    expect(css).toMatch(/\.ch-access \{[\s\S]*?border-top: 1px solid var\(--hairline\);/)
  })

  it('collapses cleanly and respects reduced motion', () => {
    expect(css).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.control-surface \.ch-command \.ch-stats,[\s\S]*?\.ch-card__meta \{[\s\S]*?grid-template-columns: 1fr;/,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ch-command,[\s\S]*?\.ch-stat__value,[\s\S]*?\.ch-command__cadence > span,[\s\S]*?\.ch-refresh-spin \{[\s\S]*?animation: none;/,
    )
  })
})
