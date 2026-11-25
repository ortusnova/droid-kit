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

## Licence

MIT
