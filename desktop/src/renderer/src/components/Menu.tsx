import { useEffect, useRef } from 'react'

/**
 * A small anchored menu (NSMenu posture) for a "…" or chip trigger. The
 * parent positions it; this closes on Escape or a press outside the
 * trigger's container, and moves focus to the first item on open.
 * Styling lives in projects.css (.proj-menu, .proj-menu__item).
 */
export function Menu({
  children,
  onClose,
  label,
}: {
  children: React.ReactNode
  onClose: () => void
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [],
        )
        if (items.length === 0) return
        e.preventDefault()
        const i = items.indexOf(document.activeElement as HTMLElement)
        const next =
          e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
        items[next]?.focus()
      }
    }
    const onDown = (e: MouseEvent) => {
      const anchor = ref.current?.parentElement
      if (anchor && !anchor.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])
  return (
    <div ref={ref} className="proj-menu app-no-drag" role="menu" aria-label={label}>
      {children}
    </div>
  )
}
