import { describe, it, expect } from 'vitest'
import { mergeHistoryMessagePages, messagePageIdentity } from './history'
import type { ChatMessage } from '../types'

describe('messagePageIdentity (parity chat.js:5350)', () => {
  it('keys on the stable message_id when present', () => {
    const msg = { role: 'user', text: 'hi', message_id: 'abc' } as unknown as ChatMessage
    expect(messagePageIdentity(msg)).toBe('stable:abc')
  })

  it('falls back to id when message_id is absent', () => {
    const msg = { role: 'assistant', text: 'yo', id: 42 } as unknown as ChatMessage
    expect(messagePageIdentity(msg)).toBe('stable:42')
  })

  it('falls back to role|text identity when neither id is present', () => {
    const msg = { role: 'user', text: 'hello' } as unknown as ChatMessage
    // parity: fallback:_historyFallbackMessageIdentity(role, text) = `${role}|${text.trim()}`
    expect(messagePageIdentity(msg)).toBe('fallback:user|hello')
  })

  it('returns "" for a nullish message', () => {
    expect(messagePageIdentity(null as unknown as ChatMessage)).toBe('')
  })
})

describe('mergeHistoryMessagePages (parity chat.js:5357)', () => {
  it('prepends older messages without duplicating the overlap boundary', () => {
    const current = [
      { role: 'user', text: 'b' },
      { role: 'assistant', text: 'c' },
    ]
    const older = [
      { role: 'user', text: 'a' },
      { role: 'user', text: 'b' },
    ]
    const merged = mergeHistoryMessagePages(older as never, current as never)
    expect(merged.map((m) => m.text)).toEqual(['a', 'b', 'c']) // b deduped by identity
  })

  it('dedups the overlap boundary by stable id, keeping the older-page instance', () => {
    const older = [
      { role: 'user', text: 'A', message_id: '1' },
      { role: 'assistant', text: 'B', message_id: '2' },
    ]
    const current = [
      { role: 'assistant', text: 'B (edited)', message_id: '2' },
      { role: 'user', text: 'C', message_id: '3' },
    ]
    const merged = mergeHistoryMessagePages(older as never, current as never)
    // identity 2 appears first in older → older wins; current's dupe dropped.
    expect(merged.map((m) => (m as { message_id?: string }).message_id)).toEqual(['1', '2', '3'])
    expect(merged[1]?.text).toBe('B')
  })

  it('tolerates nullish page arguments', () => {
    const current = [{ role: 'user', text: 'x' }]
    expect(mergeHistoryMessagePages(null as never, current as never).map((m) => m.text)).toEqual([
      'x',
    ])
    expect(
      mergeHistoryMessagePages(current as never, undefined as never).map((m) => m.text),
    ).toEqual(['x'])
    expect(mergeHistoryMessagePages(null as never, undefined as never)).toEqual([])
  })

  it('dedups two id-less rows with the same role+text via the fallback identity', () => {
    // parity chat.js:5350-5354 — with no stable id, identity is
    // `fallback:${role}|${text.trim()}` (always truthy), so identical id-less
    // rows across the page boundary collapse to one.
    const older = [{ role: 'system', text: 'ping' }]
    const current = [{ role: 'system', text: 'ping' }]
    const merged = mergeHistoryMessagePages(older as never, current as never)
    expect(merged.length).toBe(1)
  })
})
