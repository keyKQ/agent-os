import { create } from 'zustand'
import { BOOK_DEFAULT, BOOK_MAX, BOOK_MIN } from '~/views/trading/desk/desk-logic'

/**
 * The desk's own chrome state: the BOOK's width and whether it is open, the
 * tab it shows, and the full-desk toggle. Width and open-ness persist; the
 * tab and mode are per launch.
 */

const WIDTH_KEY = 'agentos-desktop.trading.bookWidth'
const OPEN_KEY = 'agentos-desktop.trading.bookOpen'
const SESSION_KEY = 'agentos-desktop.trading.sessionKey'
const FILED_KEY = 'agentos-desktop.trading.sessionFiled'

function loadWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(raw) && raw >= BOOK_MIN && raw <= BOOK_MAX) return raw
  } catch {
    /* storage unavailable */
  }
  return BOOK_DEFAULT
}

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false'
  } catch {
    return true
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

export type BookTab = 'portfolio' | 'swap' | 'orders' | 'history'

interface TradingUiStore {
  bookWidth: number
  bookOpen: boolean
  bookTab: BookTab
  /** The full-width desk instead of chat + BOOK. */
  deskMode: boolean
  setBookWidth(width: number): void
  toggleBook(): void
  setBookOpen(open: boolean): void
  setBookTab(tab: BookTab): void
  setDeskMode(on: boolean): void
}

export const useTradingUi = create<TradingUiStore>((set) => ({
  bookWidth: loadWidth(),
  bookOpen: loadOpen(),
  bookTab: 'portfolio',
  deskMode: false,
  setBookWidth(width) {
    const clamped = Math.round(Math.min(BOOK_MAX, Math.max(BOOK_MIN, width)))
    save(WIDTH_KEY, String(clamped))
    set({ bookWidth: clamped })
  },
  toggleBook() {
    set((s) => {
      save(OPEN_KEY, String(!s.bookOpen))
      return { bookOpen: !s.bookOpen }
    })
  },
  setBookOpen(open) {
    save(OPEN_KEY, String(open))
    set({ bookOpen: open })
  },
  setBookTab(tab) {
    set({ bookTab: tab, bookOpen: true })
    save(OPEN_KEY, 'true')
  },
  setDeskMode(on) {
    set({ deskMode: on })
  },
}))

/** The desk's chat session, remembered across launches. */
export function readTradingSessionKey(): string {
  try {
    return localStorage.getItem(SESSION_KEY) || ''
  } catch {
    return ''
  }
}

export function writeTradingSessionKey(key: string): void {
  save(SESSION_KEY, key)
  save(FILED_KEY, 'false')
}

export function readTradingSessionFiled(): boolean {
  try {
    return localStorage.getItem(FILED_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeTradingSessionFiled(filed: boolean): void {
  save(FILED_KEY, String(filed))
}
