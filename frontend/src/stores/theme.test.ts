import { beforeEach, describe, expect, it } from 'vitest'
import { initTheme, useTheme } from './theme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('theme store', () => {
  it('initTheme applies stored preference', () => {
    localStorage.setItem('agentos-theme', 'dark')
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(useTheme.getState().mode).toBe('dark')
  })

  it('set persists and applies', () => {
    initTheme()
    useTheme.getState().set('dark')
    expect(localStorage.getItem('agentos-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('toggle flips the mode', () => {
    localStorage.setItem('agentos-theme', 'light')
    initTheme()
    useTheme.getState().toggle()
    expect(useTheme.getState().mode).toBe('dark')
  })

  it('rejects invalid modes', () => {
    initTheme()
    const before = useTheme.getState().mode
    // @ts-expect-error runtime guard mirrors legacy theme.js
    useTheme.getState().set('purple')
    expect(useTheme.getState().mode).toBe(before)
  })
})
