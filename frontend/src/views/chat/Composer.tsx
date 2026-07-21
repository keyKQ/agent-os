import { useCallback, useEffect, useRef, useState } from 'react'
import { sendButtonState, shouldAutofocusComposer } from './logic'

/**
 * The chat command line (React).
 *
 * Ported from the legacy imperative composer in static/js/views/chat.js: the
 * keydown bindings (chat.js:2415-2498), the document-level ESC abort
 * (chat.js:2518-2539), the textarea auto-resize (chat.js:2584-2593), sent-
 * message history cycling on ↑/↓ (chat.js:8711-8741), and autofocus
 * (chat.js:1353-1360). Unlike the transcript region this is idiomatic React —
 * local state drives the value, and send/abort are injected callbacks so the
 * component stays decoupled from RPC. ChatPage wires `onSend` to the
 * useTranscript send action (chat.js:6062 `_onSend` → `chat.send`) and
 * `onAbort` to the abort action (chat.js:8439 `_onStop` → `chat.abort`).
 *
 * SEAM for Task 9 (attachments): `onSend` currently receives plain text. The
 * attachments task will thread a normalized payload
 * (`normalizeOutgoingComposerPayload`, chat.js:6078) + a pending-attachments
 * preview through here; the send/enqueue-while-streaming branches (chat.js:6091)
 * and slash-command handling (chat.js:6113) land with it. Until then a click /
 * Enter while `busy` is a no-op that keeps the composer intact (legacy would
 * enqueue), and the label reflects the queue intent via `sendButtonState`.
 */

const MIN_TEXTAREA_HEIGHT = 40 // chat.js:2590 fallback when minHeight is unset.
const MAX_TEXTAREA_HEIGHT = 160 // chat.js:2592 cap.

export interface ComposerProps {
  /** Send the composed text. Wired to chat.send by ChatPage (chat.js:6193). */
  onSend: (text: string) => void
  /** Abort the in-flight turn. Wired to chat.abort by ChatPage (chat.js:8444). */
  onAbort?: () => void
  /** Streaming in flight (legacy `_isStreaming`) — drives the Abort affordance. */
  busy: boolean
  /** Compaction in flight (legacy `_isCompactInFlightForCurrentSession`) — label only. */
  pendingCompaction?: boolean
  /**
   * The user's sent-message history, oldest→newest (legacy derives this from
   * `_messages` filtered to role 'user', chat.js:8712-8714). Drives ↑/↓ cycling.
   */
  history?: string[]
}

export function Composer({
  onSend,
  onAbort,
  busy,
  pendingCompaction = false,
  history = [],
}: ComposerProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // History-cycle cursor (legacy `_inputHistoryIdx` / `_inputHistoryDraft`,
  // chat.js:369). `null` = not navigating; the draft holds the pre-nav text.
  const historyIdxRef = useRef<number | null>(null)
  const historyDraftRef = useRef('')

  // chat.js:2584-2593 `_autoResizeTextarea` — grow to fit content between a min
  // and a 160px cap; an empty value clears the inline height entirely.
  const autoResize = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    if (!ta.value) {
      ta.style.height = ''
      return
    }
    const minHeight = Number.parseFloat(getComputedStyle(ta).minHeight) || MIN_TEXTAREA_HEIGHT
    ta.style.height = 'auto'
    ta.style.height = Math.max(minHeight, Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT)) + 'px'
  }, [])

  // chat.js:8695-8706 `_setTextareaProgrammatic` — write value + move the caret
  // to the end WITHOUT resetting the history cursor (the input handler's reset
  // is gated on user typing, chat.js:2405). In React the reset is keyed off the
  // input event vs. programmatic writes, so we set state directly and resize.
  const setProgrammatic = useCallback(
    (text: string) => {
      setValue(text)
      const ta = textareaRef.current
      if (ta) {
        // Apply immediately so the caret/resize don't wait for the next render.
        ta.value = text
        try {
          ta.setSelectionRange(text.length, text.length)
        } catch {
          /* ignore (jsdom / detached) */
        }
      }
      autoResize()
    },
    [autoResize],
  )

  // Autofocus on mount when the environment warrants it (chat.js:1353-1360).
  useEffect(() => {
    if (typeof window !== 'undefined' && shouldAutofocusComposer(window)) {
      textareaRef.current?.focus()
    }
  }, [])

  // chat.js:8711-8741 `_cycleHistory`. dir < 0 = older, dir > 0 = newer.
  // Returns true when the cursor moved (so the caller can preventDefault).
  const cycleHistory = useCallback(
    (dir: number): boolean => {
      if (history.length === 0) return false
      if (dir < 0) {
        if (historyIdxRef.current === null) {
          historyDraftRef.current = textareaRef.current?.value ?? value ?? ''
          historyIdxRef.current = history.length - 1
        } else {
          historyIdxRef.current = Math.max(0, historyIdxRef.current - 1)
        }
        setProgrammatic(history[historyIdxRef.current] ?? '')
        return true
      }
      if (historyIdxRef.current === null) return false
      const next = historyIdxRef.current + 1
      if (next >= history.length) {
        historyIdxRef.current = null
        setProgrammatic(historyDraftRef.current)
        historyDraftRef.current = ''
      } else {
        historyIdxRef.current = next
        setProgrammatic(history[next] ?? '')
      }
      return true
    },
    [history, setProgrammatic, value],
  )

  const doSend = useCallback(() => {
    const text = value.trim()
    // chat.js:6118 — an empty composer is a no-op. The enqueue-while-streaming
    // branch (chat.js:6091) is a Task-9 seam; until then Send is inert while busy.
    if (!text || busy) return
    onSend(text)
    setProgrammatic('')
    historyIdxRef.current = null
    historyDraftRef.current = ''
  }, [value, busy, onSend, setProgrammatic])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME composition guard (chat.js:2416).
      if (e.nativeEvent.isComposing || e.keyCode === 229) return

      // ESC: abort the stream when busy (chat.js:2530 `_onStop`), else clear the
      // input when there is text (chat.js:2449). Slash-menu/pending ESC branches
      // are Task-9 seams.
      if (e.key === 'Escape') {
        if (busy) {
          e.preventDefault()
          onAbort?.()
          return
        }
        if (textareaRef.current?.value) {
          e.preventDefault()
          setProgrammatic('')
          historyIdxRef.current = null
          historyDraftRef.current = ''
          return
        }
        return
      }

      // Plain ↑: walk backwards through sent history when the textarea is empty
      // (entering nav) OR already navigating (chat.js:2475-2481).
      if (
        e.key === 'ArrowUp' &&
        !e.altKey &&
        !e.shiftKey &&
        (!textareaRef.current?.value || historyIdxRef.current !== null)
      ) {
        if (cycleHistory(-1)) {
          e.preventDefault()
          return
        }
      }

      // Plain ↓: walk forward only when already navigating (chat.js:2486-2491).
      if (e.key === 'ArrowDown' && !e.altKey && !e.shiftKey && historyIdxRef.current !== null) {
        if (cycleHistory(1)) {
          e.preventDefault()
          return
        }
      }

      // Enter to send (no shift) — Shift+Enter inserts a newline (chat.js:2494).
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        doSend()
      }
    },
    [busy, onAbort, cycleHistory, doSend, setProgrammatic],
  )

  // chat.js:2402-2409 — user typing resets the history cursor + resizes.
  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value)
      historyIdxRef.current = null
      historyDraftRef.current = ''
      autoResize()
    },
    [autoResize],
  )

  const { disabled: sendDisabled, label: sendLabel } = sendButtonState(
    value,
    busy,
    pendingCompaction,
  )

  return (
    <div className="chat-composer">
      <textarea
        ref={textareaRef}
        className="chat-composer__input"
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="Send a message..."
        rows={1}
        aria-label="Message"
      />
      {busy ? (
        <button
          type="button"
          className="btn-term chat-composer__abort"
          onClick={() => onAbort?.()}
          title="Stop (Esc)"
          aria-label="Abort"
        >
          Abort
        </button>
      ) : (
        <button
          type="button"
          className="btn-term chat-composer__send"
          onClick={doSend}
          disabled={sendDisabled}
          title={sendLabel}
          aria-label="Send"
        >
          Send
        </button>
      )}
    </div>
  )
}
