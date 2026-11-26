#!/usr/bin/env bash
# Build a droid-kit app for iPhone on Linux, then sign it with your Apple ID
# and install it on the iPhone on USB. No Mac and no Xcode install.
#
#   scripts/ios-build.sh <app dir> [build|run]     (default: run = build + install)
#
# Needs (see the README's iOS section): Swift 6.3 (swiftly), xtool logged in
# with `xtool auth login`, the Darwin SDK from `xtool sdk install <Xcode 26 .xip>`,
# `rustup target add aarch64-apple-ios`, pnpm, jq.
#
# How: the app's Rust library is cross-compiled to a static library with
# clang and the iOS SDK that xtool extracted from Xcode. Tauri's Swift runtime
# and the iOS (Swift) parts of the app's plugins, which Tauri builds only on a
# Mac, are copied into a small SwiftPM package that xtool builds, links with
# the Rust library, signs and installs. That package is generated in
# <app>/.dk/ios/ (gitignored).
#
# Environment: KIT_LOCAL=<kit checkout> builds against a local kit (a Cargo
# patch for the droid-kit crates); UDID=<udid> picks the iPhone.
set -euo pipefail

step() { printf '\n==> %s\n' "$*" >&2; }

APP=$(realpath "${1:?usage: ios-build.sh <app dir> [build|run]}")
MODE=${2:-run}
OUT=$APP/.dk/ios
SDK_BUNDLE=$HOME/.swiftpm/swift-sdks/darwin.artifactbundle
export SDKROOT=$(ls -d "$SDK_BUNDLE"/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS[0-9]*.sdk | tail -1)
export IPHONEOS_DEPLOYMENT_TARGET=17.0
# The Swift runtime's crash reporter cannot protect its memory on 16 KB pages (Asahi); it only warns.
export SWIFT_BACKTRACE=enable=no
[ -f "$HOME/.local/share/swiftly/env.sh" ] && . "$HOME/.local/share/swiftly/env.sh"
TOOLCHAIN=$(dirname "$(command -v clang)")

# clang for the iPhone: cc-rs (C parts of crates) and rustc use it.
mkdir -p "$OUT/bin"
cat > "$OUT/bin/ios-cc" <<EOF
#!/bin/sh
exec $TOOLCHAIN/clang --target=arm64-apple-ios$IPHONEOS_DEPLOYMENT_TARGET -isysroot $SDKROOT "\$@"
EOF
chmod +x "$OUT/bin/ios-cc"
export CC_aarch64_apple_ios=$OUT/bin/ios-cc CXX_aarch64_apple_ios=$OUT/bin/ios-cc
export AR_aarch64_apple_ios=$TOOLCHAIN/llvm-ar
export CARGO_TARGET_AARCH64_APPLE_IOS_LINKER=$OUT/bin/ios-cc

CONF=$APP/src-tauri/tauri.conf.json
PRODUCT=$(jq -r .productName "$CONF")
IDENTIFIER=$(jq -r .identifier "$CONF")
VERSION=$(jq -r .version "$CONF")
# The Swift package name: the product name in PascalCase (life-droid -> LifeDroid).
NAME=$(echo "$PRODUCT" | sed -E 's/(^|[-_ ])([a-z])/\U\2/g; s/[^A-Za-z0-9]//g')

step "app: $PRODUCT ($IDENTIFIER), iOS SDK: $(basename "$SDKROOT"), output: $OUT"

# 1. The web app, embedded in the Rust library.
step "1/5 web app: pnpm build"
(cd "$APP" && pnpm build)

# 2. The Rust library, as a static library for the iPhone. custom-protocol
#    makes Tauri serve the built web app instead of the dev server.
PATCH=()
if [ -n "${KIT_LOCAL:-}" ]; then
  for crate in $(ls "$KIT_LOCAL/crates" | grep '^droid-kit-'); do
    PATCH+=(--config "patch.'https://github.com/ortusnova/droid-kit'.$crate.path='$(realpath "$KIT_LOCAL")/crates/$crate'")
  done
fi
cd "$APP/src-tauri"
step "2/5 Rust library for aarch64-apple-ios${KIT_LOCAL:+ (kit: $KIT_LOCAL)}"
cargo rustc --lib --crate-type staticlib --target aarch64-apple-ios --features tauri/custom-protocol "${PATCH[@]}"
METADATA=$(cargo metadata --format-version 1 --filter-platform aarch64-apple-ios "${PATCH[@]}")
LIB=$(echo "$METADATA" | jq -r '.packages[] | select(.manifest_path == "'"$APP"'/src-tauri/Cargo.toml") | .targets[] | select(.kind | index("staticlib")) | .name')
TARGET_DIR=$(echo "$METADATA" | jq -r .target_directory)
mkdir -p "$OUT/rust"
ln -f "$TARGET_DIR/aarch64-apple-ios/debug/lib$LIB.a" "$OUT/rust/lib$LIB.a"

# 3. The Swift parts: Tauri's iOS runtime, and every plugin that has an ios/
#    Swift package. Each plugin's package refers to the runtime as
#    ../.tauri/tauri-api, so the copies keep that layout.
step "3/5 Swift packages: Tauri's iOS runtime and the plugins' ios/ packages"
VENDOR=$OUT/vendor
rm -rf "$VENDOR" && mkdir -p "$VENDOR/.tauri"
TAURI_DIR=$(dirname "$(echo "$METADATA" | jq -r '.packages[] | select(.name == "tauri") | .manifest_path')")
cp -r "$TAURI_DIR/mobile/ios-api" "$VENDOR/.tauri/tauri-api"
DEPS=""
PRODUCTS=""
for manifest in $(echo "$METADATA" | jq -r '.packages[].manifest_path'); do
  dir=$(dirname "$manifest")
  [ -f "$dir/ios/Package.swift" ] || continue
  pkg=$(basename "$dir" | sed -E 's/-[0-9]+\.[0-9]+\.[0-9]+.*$//')
  echo "    $pkg ($dir/ios)" >&2
  cp -r "$dir/ios" "$VENDOR/$pkg"
  DEPS+="        .package(name: \"$pkg\", path: \"vendor/$pkg\"),"$'\n'
  PRODUCTS+="                .product(name: \"$pkg\", package: \"$pkg\"),"$'\n'
done
# Tests are not built, and xtool's archiver cannot make `type: .static` libraries
# (SwiftPM links the default automatic libraries statically into the app anyway).
for p in "$VENDOR"/.tauri/tauri-api "$VENDOR"/*; do
  rm -rf "$p/Tests"
  sed -i '/type: \.static,/d; /\.testTarget(/,/),/d' "$p/Package.swift"
done

# 4. The app package: an entry point that starts Tauri, linked with the Rust library.
step "4/5 app package $OUT/Package.swift"
mkdir -p "$OUT/Sources/$NAME"
cat > "$OUT/Package.swift" <<EOF
// swift-tools-version: 6.0
// Generated by droid-kit scripts/ios-build.sh. Do not edit.
import PackageDescription

let package = Package(
    name: "$NAME",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "$NAME", targets: ["$NAME"])],
    dependencies: [
        .package(name: "Tauri", path: "vendor/.tauri/tauri-api"),
$DEPS    ],
    targets: [
        .target(
            name: "$NAME",
            dependencies: [
                .product(name: "Tauri", package: "Tauri"),
$PRODUCTS            ],
            linkerSettings: [
                .unsafeFlags(["-L", "$OUT/rust", "-l$LIB"]),
                // What the Rust library links (rustc --print native-static-libs).
                .linkedFramework("WebKit"), .linkedFramework("UIKit"), .linkedFramework("UserNotifications"),
                .linkedFramework("CoreData"), .linkedFramework("CoreLocation"), .linkedFramework("CoreText"),
                .linkedFramework("CoreImage"), .linkedFramework("CloudKit"), .linkedFramework("QuartzCore"),
                .linkedFramework("CoreGraphics"), .linkedFramework("Foundation"), .linkedFramework("CoreFoundation"),
                .linkedFramework("Security"), .linkedLibrary("iconv"), .linkedLibrary("objc"),
            ]
        ),
    ]
)
EOF
cat > "$OUT/Sources/$NAME/Entry.swift" <<'EOF'
// Generated by droid-kit scripts/ios-build.sh. Do not edit.
import Tauri

@_silgen_name("start_app")
func start_app()

@main
struct Entry {
    static func main() {
        // Tauri sends the app's stdout and stderr (DK_READY, DK_ERROR) to the system log only when this is on.
        Logger.enabled = true
        start_app()
    }
}
EOF
# The home-screen name is the product name, as Android's launcher label is.
xml() { sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' <<<"$1"; }
cat > "$OUT/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>$(xml "$PRODUCT")</string>
  <key>CFBundleShortVersionString</key>
  <string>$(xml "$VERSION")</string>
</dict>
</plist>
EOF
cat > "$OUT/xtool.yml" <<EOF
version: 1
bundleID: $IDENTIFIER
infoPath: Info.plist
iconPath: $APP/src-tauri/icons/icon.png
EOF

# 5. Build, and for `run` sign and install. With a free Apple ID, xtool
#    installs the app as XTL-<team>.<identifier>.
#    xtool's linker warns once per object file that it "does not support
#    linking for platform iOS"; it links correctly, so that one line is dropped.
cd "$OUT"
step "5/5 xtool dev $MODE${UDID:+ (iPhone $UDID)}"
{
  if [ "$MODE" = build ]; then
    xtool dev build
  else
    xtool dev run ${UDID:+-u "$UDID"} </dev/null
  fi
} 2>&1 | grep --line-buffered -vxF 'ld64.lld: warning: This version of lld does not support linking for platform iOS. Proceed at your own risk.'
