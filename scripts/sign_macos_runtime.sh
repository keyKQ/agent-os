#!/usr/bin/env bash
# Code-sign every Mach-O binary in the desktop app's bundled Python runtime.
#
# Tauri signs the .app it produces, but a signature covers a bundle's own
# executable and its seal over the resource tree -- it does not sign the
# hundreds of individual Mach-O files (the interpreter, plus one .so per CPython
# extension module and per native wheel) that the runtime tree contains. Those
# have to be signed first, because an outer signature cannot be applied over
# unsigned nested code without Gatekeeper rejecting the result at launch and
# notarization rejecting it at submission.
#
# So this runs against desktop/src-tauri/resources/ BEFORE `tauri build`: the
# already-signed files are then copied into the bundle verbatim and Tauri's
# signature goes on top.
#
# Usage:
#   scripts/sign_macos_runtime.sh <signing-identity> [resources-dir]
#
# The identity is a Developer ID Application certificate name or hash, e.g.
# "Developer ID Application: Example Inc (TEAMID)".

set -euo pipefail

IDENTITY="${1:-}"
RESOURCES="${2:-desktop/src-tauri/resources}"
ENTITLEMENTS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/desktop/src-tauri/entitlements.plist"

if [[ -z "${IDENTITY}" ]]; then
  echo "usage: $0 <signing-identity> [resources-dir]" >&2
  exit 2
fi
if [[ ! -d "${RESOURCES}" ]]; then
  echo "no runtime resources at ${RESOURCES}; run scripts/build_desktop_runtime.py build first" >&2
  exit 1
fi
if [[ ! -f "${ENTITLEMENTS}" ]]; then
  echo "missing entitlements: ${ENTITLEMENTS}" >&2
  exit 1
fi

signed=0

# Signing is inner-to-outer, so the interpreter is handled last: its signature
# does not seal the .so files beside it, but keeping the order explicit avoids
# re-signing anything and makes a partial failure easy to read in the log.
while IFS= read -r -d '' candidate; do
  if ! file -b "${candidate}" | grep -q "Mach-O"; then
    continue
  fi

  # `--options runtime` opts the binary into the hardened runtime, which
  # notarization requires. The entitlements are what make the hardened runtime
  # survivable for CPython: without disable-library-validation the interpreter
  # cannot dlopen the extension modules sitting next to it.
  codesign \
    --force \
    --sign "${IDENTITY}" \
    --options runtime \
    --timestamp \
    --entitlements "${ENTITLEMENTS}" \
    "${candidate}"
  signed=$((signed + 1))
done < <(find "${RESOURCES}" -type f -print0)

if [[ "${signed}" -eq 0 ]]; then
  echo "no Mach-O binaries found under ${RESOURCES} -- is this a macOS runtime build?" >&2
  exit 1
fi

echo "Signed ${signed} Mach-O binaries under ${RESOURCES}."
