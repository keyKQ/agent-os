import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEntrance } from './useEntrance'

const reduced = vi.hoisted(() => ({ value: false }))
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react')
  return { ...actual, useReducedMotion: () => reduced.value }
})

describe('useEntrance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    reduced.value = false
  })
  afterEach(() => vi.useRealTimers())

  it('sets data-enter=trading on a switch from chat and clears it after the choreography', () => {
    const { result, rerender } = renderHook(
      (p: { mode: 'chat' | 'trading' }) =>
        useEntrance({ mode: p.mode, still: false, requested: false }),
      { initialProps: { mode: 'chat' as 'chat' | 'trading' } },
    )
    expect(result.current.enter).toBeNull()
    rerender({ mode: 'trading' })
    expect(result.current.enter).toBe('trading')
    act(() => vi.advanceTimersByTime(800))
    expect(result.current.enter).toBeNull()
    // Re-rendering in trading mode does not replay it.
    rerender({ mode: 'trading' })
    expect(result.current.enter).toBeNull()
  })

  it('plays on a fresh mount only when the desk was requested', () => {
    const quiet = renderHook(() => useEntrance({ mode: 'trading', still: false, requested: false }))
    expect(quiet.result.current.enter).toBeNull()
    const asked = renderHook(() => useEntrance({ mode: 'trading', still: false, requested: true }))
    expect(asked.result.current.enter).toBe('trading')
  })

  it('skips the choreography under reduced motion and while an ask is pending', () => {
    reduced.value = true
    const r1 = renderHook(
      (p: { mode: 'chat' | 'trading' }) =>
        useEntrance({ mode: p.mode, still: false, requested: false }),
      { initialProps: { mode: 'chat' as 'chat' | 'trading' } },
    )
    r1.rerender({ mode: 'trading' })
    expect(r1.result.current.enter).toBeNull()
    reduced.value = false
    const r2 = renderHook(
      (p: { mode: 'chat' | 'trading' }) =>
        useEntrance({ mode: p.mode, still: true, requested: false }),
      { initialProps: { mode: 'chat' as 'chat' | 'trading' } },
    )
    r2.rerender({ mode: 'trading' })
    expect(r2.result.current.enter).toBeNull()
  })

  it('plays the short reverse when leaving', () => {
    const r = renderHook(
      (p: { mode: 'chat' | 'trading' }) =>
        useEntrance({ mode: p.mode, still: false, requested: true }),
      { initialProps: { mode: 'trading' as 'chat' | 'trading' } },
    )
    act(() => vi.advanceTimersByTime(800))
    r.rerender({ mode: 'chat' })
    expect(r.result.current.enter).toBe('chat')
    act(() => vi.advanceTimersByTime(400))
    expect(r.result.current.enter).toBeNull()
  })
})
