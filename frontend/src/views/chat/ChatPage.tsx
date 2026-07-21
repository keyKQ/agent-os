import './chat.css'
import { useEffect } from 'react'
import { useRpc } from '@/app/providers'
import { Composer } from './Composer'
import { canonicalSessionKey, readSessionFromUrl } from './logic'
import { useTranscript } from './useTranscript'

/**
 * Chat view — full-bleed shell (Task 1 foundation).
 *
 * This is scaffolding: it mounts the scroll thread region (owned by the
 * transcript controller) above a pinned composer row, and sets the document
 * title. Nothing streams yet — RPC subscription, rendering, and the real
 * composer arrive in later tasks. `useRpc()` is read here so the seam matches
 * the migrated views (chat.js:1200 `App.getRpc()`), even though the client is
 * unused at this stage.
 */
export function ChatPage() {
  // Read the RPC client so the provider seam is wired from the foundation
  // (parity chat.js:1200); later tasks consume it for history/stream/send.
  useRpc()

  // Resolve the initial session key from the URL (chat.js:1182-1187 →
  // canonicalized, chat.js:1159-1165), falling back to the stable webchat key.
  const sessionKey = canonicalSessionKey(
    readSessionFromUrl(typeof window !== 'undefined' ? window.location.search : '') ?? '',
  )

  const { containerRef, send, abort, busy, history } = useTranscript({ sessionKey })

  useEffect(() => {
    document.title = 'Chat - AgentOS Control'
  }, [])

  return (
    <div className="chat-stage">
      <div className="chat-thread" ref={containerRef} />
      {/* The command-line composer (Task 8). Send → chat.send, abort → chat.abort,
          both wired through the transcript controller (chat.js:6193 / 8444). */}
      <Composer onSend={send} onAbort={abort} busy={busy} history={history} />
    </div>
  )
}
