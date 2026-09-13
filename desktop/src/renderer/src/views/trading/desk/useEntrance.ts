import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { ENTRANCE_MS, LEAVE_MS, shouldPlayEntrance, type DeskMode } from './mode-logic'

export type EnterPhase = 'trading' | 'chat' | null

/**
 * Drives `data-enter` on the mode shell: "trading" for the desk's power-on
 * choreography, "chat" for the short reverse, null at rest. The attribute
 * is cleared by a timer bound to the same numbers the CSS uses (the last
 * keyframe's `animationend` would do, but a timer cannot be lost to a
 * re-render mid-sequence).
 */
export function useEntrance(input: { mode: DeskMode; still: boolean; requested: boolean }): {
  enter: EnterPhase
} {
  const reduced = Boolean(useReducedMotion())
  const [enter, setEnter] = useState<EnterPhase>(null)
  const prevMode = useRef<DeskMode | null>(null)
  const { mode, still, requested } = input

  useEffect(() => {
    const prev = prevMode.current
    prevMode.current = mode
    let next: EnterPhase = null
    if (shouldPlayEntrance({ prevMode: prev, mode, reducedMotion: reduced, still, requested })) {
      next = 'trading'
    } else if (prev === 'trading' && mode === 'chat' && !reduced) {
      next = 'chat'
    }
    if (!next) return
    setEnter(next)
    const timer = window.setTimeout(
      () => setEnter(null),
      next === 'trading' ? ENTRANCE_MS + 40 : LEAVE_MS + 20,
    )
    return () => window.clearTimeout(timer)
    // `still`/`requested` are read at the moment the mode changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, reduced])

  return { enter }
}
