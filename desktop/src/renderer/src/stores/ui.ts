import { create } from 'zustand'

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 220
/** Dragging narrower than this snaps the sidebar closed, like Finder. */
export const SIDEBAR_COLLAPSE_AT = 120

const WIDTH_KEY = 'agentos-desktop.sidebarWidth'

function loadWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(raw) && raw >= SIDEBAR_MIN && raw <= SIDEBAR_MAX) return raw
  } catch {
    /* storage unavailable */
  }
  return SIDEBAR_DEFAULT
}

function saveWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width))
  } catch {
    /* storage unavailable */
  }
}

interface UiStore {
  sidebarOpen: boolean
  sidebarWidth: number
  sessionQuery: string
  /** The Scheduled jobs panel is a layer over the window, not a route. */
  jobsOpen: boolean
  toggleSidebar(): void
  setSidebarWidth(width: number): void
  resetSidebarWidth(): void
  setSessionQuery(q: string): void
  openJobs(): void
  closeJobs(): void
  toggleJobs(): void
}

/** Chrome state. Only the sidebar width survives a relaunch. */
export const useUi = create<UiStore>((set) => ({
  sidebarOpen: true,
  sidebarWidth: loadWidth(),
  sessionQuery: '',
  jobsOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (width) => {
    const clamped = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)))
    saveWidth(clamped)
    set({ sidebarWidth: clamped, sidebarOpen: true })
  },
  resetSidebarWidth: () => {
    saveWidth(SIDEBAR_DEFAULT)
    set({ sidebarWidth: SIDEBAR_DEFAULT, sidebarOpen: true })
  },
  setSessionQuery: (sessionQuery) => set({ sessionQuery }),
  openJobs: () => set({ jobsOpen: true }),
  closeJobs: () => set({ jobsOpen: false }),
  toggleJobs: () => set((s) => ({ jobsOpen: !s.jobsOpen })),
}))
