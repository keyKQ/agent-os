import { create } from 'zustand'
import { DEFAULT_SECTION, type SettingsSection } from '~/views/settings/sections'

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

const FOLDERS_KEY = 'agentos-desktop.openFolders'

function loadOpenFolders(): ReadonlySet<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]')
    if (Array.isArray(raw)) return new Set(raw.filter((x) => typeof x === 'string'))
  } catch {
    /* storage unavailable or corrupt */
  }
  return new Set()
}

function saveOpenFolders(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify([...ids]))
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
  /** Settings is a sheet over the window too; remembers the section between opens. */
  settingsOpen: boolean
  settingsSection: SettingsSection
  /** Project folders currently disclosed in the sidebar. */
  openFolders: ReadonlySet<string>
  /** The inline "new project" row is showing in the sidebar. */
  creatingProject: boolean
  toggleSidebar(): void
  setSidebarWidth(width: number): void
  resetSidebarWidth(): void
  setSessionQuery(q: string): void
  openJobs(): void
  closeJobs(): void
  toggleJobs(): void
  openSettings(section?: SettingsSection): void
  closeSettings(): void
  toggleSettings(): void
  setSettingsSection(section: SettingsSection): void
  toggleFolder(id: string): void
  setFolderOpen(id: string, open: boolean): void
  startCreatingProject(): void
  stopCreatingProject(): void
}

/** Chrome state. The sidebar width and open folders survive a relaunch. */
export const useUi = create<UiStore>((set) => ({
  sidebarOpen: true,
  sidebarWidth: loadWidth(),
  sessionQuery: '',
  jobsOpen: false,
  settingsOpen: false,
  settingsSection: DEFAULT_SECTION,
  openFolders: loadOpenFolders(),
  creatingProject: false,
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
  // One sheet at a time: opening Settings closes Jobs and vice versa.
  openJobs: () => set({ jobsOpen: true, settingsOpen: false }),
  closeJobs: () => set({ jobsOpen: false }),
  toggleJobs: () => set((s) => ({ jobsOpen: !s.jobsOpen })),
  openSettings: (section) =>
    set((s) => ({
      settingsOpen: true,
      jobsOpen: false,
      settingsSection: section ?? s.settingsSection,
    })),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, jobsOpen: false })),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  toggleFolder: (id) =>
    set((s) => {
      const next = new Set(s.openFolders)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveOpenFolders(next)
      return { openFolders: next }
    }),
  setFolderOpen: (id, open) =>
    set((s) => {
      if (s.openFolders.has(id) === open) return s
      const next = new Set(s.openFolders)
      if (open) next.add(id)
      else next.delete(id)
      saveOpenFolders(next)
      return { openFolders: next }
    }),
  startCreatingProject: () => set({ creatingProject: true, sidebarOpen: true }),
  stopCreatingProject: () => set({ creatingProject: false }),
}))
