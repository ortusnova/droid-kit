# droid-kit

A shared kit for Tauri v2 mobile apps on Android and Linux phones: design
tokens, React components, a platform plugin, a reminders plugin, a storage plugin, an app
template, a component gallery and a command-line tool, `dk`.

The look is daisyUI on Tailwind CSS 4, with the Tailwind Blue · Zinc palette.
Behaviour comes from React Aria Components.

## Layout

```
packages/tokens      @droid-kit/tokens     token source and generated outputs
packages/ui          @droid-kit/ui         React components and kit.css
packages/platform    @droid-kit/platform   platform layer: form factor, insets, theme, engine check
packages/reminders   @droid-kit/reminders  reminders API
packages/store       @droid-kit/store      local SQLite storage, migrations, record helpers
crates/              Rust crates: tokens, the platform, reminders and store plugins, the Linux reminders service, dk
apps/gallery         every component, and the pages where design options are chosen
template/            what `dk new` copies
```

## Using the kit in an app

Apps pin one release tag for every kit package and crate. There is no
registry; everything comes from this repository.

```jsonc
// package.json
"@droid-kit/ui": "github:ortusnova/droid-kit#v0.1.0&path:/packages/ui"
```

```toml
# src-tauri/Cargo.toml
droid-kit-platform = { git = "https://github.com/ortusnova/droid-kit", tag = "v0.1.0" }
```

`@droid-kit/ui` expects `@droid-kit/platform` and `@droid-kit/tokens` as peer
dependencies, so an app lists both itself, at the same tag. Otherwise pnpm
looks for them on the npm registry and fails with a 404. `dk new` writes all
four kit packages for you.

## `dk`, the command-line tool

Install it from a checkout of the kit, or straight from a tag:

```sh
cargo install --path crates/dk --locked
cargo install --git https://github.com/ortusnova/droid-kit --tag v0.2.0 dk --locked
```

Run it in an app's directory (the one with `package.json` and `src-tauri/`),
or pass `--app <dir>`. The examples below work as written from
`apps/gallery`, except `dk kit local`, which needs an app that depends on
the kit by tag; run that one from such an app.

| Command | What it does |
| --- | --- |
| `dk doctor` | Lists what each target needs and whether it is ready. |
| `dk run linux-desktop` | Builds the app in the Alpine (musl) image and opens it on this machine's Wayland session. |
| `dk run android-phone` | Builds on the Android build host, installs on the phone over wireless debugging, and launches it. |
| `dk run android-emulator` | Builds for x86_64 and runs it on the build host's emulator. |
| `dk run ios-phone` | Builds on this Linux machine with xtool, signs with your Apple ID, installs on the iPhone on USB, and launches it. |
| `dk test linux-desktop` | Builds and starts the app as `dk run` does, then runs its device scenarios (`tests/device/`) on it. See [Device scenarios](#device-scenarios-dk-test). |
| `dk new life-droid --id com.ortusnova.lifedroid` | Makes an app from `template/`, pinned to the kit tag of this `dk`. |
| `dk check` | Checks that every kit dependency names the same tag. |
| `dk kit local ../droid-kit` | Uses a local kit checkout instead of the pinned tag. |
| `dk kit pin` | Goes back to the pinned tag, restoring the dependency files exactly. |

Examples:

```sh
dk new my-app --id com.example.myapp                  # in ./my-app
dk new my-app --id com.example.myapp --dir ~/dev/foo  # in a directory that may hold other files
dk doctor
dk run linux-desktop
dk run android-phone --timeout 120
dk run android-emulator
dk run ios-phone
dk check
dk kit local ~/dev/droid-kit   # from an app that pins a kit tag
dk kit pin
```

`dk new <name> --id <identifier>` copies the template, fills in the name, the
identifier, the title (`--title`, default the name) and the kit tag, and
refuses to overwrite any file. It works in a directory that already holds
other files and does not run `git init`. The tag is `v` plus this `dk`'s
version, so a `dk` installed from tag `vX.Y.Z` makes apps that pin `vX.Y.Z`;
`--kit-tag` overrides it. In the new app, run `pnpm install`, then `dk check`
and `dk run linux-desktop`.

`dk run` waits for the page to call `signalReady()` from `@droid-kit/platform`,
then saves a screenshot and the app's log under `artifacts/`. It exits 1 if
the page reports an error or the app exits, and 2 if no first screen appears
within the timeout (90 seconds by default). On timeout it still saves a
screenshot, so a hang can be seen.

On `linux-desktop`:

- The screenshot is taken by the app itself: the platform plugin (debug builds
  only) writes a PNG of the app's own web view when `dk` sets `DK_SCREENSHOT`.
  No window capture is involved, so no other window can end up in the picture,
  whatever has focus. If the app cannot write one, `dk` says "no screenshot: …"
  and the run's result is unchanged.
- The window's Wayland app id is the app's identifier,
  as on Android, so a desktop file named `<identifier>.desktop` matches it. The
  platform plugin sets it when the app is built. Do not set Tauri's
  `app.enableGTKAppId`: it makes GTK own the identifier on the session bus,
  where the reminders plugin owns it already.
- An app that uses the store or the reminders plugin gets its real data directory,
  `$XDG_DATA_HOME/<identifier>`, mounted at its own path, so the database and
  the reminders file outlive the container.
- A container of an earlier run (`dk-<app>`, running or crashed) is removed
  before the build and again before the start.
- The host's locale variables (`LANG`, `LC_*`, `LANGUAGE`) go into the
  container. Without them WebKitGTK reports `navigator.language` as `C`.

On `ios-phone` (no Mac, no Xcode install, no paid developer account):

- Once per machine: Swift 6.3 (`swiftly`; on a distribution swiftly does not
  know, `swiftly init --platform fedora39` or the like), the
  [xtool](https://xtool.sh) AppImage, `xtool auth login --mode password` with
  your Apple ID, `xtool sdk install <Xcode 26 .xip>` (the `.xip` from
  developer.apple.com, free Apple ID; xtool only takes the iOS SDK out of it),
  `rustup target add aarch64-apple-ios`, `jq`, `usbmuxd`, ImageMagick (`magick`,
  for the app icon sizes), and `uv tool install pymobiledevice3`.
- Once per iPhone: plug it in and trust the computer, install any app once,
  then Settings → General → VPN & Device Management → your Apple ID → Trust,
  and Settings → Privacy & Security → Developer Mode (the phone restarts). For
  `scripts/iphone.sh` and `dk test ios-phone`, also Settings → Apps → Safari →
  Advanced → Web Inspector.
- `scripts/ios-build.sh` (which `dk` embeds) cross-compiles the app's Rust
  library with clang and that SDK, copies Tauri's Swift runtime and every
  plugin's `ios/` Swift package into a SwiftPM package it generates in
  `<app>/.dk/ios/`, and has xtool build, sign and install it. The home-screen
  name is the product name, the icon is `src-tauri/icons/icon.png`.
- `dk` stops the running app first (an app started by the developer services
  makes the next install hang at `[Connecting] 100%`), launches it with
  pymobiledevice3, and waits for `DK_READY` in the device log.
- With a free Apple ID, xtool installs the app as `XTL-<team>.<identifier>`.
- `scripts/iphone.sh <identifier>` has `launch`, `stop`, `shot`, `logs`, and
  `js` and `tap` through Web Inspector (`cdp` starts the bridge). The app must
  be in front: iOS does not let Web Inspector reach a suspended app.
- `KIT_LOCAL=<kit checkout>` builds against a local kit without `dk kit local`.
- `dk test ios-phone` runs the app's scenarios (`tests/device/`) on the iPhone
  through `pymobiledevice3 webinspector cdp`. **Input is inside the page** (the
  same pointer, mouse and click events the Linux driver sends), **not real
  touch**: iOS has no touch injection without Xcode, and `RESULTS.md` says so.
  The app must be in front and the iPhone unlocked; the driver brings it back
  before each scenario. The driver has no `notifications` capability (tapping a
  banner needs a finger), so a scenario that needs it is skipped, and the skip
  is reported. `--no-build` runs against the app already installed.

### Errors the kit reports

An uncaught error, an unhandled rejection and a route that fails to render are
written to the log as `DK_ERROR …`, which makes `dk run` fail and name the
error. For render errors give the router the kit's component:

```tsx
createRouter({ routeTree, defaultErrorComponent: RouteError })   // from @droid-kit/ui
```

`reportError(message)` from `@droid-kit/platform` does the same for an error
the app catches itself.

## Device scenarios: `dk test`

`dk test <target>` runs an app's scenarios on a running app, the same files on
every target:

```sh
dk test linux-desktop                    # build and start the app, then run tests/device/
dk test android-phone --only "Week"      # only scenarios whose name contains "Week"
dk test android-phone --no-build         # use the app already running; build, install and start nothing
```

The targets are those of `dk run`: `android-phone`, `android-emulator`,
`linux-desktop` and `ios-phone`. A target without a driver says so and exits 2. An app needs `@droid-kit/devtest` in its
devDependencies, at the same tag as the other kit packages (`dk check` looks at
it). Results go to `artifacts/devtest/<target>-<timestamp>/`: `RESULTS.md` (a
table of scenarios, then each one's steps, notes, and how input reached the
app) and the screenshots it links to. A failed step has a screenshot of its
own. The log lines, `PASS`, `FAIL` or `SKIP` for each scenario and the path of
`RESULTS.md`, are also printed.

### A scenario

Every `.ts`, `.js` or `.mjs` file in `tests/device/` is loaded, in name order.
It default-exports a scenario or an array of them, and a file that exports none
(shared helpers) is fine. Node runs the files itself, stripping types: import
helpers with their `.ts` extension and use no enums. Scenarios run one after
another against the same running app, so each one starts from a state it sets
up itself.

<!-- scenario-example -->
```ts
// The example in the README's "Device scenarios" section. packages/devtest/test/readme.test.ts keeps the two the same.
import { scenario } from '@droid-kit/devtest';

export default scenario('the floating action button counts presses', async t => {
  const { d } = t;

  await t.step('open the page', async () => {
    await d.open('/components/fab');
    await d.waitFor(`document.querySelector('#fab-presses') !== null`);
  });

  await t.step('press the button twice', async () => {
    await d.tap('button[aria-label="New habit"]');
    await d.tap('button[aria-label="New habit"]');
    await d.waitFor(`document.querySelector('#fab-presses').textContent === 'Pressed 2 times'`);
    t.expect('counter', await d.eval(`document.querySelector('#fab-presses').textContent`), 'Pressed 2 times');
    await d.screenshot('fab-pressed-twice');
  });

  // Leaving the page unmounts it, so the next scenario to open it finds its counter at 0.
  await t.step('leave the page', () => d.open('/'));

  t.note('the page has a light and a dark sample; a tap goes to the first button it finds');
});
```

- `scenario(name, run)` declares one. `scenario(name, { needs: ['notifications'] }, run)`
  names what the driver must be able to do; on a driver that cannot, the
  scenario is skipped and `RESULTS.md` says why.
- `t.step(name, run)` is a named step. Its time goes into the results, and the
  first step that throws fails the scenario, with a screenshot taken at that
  moment; later steps do not run.
- `t.expect(name, actual, expected)` fails the step unless the two are equal
  (JSON equality). `t.note(text)` adds a line to the results.
- `t.d` is the driver. Selectors are CSS selectors in the app's page. Prefer
  `data-*` attributes to text, which changes with the language.

### The driver

| Method | |
| --- | --- |
| `open(route)` | Goes to a route, e.g. `/week?sheet=new-habit`. |
| `tap(selector)` | Taps the middle of the first element that matches. It fails if something covers that point. |
| `type(selector, text)` | Taps the element, then types; the text is appended. |
| `swipe(selector, direction)` | Swipes from the element: `up`, `down`, `left` or `right`. |
| `back()` | The system back on Android; on Linux and iOS, the app's own back. |
| `eval(expression)` | Evaluates a JavaScript expression in the page; the result must be JSON. |
| `waitFor(expression, { timeoutMs })` | Waits until the expression is true in the page (10 s by default). Use it for anything that animates. |
| `screenshot(name)` | Saves a picture of the app only, never other windows. |
| `forceStop()`, `restart()` | Stops the app's process; starts it again and waits for its first screen. |
| `reinstall()` | Installs a new build over the running one, keeping its data. Needs `reinstall`. |
| `waitForNotification({ id, title })`, `tapNotification(...)` | Wait for a system notification, tap it. Need `notifications`. |
| `setClock(epochMs)`, `setZone(zone)` | Set the device's clock and time zone; `close()` puts them back. Need `clock`. |

The capabilities of each driver, and how its input reaches the app:

| Target | Input | `realInput` | `notifications` | `reinstall` | `clock` |
| --- | --- | --- | --- | --- | --- |
| `android-phone` | Real touch, through `adb shell input` | yes | yes | yes | no |
| `android-emulator` | The same | yes | yes | yes | yes |
| `linux-desktop` | Inside the page: DOM events at the element's position, not pointer input | no | yes | yes | no |
| `ios-phone` | Inside the page, through Web Inspector: DOM pointer events, not real touch | no | no | yes | no |

A passing run on `linux-desktop` or `ios-phone` shows that the app's logic and screens work,
not that a finger lands where it should; the Android run is the one that does.
`RESULTS.md` records which kind of input a run had.

The Android driver reads and drives the page through the WebView's DevTools
socket. The Linux driver uses the **evaluation channel**: a Unix socket at
`$XDG_RUNTIME_DIR/droid-kit/<identifier>/eval.sock` that the platform plugin
opens, in debug builds on Linux only, when `dk run linux-desktop` sets
`DK_EVAL_SOCKET`. It runs JavaScript in the page and writes a screenshot of the
web view. A release build does not contain it. Nothing is registered on the
session bus, and the socket is mode 0600. A locked screen stops the web view's
animation frames, so every call into the page would time out: `dk test
linux-desktop` reads the session's `LockedHint` from logind first (read-only,
through `loginctl`), and if the screen is locked it says so and exits 2. If the
state cannot be read it warns and goes on.

Exit codes of `dk test`: 0 when every scenario passed or was skipped, 1 when
one failed (or the app reported an error while starting), and 2 when the run
could not start: no driver for the target, no `@droid-kit/devtest`, no
scenarios in `tests/device/`, a locked screen on `linux-desktop`, or no first
screen within the timeout.

## In an app

- **Back on Android.** `installBackHandler()` closes the topmost overlay that
  has no history entry of its own, otherwise goes back in history, otherwise
  sends the app to the background. A sheet or dialog the app keeps in the URL
  (`?sheet=`) is a history entry and needs nothing more. Kit overlays that are
  not in the URL close themselves on back, topmost first: the time picker's
  panel, the date picker's calendar, a select's list, and `ConfirmDialog`
  (`closeOnBack={false}` if the app keeps it in the history). A `Sheet` that is
  not in the history sets `closeOnBack`. An app's own overlay uses
  `pushBackInterceptor(close)` from `@droid-kit/platform`; it returns a function
  that removes it again. Escape on a desktop is React Aria's, and closes only the
  topmost overlay.
- **`data-*` attributes.** Every kit component passes `data-*` props to its root
  element, for test hooks and styles: `<CheckboxRow data-habit="sleep" … />`.
- **Locales.** `dates.safeLocale(tag)` turns any value into a tag `Intl`
  accepts (`en_US.utf8` becomes `en-US`; `C`, `POSIX` and invalid values become
  `en-US`), and `dates.systemLocale()` is `navigator.language` through it. Use
  them instead of passing `navigator.language` to `Intl`, which throws on `C`.
  The kit's date components do this themselves.

### Settings

`dk.toml` in the app's directory is committed. `dk.local.toml` next to it holds
machine-specific values and is not committed. Both are optional.

```toml
[app]
root = "."                                  # directory synced to the build host

[android]
host = "taichi"                             # ssh name of the Android build host
host_root = "/opt/models/android-dev"       # its android-dev environment
adb = "~/dev/android/android-tools/usr/bin/adb"
phone = "192.168.1.123:40107"               # default: found with `adb mdns services`

[linux]
image = "localhost/droid-kit-linux:latest"  # built from containers/linux-build if missing
```

### Limits

- `dk kit local` works with `linux-desktop` only. The Android targets build on
  the build host, which does not have the local checkout; run `dk kit pin`
  first.
- The phone must be awake or have no PIN. `dk run android-phone` wakes it and
  lifts the keyguard, which works only without a PIN.
- iPhone, free Apple ID: the signature lasts 7 days (run `dk run ios-phone`
  again to renew it), at most 3 sideloaded apps at a time, 10 new app ids a
  week. Debug builds only.
- iPhone: native prompts (the notification permission) need a person to tap
  them, and the page's presses from scripts are DOM activations, not touches.
- iPhone, reminders:
  - iOS keeps at most 64 pending notifications per app. A monthly reminder on
    the 29th to 31st holds 12 of them and a yearly one on 29 February holds 4
    (the other rules hold one per weekday, or one); `schedule` refuses, saying
    so, when all reminders together would pass 64.
  - Those two rules cannot be repeating triggers ("the last day of the month",
    "28 February in a year without the 29th"), so the plugin arms one-time
    occurrences ahead, 12 months for the monthly one and 4 years for the yearly
    one, and arms the next ones again **whenever the app starts or a reminder
    is scheduled**. Someone who does not open the app for a year stops getting
    the monthly reminders of those days, and after four years the yearly one.
    iOS has no dependable way to run in the background to do it sooner (background
    refresh is not reliable); that is left for later.
  - The rules to arm again are read from `reminders.json`, the list the Rust
    side writes (the same file Android's boot receiver and Linux's reminderd
    read). The iPhone keeps only its own delivery state in the app's defaults:
    which reminders it armed with one-time triggers, and up to when. If the file
    is missing or unreadable, nothing is armed again and nothing is removed.
  - Times follow the phone's time zone: a 07:00 reminder is at 07:00 wherever the
    phone is. The month and day of a repeating monthly or yearly trigger are read
    in the calendar the phone is set to; a non-Gregorian calendar is not tried.

## Storage

`@droid-kit/store` gives an app one local SQLite database. The file is
`<name>.db` in the app's data directory (Android: the app's `dataDir`; Linux:
`$XDG_DATA_HOME/<identifier>`, which `dk run linux-desktop` keeps between runs).
It survives restarts, kills and updates; only uninstalling or clearing the app's
data removes it. SQLite 3.54 is built into the app by the `droid-kit-store`
crate (`rusqlite`, `bundled`), so no system library is needed on Android or on
musl. Both are registered by the template: `droid_kit_store::init()` in
`src-tauri/src/lib.rs`, and `droid-kit-store:default` in `capabilities/`. An
app made before the kit had storage adds the crate, the npm package, the plugin
and the capability by hand.

<!-- store-example -->
```ts
import { RECORD_COLUMNS, deleteRecord, insertRecord, insertStatement, openStore, selectRecords, updateStatement, type RecordFields } from '@droid-kit/store';

// Script n runs once, together with `PRAGMA user_version = n`. Add to the end; never edit a shipped one.
const migrations = [
  `CREATE TABLE habit (${RECORD_COLUMNS}, name TEXT NOT NULL, rank REAL NOT NULL)`,
  `CREATE TABLE outcome (${RECORD_COLUMNS}, habit_id TEXT NOT NULL REFERENCES habit(id), day TEXT NOT NULL, kind TEXT NOT NULL)`,
];

type Habit = RecordFields & { name: string; rank: number };

export async function example() {
  const store = await openStore({ name: 'life', migrations });

  // A record: the store adds id, created_at, updated_at and device_id.
  const run = await insertRecord(store, 'habit', { name: 'Morning run', rank: 1 });

  // A batch is one transaction: both statements are stored, or neither is.
  const done = insertStatement(store, 'outcome', { habit_id: run.id, day: '2026-11-26', kind: 'done' });
  await store.batch([done.statement, updateStatement(store, 'habit', run.id, { rank: 2 })]);

  // Reads leave out deleted records; a deletion keeps the row with deleted_at set.
  const habits = await selectRecords<Habit>(store, 'habit', { orderBy: 'rank' });
  await deleteRecord(store, 'habit', run.id);
  return habits;
}
```

- **`openStore({ name, migrations })`** opens the database, creating it, and
  applies the migrations it has not had. It is safe to call again (a page
  reload). `store.path`, `store.version`, `store.sqliteVersion`,
  `store.journalMode` and `store.deviceId` describe it.
- **Migrations** are an ordered list of plain SQL scripts. Script *n* runs once,
  on the databases that have not had it, in one transaction together with
  `PRAGMA user_version = n`. If a script fails, everything it did is rolled back,
  the version and the data are unchanged, and `openStore` rejects with a
  `StoreError` of kind `migration` that names the script. A script must not
  contain `BEGIN` or `COMMIT`, and must not be empty or only comments: SQLite
  refuses that, and the kit reports it as `migration` before any script runs.
  A database from a newer build (a higher version than the app has scripts) is
  refused as `too-new` and left alone.
- **Reads and writes.** `store.select<T>(sql, params)` returns rows as objects.
  `store.execute(sql, params)` runs one statement and gives `rowsAffected`.
  Parameters (`?`) are `null`, booleans (stored as 0 or 1), numbers or strings;
  columns come back as `null`, numbers or strings. A BLOB column is an error,
  and so is more than one statement per call. Integers are exact up to 2^53,
  far beyond a timestamp in milliseconds.
- **Batches are the transactions.** `store.batch([{ sql, params }, …])` runs the
  statements in one transaction on the one connection: all are stored, or none
  are, also if the app is killed partway. There is no `BEGIN` across calls, so
  nothing is left open between two of them. Do the reads you need first, then
  send the writes as one batch.
- **Records ready for sync.** A table made with `RECORD_COLUMNS` has `id` (a
  UUIDv7, so ids sort by creation time), `created_at`, `updated_at` (ms since
  1970, UTC), `device_id` (the installation that last changed the row) and
  `deleted_at`. `insertRecord`, `updateRecord`, `deleteRecord` and
  `restoreRecord` stamp them, and have `…Statement` forms to put in a batch.
  `updated_at` is always later than the value before it, even if the clock
  stood still or went back. A deletion leaves the row, with `deleted_at` set;
  `selectRecords` and `getRecord` leave deleted rows out unless
  `includeDeleted` is set. Table and column names given to the helpers must be
  plain identifiers. A later sync can merge two devices by `id`, last writer
  winning on `updated_at`.
- **The device id** is made once per installation and kept in the store's own
  table `_dk_meta`, which the app's migrations do not make.
- **Limits.** One database per app (a second `openStore` with another name is
  refused). A name is 1 to 64 letters, digits, `_` or `-`.
- **Tests without Tauri.** `import { memoryBackend } from '@droid-kit/store/test'`
  and pass it as `backend`: `openStore({ name: 'test', migrations, backend: memoryBackend() })`.
  It is Node's built-in SQLite (`node:sqlite`) with the same rules as the crate.
  `memoryBackend({ path })` keeps a file, to test a restart; `now` in the
  options sets the clock the record helpers stamp with.

## Plugin commands that call into Kotlin

A command that calls into Kotlin must be `async` and use `run_mobile_plugin_async(...).await`, never `run_mobile_plugin`. Tauri runs a sync command while it holds the plugin store's lock, and Kotlin often answers from Android's main thread, which takes that lock when a page finishes loading, so the app can stop responding. Never call `run_mobile_plugin` from a callback on Android's main thread either.

## Releasing

A release is one tag, `vX.Y.Z`, and every manifest at the tag has the version
`X.Y.Z` (the package manifests, the Cargo workspace, the `VERSION` constants
and `Cargo.lock`). `dk new` reads its tag from `dk`'s own version.

```sh
node scripts/set-version.mjs 0.1.0   # edits all of them and updates Cargo.lock
git commit -am "Release 0.1.0" && git tag v0.1.0
node scripts/set-version.mjs --check # `dk check` in the kit runs this too
```

## Licence

MIT
