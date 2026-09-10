# Packaging resources

electron-builder reads this directory (`directories.buildResources`).

- `icon.icns` — app icon for macOS (not yet added; electron-builder falls back
  to the default Electron icon until it exists).
- `entitlements.mac.plist` — only needed once a Developer ID identity is
  configured; the current config signs ad-hoc with hardened runtime off.
