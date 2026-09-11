import { describe, expect, it } from 'vitest'
import { derivePetState, isPetSlug, petStateRow, sheetGeometry } from './pet'

describe('petdex sheets', () => {
  it('reads the frame grid from the pixel size', () => {
    expect(sheetGeometry(1536, 1872)).toEqual({ cols: 8, rows: 9 })
    expect(sheetGeometry(1536, 2288)).toEqual({ cols: 8, rows: 11 })
    expect(sheetGeometry(1728, 1664)).toEqual({ cols: 9, rows: 8 })
    expect(sheetGeometry(1000, 1000)).toBeNull()
  })

  it('maps states to rows in both taxonomies', () => {
    expect(petStateRow('idle', 9)).toBe(0)
    expect(petStateRow('wave', 9)).toBe(3)
    expect(petStateRow('jump', 9)).toBe(4)
    expect(petStateRow('failed', 9)).toBe(5)
    expect(petStateRow('waiting', 9)).toBe(6)
    expect(petStateRow('run', 9)).toBe(7)
    expect(petStateRow('review', 9)).toBe(8)
    expect(petStateRow('run', 8)).toBe(2)
    expect(petStateRow('waiting', 8)).toBe(0)
  })

  it('derives the state in Hermes priority order', () => {
    expect(derivePetState({})).toBe('idle')
    expect(derivePetState({ busy: true })).toBe('run')
    expect(derivePetState({ busy: true, awaitingInput: true })).toBe('waiting')
    expect(derivePetState({ awaitingInput: true, justCompleted: true })).toBe('wave')
    expect(derivePetState({ justCompleted: true, celebrate: true })).toBe('jump')
    expect(derivePetState({ celebrate: true, error: true })).toBe('failed')
    expect(derivePetState({ reasoning: true })).toBe('review')
  })

  it('accepts petdex slugs only', () => {
    expect(isPetSlug('cache-capy')).toBe(true)
    expect(isPetSlug('Cache Capy')).toBe(false)
    expect(isPetSlug('../x')).toBe(false)
    expect(isPetSlug('')).toBe(false)
  })
})
