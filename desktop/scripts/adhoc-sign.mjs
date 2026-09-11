/**
 * electron-builder `afterPack` hook: ad-hoc sign the packaged .app.
 *
 * With `mac.identity: null` electron-builder skips signing entirely, which
 * leaves the bundle with Electron's linker-only signature (identifier
 * "Electron", no resource seal). macOS 15+ treats such a bundle as no app at
 * all: notifications are refused by `usernotificationsd` ("addRequest not
 * allowed"), and the app never appears in System Settings › Notifications.
 * A plain ad-hoc signature over the whole bundle gives it a valid seal and
 * its own identifier (`dev.agentos.desktop`), which is enough for
 * Notification Center. Replace with a Developer ID identity in
 * `electron-builder.yml` when one is available; this hook then only
 * re-signs what is already signed, harmlessly.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${path.basename(app)} (afterPack)`)
}
