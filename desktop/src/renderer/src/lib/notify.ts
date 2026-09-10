/**
 * The two ways the shell gets the user's attention: a short synthesised
 * chime (no audio asset, so nothing to license or bundle) and a macOS
 * notification through the web Notification API, which Electron routes to
 * Notification Center. Callers decide *whether* from settings; this module
 * only knows *how*.
 */

let audioCtx: AudioContext | null = null

function context(): AudioContext | null {
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    return audioCtx
  } catch {
    return null
  }
}

/** Two soft sine notes a fifth apart, ~350ms. Reads as "done", not "alert". */
export function playChime(): void {
  const ctx = context()
  if (!ctx) return
  const t0 = ctx.currentTime
  const master = ctx.createGain()
  master.gain.value = 0.16
  master.connect(ctx.destination)
  const notes: [number, number][] = [
    [659.25, 0], // E5
    [987.77, 0.11], // B5
  ]
  for (const [freq, at] of notes) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    env.gain.setValueAtTime(0, t0 + at)
    env.gain.linearRampToValueAtTime(1, t0 + at + 0.012)
    env.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.32)
    osc.connect(env)
    env.connect(master)
    osc.start(t0 + at)
    osc.stop(t0 + at + 0.34)
  }
}

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export function notificationPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

/**
 * Post a notification. Returns false when it could not be shown (no
 * permission, unsupported) so a caller can fall back to a toast.
 */
export function postNotification(
  title: string,
  body: string,
  opts: { tag?: string; onClick?: () => void } = {},
): boolean {
  if (notificationPermission() !== 'granted') return false
  try {
    const n = new Notification(title, { body, tag: opts.tag, silent: true })
    if (opts.onClick) {
      n.onclick = () => {
        window.focus()
        opts.onClick?.()
      }
    }
    return true
  } catch {
    return false
  }
}

/** True when the window is not the one the user is looking at. */
export function windowInBackground(): boolean {
  return document.visibilityState === 'hidden' || !document.hasFocus()
}
