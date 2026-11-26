#!/usr/bin/env bash
# Helpers for testing on the iPhone on USB, like phone.sh for Android. Uses
# pymobiledevice3 (`uv tool install pymobiledevice3`), no root needed. The
# iPhone needs Developer Mode on, and Settings → Apps → Safari → Advanced →
# Web Inspector on before the app starts.
#
#   source scripts/iphone.sh <identifier>    e.g. com.ortusnova.lifedroid
#   launch                    (re)start the app
#   stop                      stop the app (do this before reinstalling)
#   cdp                       start the Web Inspector bridge on $DK_PORT (background)
#   js 'document.title'       evaluate in the app's web view and print the result
#   tap '#open-demo'          click the element matching a CSS selector
#   shot <file.png>           screenshot
#   logs                      follow the app's log (Ctrl+C to stop)
#
# Taps are DOM clicks through Web Inspector, not touches: iOS has no way to
# inject touches without Xcode. For native prompts outside the web view, see
# scripts/ios-ax.py.
set -u
DK_ID=${1:?identifier}
DK_PORT=${DK_PORT:-9222}
# The script's own path: BASH_SOURCE in bash, $0 when zsh sources it.
DK_EVAL=$(dirname "${BASH_SOURCE[0]:-$0}")/cdp-eval.mjs

# xtool installs apps signed with a free Apple ID as XTL-<team>.<identifier>.
DK_BUNDLE=${DK_BUNDLE:-$(pymobiledevice3 apps list -t User | jq -r --arg id "$DK_ID" 'keys[] | select(. == $id or endswith("." + $id))' | head -1)}
echo "bundle: ${DK_BUNDLE:-not installed}"

launch() { pymobiledevice3 developer dvt launch --kill-existing "$DK_BUNDLE"; }

# Run before reinstalling: an app started by `launch` makes the next install
# hang at "[Connecting] 100%" until it is stopped.
stop() {
  local pid
  pid=$(pymobiledevice3 developer dvt process-id-for-bundle-id "$DK_BUNDLE")
  [ -n "$pid" ] && [ "$pid" != 0 ] && pymobiledevice3 developer dvt kill "$pid"
}

cdp() {
  pymobiledevice3 webinspector cdp --host 127.0.0.1 --port "$DK_PORT" &
  DK_CDP_PID=$!
  echo "cdp bridge: pid $DK_CDP_PID, http://127.0.0.1:$DK_PORT/json"
}

js() { node "$DK_EVAL" "$DK_PORT" "$1"; }

tap() {
  js "(() => { const e = document.querySelector('$1'); if (!e) return 'tap: no element matches $1'; e.scrollIntoView({ block: 'center' }); e.click(); return 'tapped $1'; })()"
}

shot() { pymobiledevice3 developer dvt screenshot "$1"; }

logs() { pymobiledevice3 syslog live -pn "$(basename "$(pymobiledevice3 apps list -t User | jq -r --arg b "$DK_BUNDLE" '.[$b].CFBundleExecutable')")"; }
