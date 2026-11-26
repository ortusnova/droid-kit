//! The droid-kit reminders service for Linux, and what the Tauri plugin shares with it.
//!
//! The binary (feature `daemon`, on by default) is a systemd user service. The
//! library part is used by `droid-kit-reminders` without the async runtime:
//! the schedule model, the next-due computation, the names both sides use, the
//! unit file text, the D-Bus interfaces and the wake-up check.

pub mod dbus;
pub mod due;
pub mod model;
pub mod names;
pub mod wake;

#[cfg(feature = "daemon")]
pub mod daemon;
