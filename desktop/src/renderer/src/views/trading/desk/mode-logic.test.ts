import { describe, expect, it } from 'vitest'
import {
  deriveMode,
  mintTradingSessionKey,
  redirectTarget,
  shouldPlayEntrance,
  toggleTarget,
} from './mode-logic'

const DESK = 'agent:main:webchat:trading-abc123'

describe('deriveMode', () => {
  it('is trading only for the desk session', () => {
    expect(deriveMode(DESK, DESK)).toBe('trading')
    expect(deriveMode('agent:main:webchat:other', DESK)).toBe('chat')
    expect(deriveMode('', DESK)).toBe('chat')
    expect(deriveMode(DESK, '')).toBe('chat')
  })
  it('mints desk keys in the main agent', () => {
    expect(mintTradingSessionKey()).toMatch(/^agent:main:webchat:trading-[a-z0-9]+$/)
  })
})

describe('toggleTarget', () => {
  it('enters the desk and remembers the chat it left', () => {
    expect(
      toggleTarget({
        mode: 'chat',
        tradingKey: DESK,
        currentKey: 'agent:main:webchat:x1',
        returnKey: null,
      }),
    ).toEqual({ path: `/sessions/${encodeURIComponent(DESK)}`, remember: 'agent:main:webchat:x1' })
  })
  it('remembers nothing from the keyless home', () => {
    expect(
      toggleTarget({ mode: 'chat', tradingKey: DESK, currentKey: null, returnKey: null }),
    ).toEqual({ path: `/sessions/${encodeURIComponent(DESK)}`, remember: null })
  })
  it('returns to the remembered chat, else home', () => {
    expect(
      toggleTarget({
        mode: 'trading',
        tradingKey: DESK,
        currentKey: DESK,
        returnKey: 'agent:main:webchat:x1',
      }),
    ).toEqual({ path: '/sessions/agent%3Amain%3Awebchat%3Ax1', remember: null })
    expect(
      toggleTarget({ mode: 'trading', tradingKey: DESK, currentKey: DESK, returnKey: DESK }),
    ).toEqual({ path: '/sessions', remember: null })
  })
})

describe('redirectTarget', () => {
  it('keeps the query the notification carried', () => {
    expect(redirectTarget(DESK, '?order=o1')).toBe(`/sessions/${encodeURIComponent(DESK)}?order=o1`)
    expect(redirectTarget(DESK, 'desk=1')).toBe(`/sessions/${encodeURIComponent(DESK)}?desk=1`)
    expect(redirectTarget(DESK, '')).toBe(`/sessions/${encodeURIComponent(DESK)}`)
  })
})

describe('shouldPlayEntrance', () => {
  const base = {
    prevMode: 'chat' as const,
    mode: 'trading' as const,
    reducedMotion: false,
    still: false,
    requested: false,
  }
  it('plays on a switch from chat', () => {
    expect(shouldPlayEntrance(base)).toBe(true)
  })
  it('plays on a fresh mount only when the desk was asked for', () => {
    expect(shouldPlayEntrance({ ...base, prevMode: null })).toBe(false)
    expect(shouldPlayEntrance({ ...base, prevMode: null, requested: true })).toBe(true)
  })
  it('never replays on a re-render, nor under reduced motion or a pending ask', () => {
    expect(shouldPlayEntrance({ ...base, prevMode: 'trading' })).toBe(false)
    expect(shouldPlayEntrance({ ...base, reducedMotion: true })).toBe(false)
    expect(shouldPlayEntrance({ ...base, still: true })).toBe(false)
    expect(shouldPlayEntrance({ ...base, mode: 'chat' })).toBe(false)
  })
})
