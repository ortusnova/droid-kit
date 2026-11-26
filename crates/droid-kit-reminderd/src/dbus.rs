//! The D-Bus interfaces the service and the app talk to.

use std::collections::HashMap;

use zbus::proxy;
use zbus::{OwnedObjectPath, Variant};

/// `org.freedesktop.Notifications`, the desktop's notification server.
#[proxy(interface = "org.freedesktop.Notifications", default_service = "org.freedesktop.Notifications", default_path = "/org/freedesktop/Notifications")]
pub trait Notifications {
    #[allow(clippy::too_many_arguments)]
    fn notify(
        &self,
        app_name: &str,
        replaces_id: u32,
        app_icon: &str,
        summary: &str,
        body: &str,
        actions: &[&str],
        hints: HashMap<&str, Variant<'_>>,
        expire_timeout: i32,
    ) -> zbus::Result<u32>;

    #[zbus(signal)]
    fn action_invoked(&self, id: u32, action_key: String) -> zbus::Result<()>;
}

/// PowerDevil's wake-up: `scheduleWakeup(service, path, unix-seconds)` returns a
/// cookie, and at that time PowerDevil calls `org.kde.PowerManagement.wakeupCallback(cookie)`
/// on `service` at `path`. `clearWakeup(cookie)` cancels it.
#[proxy(interface = "org.kde.Solid.PowerManagement", default_service = "org.kde.Solid.PowerManagement", default_path = "/org/kde/Solid/PowerManagement")]
pub trait PowerManagement {
    #[zbus(name = "scheduleWakeup")]
    fn schedule_wakeup(&self, service: &str, path: &zbus::wire::ObjectPath<'_>, timestamp: u64) -> zbus::Result<u32>;

    #[zbus(name = "clearWakeup")]
    fn clear_wakeup(&self, cookie: i32) -> zbus::Result<()>;
}

pub const POWERDEVIL_NAME: &str = "org.kde.Solid.PowerManagement";

/// systemd's user manager, which listens on the session bus too.
#[proxy(interface = "org.freedesktop.systemd1.Manager", default_service = "org.freedesktop.systemd1", default_path = "/org/freedesktop/systemd1")]
pub trait SystemdManager {
    fn reload(&self) -> zbus::Result<()>;
    fn enable_unit_files(&self, files: &[&str], runtime: bool, force: bool) -> zbus::Result<(bool, Vec<(String, String, String)>)>;
    fn start_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn restart_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
}

/// logind on the system bus: `PrepareForSleep(false)` is sent when the device has just resumed.
#[proxy(interface = "org.freedesktop.login1.Manager", default_service = "org.freedesktop.login1", default_path = "/org/freedesktop/login1")]
pub trait Login {
    #[zbus(signal)]
    fn prepare_for_sleep(&self, start: bool) -> zbus::Result<()>;
}

/// The standard `org.freedesktop.Application` interface an app exports on the
/// session bus under its application id.
#[proxy(interface = "org.freedesktop.Application")]
pub trait Application {
    fn activate_action(&self, action_name: &str, parameter: Vec<Variant<'_>>, platform_data: HashMap<&str, Variant<'_>>) -> zbus::Result<()>;
}

/// The service's own interface: whether a wake-up request can wake the device.
#[proxy(interface = "dev.droidkit.Reminders1")]
pub trait Reminders {
    #[zbus(property)]
    fn can_wake(&self) -> zbus::Result<bool>;
}
