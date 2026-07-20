import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom ships no `window.matchMedia`. `motion`'s `useReducedMotion()` reads
// `(prefers-reduced-motion: reduce)` through it, so without a stub the hook
// would see no match and attempt real enter/exit animations — which jsdom
// cannot drive to completion, hanging AnimatePresence exits (and the
// `waitFor(...).not.toBeInTheDocument()` unmount assertions with them). We
// report reduced-motion = true so motion degrades to instant mount/unmount,
// exactly as it does for a real user who prefers reduced motion. The unmount
// assertions still verify the dialog is genuinely removed.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// Standard test hygiene: unmount rendered trees and reset spy call history
// between tests so per-test `vi.fn()` call counts start from zero. Module
// mock factories (vi.mock) are unaffected; each test re-establishes its own
// mockResolvedValue/mockRejectedValue implementations.
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
