import { useEffect, useRef } from 'react'
import { useApprovals } from '@/services/approval-monitor'
import { t } from '~/i18n'
import { playChime, postNotification, windowInBackground } from './notify'
import { useSettings } from '~/stores/settings'

/**
 * A reply in `sessionKey` just settled: chime and, if the window is in the
 * background, post a notification. Reads the settings at fire time so a
 * toggle takes effect on the next reply without remounting anything.
 * The first render never fires (there is no transition yet), and a session
 * switch mid-turn is not a "finished" either: the key changes, so the
 * previous `busy` is discarded.
 */
export function useReplyDoneSignal(sessionKey: string, busy: boolean, title: string): void {
  const prev = useRef<{ key: string; busy: boolean } | null>(null)
  useEffect(() => {
    const last = prev.current
    prev.current = { key: sessionKey, busy }
    if (!last || last.key !== sessionKey || !last.busy || busy) return
    const prefs = useSettings.getState().settings.notifications
    if (prefs.sound) playChime()
    if (prefs.replyDone && windowInBackground()) {
      postNotification(t('settings.notifications.replyDone.title'), title, {
        tag: `reply:${sessionKey}`,
      })
    }
  }, [sessionKey, busy, title])
}

/**
 * Approvals arrive through the console's poller into `useApprovals`. When
 * the pending count grows and the window is not in front, say so.
 */
export function useApprovalSignal(): void {
  const count = useApprovals((s) => s.pending.length)
  const prev = useRef(count)
  useEffect(() => {
    const grew = count > prev.current
    prev.current = count
    if (!grew) return
    const prefs = useSettings.getState().settings.notifications
    if (!prefs.approvals || !windowInBackground()) return
    postNotification(
      t('settings.notifications.approvals.title'),
      t('settings.notifications.approvals.body'),
      { tag: 'approval' },
    )
  }, [count])
}
