#!/usr/bin/env bash
# Helpers for finger tests on the Android phone over wireless debugging.
#
#   source scripts/phone.sh <package>
#   tap '#open-demo'          tap the centre of the element matching a CSS selector
#   js 'document.title'       evaluate in the app's web view and print the result
#   key BACK                  press a key (KEYCODE_ prefix added)
#   shot <file.png>           screenshot
#   awake                     wake the phone, lift the keyguard, close the shade
#
# Taps go through `adb shell input`, so the page sees real touch events.
# Element positions come from the web view's DevTools socket.
set -u
DK_PKG=${1:?package}
DK_ADB=${DK_ADB:-$HOME/dev/android/android-tools/usr/bin/adb}
DK_SERIAL=${DK_SERIAL:-$("$DK_ADB" mdns services | awk '/_adb-tls-connect/ {print $NF; exit}')}
DK_PORT=${DK_PORT:-9350}
DK_EVAL=$(dirname "${BASH_SOURCE[0]}")/cdp-eval.mjs

adb_() { "$DK_ADB" -s "$DK_SERIAL" "$@"; }

# Taps go wherever the screen shows: wake the phone, lift the keyguard (no
# PIN), and close the notification shade before testing.
awake() {
  adb_ shell input keyevent KEYCODE_WAKEUP
  adb_ shell wm dismiss-keyguard
  adb_ shell cmd statusbar collapse
  sleep 1
}

_forward() {
  local pid
  pid=$(adb_ shell pidof "$DK_PKG")
  adb_ forward "tcp:$DK_PORT" "localabstract:webview_devtools_remote_$pid" >/dev/null
}

js() { _forward && node "$DK_EVAL" "$DK_PORT" "$1"; }

# Device pixels of an element's centre: CSS pixels × devicePixelRatio, plus
# the web view's offset on screen (0 in Tauri's edge-to-edge window).
tap() {
  local xy
  # Off-screen elements are scrolled into view first, except inside a sheet,
  # where scrolling the page would read as a swipe to dismiss.
  js "(() => { const e = document.querySelector('$1'); if (!e || e.closest('.dk-sheet')) return 0; const r = e.getBoundingClientRect(); if (r.top < 60 || r.bottom > innerHeight - 90) e.scrollIntoView({ block: 'center' }); return 1; })()" >/dev/null
  sleep 0.4
  xy=$(js "(() => { const e = document.querySelector('$1'); if (!e) return 'missing'; const r = e.getBoundingClientRect(); return Math.round((r.x + r.width / 2) * devicePixelRatio) + ' ' + Math.round((r.y + r.height / 2) * devicePixelRatio); })()" | tr -d '"')
  if [[ $xy == missing ]]; then echo "tap: no element matches $1" >&2; return 1; fi
  adb_ shell input tap $xy
}

key() { adb_ shell input keyevent "KEYCODE_$1"; }
shot() { adb_ exec-out screencap -p > "$1"; }
