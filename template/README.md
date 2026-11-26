# __DK_TITLE__

A droid-kit app (kit `__DK_KIT_TAG__`), identifier `__DK_IDENTIFIER__`. It runs on an
Android phone and as a Linux build.

## Run it

```sh
pnpm install
dk check                 # the kit dependencies name one tag
dk run linux-desktop     # build in the Alpine image and open on this desktop
dk run android-phone     # build on the Android build host, install over Wi-Fi
dk run android-emulator
```

`dk run` waits for the first screen, then saves a screenshot and the log under
`artifacts/`. Put this machine's `adb` path and the phone's address in
`dk.local.toml` (not committed):

```toml
[android]
adb = "~/dev/android/android-tools/usr/bin/adb"
```

To work on the kit and this app together: `dk kit local <path to the kit>`
(Linux only), and `dk kit pin` to go back to `__DK_KIT_TAG__`.

## Where things are

- `src/main.tsx`: the router. Tabs are routes (add one to `TABS` and a route
  with `tab: '<id>'`), a sheet is the `?sheet=` search parameter, the app bar's
  back goes up a level when there is no history, and `installBackHandler()`
  makes the Android back action go back and then leave the app.
- `src/app-info.ts`: the name, title and identifier, filled in by `dk new`.
- `src-tauri/`: the Tauri app. Both kit plugins are registered in `src/lib.rs`;
  their permissions are in `capabilities/default.json`.
- `src-tauri/gen/android/`: the Android project, committed. Its launch screen
  and window background use the kit's colours (`@color/dk_background`), and
  the reminders permissions and receivers are added by the reminders plugin's
  own manifest.
- Upgrading the kit: change the tag in `package.json` and in
  `src-tauri/Cargo.toml` (`dk check` fails if they differ), then
  `pnpm install` and `cargo update -p droid-kit-platform -p droid-kit-reminders`.
