import './chat.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRpc } from '@/app/providers'
import { Attachments, useAttachments } from './Attachments'
import { Composer, type ComposerHandle } from './Composer'
import { canonicalSessionKey, hasPendingAttachmentWork, readSessionFromUrl } from './logic'
import { SlashMenu, type SlashMenuHandle } from './SlashMenu'
import { useSlashCommands } from './useSlashCommands'
import { useTranscript } from './useTranscript'

/**
 * Chat view — full-bleed shell.
 *
 * Mounts the scroll thread region (owned by the transcript controller) above a
 * pinned composer row. Task 9 adds the attachment surface: the pending buffer +
 * tray (`useAttachments` / `<Attachments>`), drag-and-drop + image-paste onto
 * the thread (chat.js:2543-2572), and the normalize-then-send path that threads
 * attachments into `chat.send` (chat.js:6078/6157).
 */
export function ChatPage() {
  // Read the RPC client so the provider seam is wired from the foundation
  // (parity chat.js:1200); consumed by useTranscript for history/stream/send.
  useRpc()

  // Resolve the initial session key from the URL (chat.js:1182-1187 →
  // canonicalized, chat.js:1159-1165), falling back to the stable webchat key.
  const sessionKey = canonicalSessionKey(
    readSessionFromUrl(typeof window !== 'undefined' ? window.location.search : '') ?? '',
  )

  const { containerRef, send, abort, busy, history } = useTranscript({ sessionKey })
  const attachments = useAttachments()

  // The composer value mirror (chat.js:2639 `_textarea.value`) — drives the slash
  // menu's open/filter state. Owned here so the menu + composer share one value.
  const [composerValue, setComposerValue] = useState('')
  const slashHandleRef = useRef<SlashMenuHandle>(null)
  const composerHandleRef = useRef<ComposerHandle>(null)

  // Slash catalog + execution (chat.js:2615/2842). `new_chat` / `compact` are the
  // session/stream-mutating actions; they are FLAGGED as later-task seams inside
  // the hook (no `onSessionAction` wired yet — the session-swap primitives are a
  // later task). Every RPC-backed command (reset/usage/model/router.hold) works.
  const { commands, execute: executeSlash } = useSlashCommands({ sessionKey })

  useEffect(() => {
    document.title = 'Chat - AgentOS Control'
  }, [])

  // The composer's send. Resolves the Task-9 `//` literal-slash escape + the
  // slash-command interception, verbatim from `_onSend` (chat.js:6062-6118):
  //   1. `//…`  → strip ONE leading `/`, send as a LITERAL message (not a command).
  //   2. `/cmd` → intercept + execute the slash command; do NOT send as text.
  //   3. else   → normalize (large-paste / page-dump → generated .txt) + chat.send.
  const onComposerSend = useCallback(
    async (rawText: string) => {
      let text = rawText
      let isLiteralSlash = false
      // chat.js:6072-6076 — `//` escape: strip one slash, mark literal.
      if (text.startsWith('//')) {
        isLiteralSlash = true
        text = text.slice(1)
      }
      // chat.js:6077 — a real (non-escaped) `/`-prefixed line is a slash command.
      const isSlashCommand = !isLiteralSlash && text.startsWith('/')

      // chat.js:6113-6116 — intercept + execute; a handled command never sends as
      // text. (The streaming-enqueue branch at chat.js:6091 is a Task-13 seam; a
      // send while busy is currently a no-op in useTranscript.send.)
      if (isSlashCommand) {
        setComposerValue('')
        if (await executeSlash(text)) return
      }

      // chat.js:6078-6082 — normalize with the resolved slash flag (a real slash
      // command bypasses paste/page-dump normalization; here it already returned).
      const normalized = await attachments.normalizeForSend(text, isSlashCommand)
      if (!normalized) return // over the text hard cap; the helper already toasted.
      setComposerValue('')
      send(normalized.text, normalized.attachments)
      attachments.clear()
    },
    [attachments, send, executeSlash],
  )

  // The composer's slash-key intercept — consult the menu handle before the
  // composer runs its own history/send/ESC handling (chat.js:2654-2662/2675).
  const onSlashKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
      slashHandleRef.current?.handleKeyDown(e) ?? false,
    [],
  )

  // A menu selection (Enter/click) executes the command AND clears the composer
  // textarea (chat.js:2685-2687 `_selectSlashCmd` closes + clears then runs). The
  // keyboard-Enter path already clears via the composer's doSend, but a mouse
  // click bypasses it, so clear imperatively here for both.
  const onMenuExecute = useCallback(
    (text: string) => {
      composerHandleRef.current?.clear()
      setComposerValue('')
      void onComposerSend(text)
    },
    [onComposerSend],
  )

  // chat.js:2543-2555 — drag-and-drop files onto the thread stage the files.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.files?.length) attachments.addFiles(e.dataTransfer.files)
    },
    [attachments],
  )
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  // chat.js:2557-2571 — clipboard image paste stages the image(s) as attachments.
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length > 0) {
        attachments.addFiles(files)
        e.preventDefault()
      }
    },
    [attachments],
  )

  return (
    <div className="chat-stage" onDrop={onDrop} onDragOver={onDragOver} onPaste={onPaste}>
      <div className="chat-thread" ref={containerRef} />
      <Composer
        onSend={onComposerSend}
        onValueChange={setComposerValue}
        onSlashKeyDown={onSlashKeyDown}
        composerRef={composerHandleRef}
        slashMenu={
          <SlashMenu
            value={composerValue}
            commands={commands}
            onExecute={onMenuExecute}
            handleRef={slashHandleRef}
          />
        }
        onAbort={abort}
        busy={busy}
        history={history}
        hasPendingAttachments={attachments.attachments.length > 0}
        hasPendingWork={hasPendingAttachmentWork(attachments.attachments)}
        onAttachFiles={attachments.addFiles}
        tray={<Attachments api={attachments} />}
      />
    </div>
  )
}
