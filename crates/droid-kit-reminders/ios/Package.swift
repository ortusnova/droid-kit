// swift-tools-version:5.5

import PackageDescription

let package = Package(
  name: "droid-kit-reminders",
  platforms: [
    .iOS(.v15)
  ],
  products: [
    .library(
      name: "droid-kit-reminders",
      type: .static,
      targets: ["droid-kit-reminders"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "droid-kit-reminders",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
