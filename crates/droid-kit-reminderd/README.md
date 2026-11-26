# droid-kit-reminderd

The Linux half of `droid-kit-reminders`: a systemd user service that delivers an app's reminders while the app is closed.

- **Schedule:** reads `reminders.json` in the app's data directory (`$XDG_DATA_HOME/<app-id>/`), the file the plugin writes. Times are local wall-clock times; each occurrence is worked out with the time zone's rules on its own date (`due.rs`), so a daily 06:30 stays at 06:30 across daylight saving.
- **Delivery:** `org.freedesktop.Notifications.Notify` with a `default` action. A tap opens the app with the reminder's id: `org.freedesktop.Application.ActivateAction("open-reminder", [id])` when the app is running (the plugin owns the application id on the session bus), and `<launcher> --dk-reminder <id>` when it is not.
- **Waking:** the next due time is registered with PowerDevil (`org.kde.Solid.PowerManagement.scheduleWakeup`; PowerDevil calls `org.kde.PowerManagement.wakeupCallback(cookie)` on the service at that time). An ordinary timer runs as well, and logind's `PrepareForSleep(false)` makes it look again on resume. A due time that passed while nothing was running is delivered when the service starts.
- **`canWake`:** the `CanWake` property of `dev.droidkit.Reminders1` on `<app-id>.Reminders`. True only when PowerDevil holds the wake-up *and* has `CAP_WAKE_ALARM`: without it PowerDevil silently arms a `CLOCK_REALTIME` timer, which does not wake a suspended device.
- **Changes:** the app emits `dev.droidkit.Reminders1.Changed` on `/dev/droidkit/Reminders/<app_id>`; the service also compares the file's modification time at each pass.
- **State:** `$XDG_STATE_HOME/<app-id>/reminderd.json` (what was delivered, notification ids for taps after a restart, the wake-up cookie).

The unit, `<app-id>-reminders.service`, is written and enabled by the plugin the first time the app schedules something (`names::render_unit`). Where it finds things:

| Variable | Meaning | Default |
| --- | --- | --- |
| `DK_REMINDERD` | the service binary | `droid-kit-reminderd` next to the app's executable |
| `DK_REMINDER_LAUNCHER` | run as `<launcher> --dk-reminder <id>` to start the app | the app's executable |
| `DK_SYSTEMD_USER_DIR` | where the unit is written | `$XDG_CONFIG_HOME/systemd/user` |

`dk run linux-desktop` builds the service static for musl next to the app, and sets these for the containerised build (see `crates/dk/src/linux.rs`).

Build: `cargo build -p droid-kit-reminderd --features daemon`. For a static binary on Alpine: `RUSTFLAGS='-C target-feature=+crt-static' cargo build -p droid-kit-reminderd --features daemon --target "$(rustc -vV | sed -n 's/^host: //p')"` (the explicit `--target` keeps the flag away from proc macros).
