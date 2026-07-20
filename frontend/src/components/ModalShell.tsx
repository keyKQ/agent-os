import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { SUBTLE_SPRING, overlayVariants, panelVariants } from '@/lib/motion'

// Shared modal shell for the tokenized dialogs across the agents / sessions /
// skills views. Superset of the three previously-duplicated inline shells:
//   - role: 'dialog' | 'alertdialog' (destructive confirms use alertdialog)
//   - aria-labelledby / optional aria-describedby
//   - focus the first focusable control on open (input,textarea,select,button)
//   - Escape closes (stopPropagation so a nested confirm doesn't also bubble up)
//   - backdrop mousedown closes (only when the press starts on the overlay)
// Each view keeps its own scoped CSS by passing overlayClassName + className
// (e.g. ag-modal / sess-modal / sk-modal), so the extraction is behavior-only.
//
// Motion (purely additive, "Subtle" tier): the overlay fades and the panel
// scales/opacity 0.97→1 on enter, reversing on exit. Exit is only played when
// the call site wraps this shell in `<AnimatePresence>` (each dialog does). All
// of the above behavior is untouched, and reduced-motion viewers get instant
// mount/unmount with no transition.
export function ModalShell({
  role,
  labelledBy,
  describedBy,
  onClose,
  overlayClassName,
  className,
  children,
}: {
  role: 'dialog' | 'alertdialog'
  labelledBy: string
  describedBy?: string
  onClose: () => void
  overlayClassName: string
  className?: string
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()

  useEffect(() => {
    // Focus the first focusable control for keyboard users.
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea, select, button',
    )
    first?.focus()
  }, [])

  // Reduced-motion (and the jsdom test env, which reports reduced-motion): no
  // transition on either element, so mount/unmount is instant.
  const overlayMotion = reduce
    ? { transition: { duration: 0 } }
    : { variants: overlayVariants, transition: { duration: 0.18 } }
  const panelMotion = reduce
    ? { transition: { duration: 0 } }
    : { variants: panelVariants, transition: SUBTLE_SPRING }

  // Render into document.body via a portal so the fixed overlay is anchored to
  // the viewport, NOT to whatever transformed ancestor it happens to sit under
  // (a `transform` on any ancestor — e.g. the view-enter animation on
  // .view-container — becomes the containing block for `position: fixed`,
  // which would shrink the overlay and knock the dialog off-center).
  return createPortal(
    <motion.div
      className={overlayClassName}
      initial="initial"
      animate="animate"
      exit="exit"
      {...overlayMotion}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <motion.div
        ref={panelRef}
        className={className}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        initial="initial"
        animate="animate"
        exit="exit"
        {...panelMotion}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  )
}
