# droid-kit

A shared kit for Tauri v2 mobile apps on Android and Linux phones: design
tokens, React components, a platform plugin, a reminders plugin, an app
template, a component gallery and a command-line tool, `dk`.

The look is daisyUI on Tailwind CSS 4, with the Tailwind Blue · Zinc palette.
Behaviour comes from React Aria Components.

## Layout

```
packages/tokens      @droid-kit/tokens     token source and generated outputs
packages/ui          @droid-kit/ui         React components and kit.css
packages/platform    @droid-kit/platform   platform layer: form factor, insets, theme, engine check
packages/reminders   @droid-kit/reminders  reminders API
crates/              Rust crates: tokens, the platform and reminders plugins, the Linux reminders service, dk
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

## `dk`, the command-line tool

Install it from a checkout of the kit, or straight from a tag:

```sh
cargo install --path crates/dk --locked
cargo install --git https://github.com/ortusnova/droid-kit --tag v0.1.0-rc.1 dk --locked
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
within the timeout (90 seconds by default).

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
