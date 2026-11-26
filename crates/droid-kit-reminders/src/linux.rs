//! Linux: the reminders file is the schedule; the `droid-kit-reminderd` user
//! service reads it and delivers the notifications (design D10).
//!
//! The app side does four things:
//! - After each change it makes sure the service's unit is installed and
//!   running (`<app-id>-reminders.service` in the user's systemd directory,
//!   enabled the first time) and sends it the `Changed` signal on the session bus.
//! - It answers `capabilities` from the service's `CanWake` property, or, when
//!   the service is not running yet, from the same check the service makes.
//! - It owns the application id on the session bus and implements
//!   `org.freedesktop.Application`, so a tapped notification can open the app
//!   that is already running: `ActivateAction("open-reminder", [id])`.
//! - It reads `--dk-reminder <id>` from its own arguments: that is how a tap
//!   starts an app that was closed.
//!
//! Where things are is decided by the environment, so the same code works for
//! an installed app and for the containerised desktop build `dk run` makes:
//! - `DK_REMINDERD`: the service binary (default: next to the app's executable).
//! - `DK_REMINDER_LAUNCHER`: the program the service runs as `<program> --dk-reminder <id>`
//!   to start the app (default: the app's own executable).
//! - `DK_SYSTEMD_USER_DIR`: where the unit goes (default: `$XDG_CONFIG_HOME/systemd/user`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use droid_kit_reminderd::dbus::{RemindersProxy, SystemdManagerProxy};
use droid_kit_reminderd::names::{self, UnitSpec};
use droid_kit_reminderd::wake;
use futures_lite::future::block_on;
use tauri::{AppHandle, Manager, Runtime, plugin::PluginApi};
use zbus::{Connection, OwnedVariant, interface};

use crate::model::{Capabilities, Reminder, ReminderError};

/// The app's connection to the session bus, kept for the life of the app.
struct Bus(Connection);

/// `org.freedesktop.Application`: what the service calls when a notification is tapped while the app runs.
struct Application {
    open: Box<dyn Fn(String) + Send + Sync>,
    raise: Box<dyn Fn() + Send + Sync>,
}

#[interface(name = "org.freedesktop.Application")]
impl Application {
    fn activate(&self, _platform_data: HashMap<String, OwnedVariant>) {
        (self.raise)();
    }

    fn activate_action(&self, action_name: String, parameter: Vec<OwnedVariant>, _platform_data: HashMap<String, OwnedVariant>) {
        if action_name != names::OPEN_ACTION {
            return;
        }
        if let Some(id) = parameter.first().and_then(|v| v.downcast_ref::<&str>().ok()) {
            (self.open)(id.to_string());
        }
        (self.raise)();
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>, _api: PluginApi<R, ()>) -> Result<(), Box<dyn std::error::Error>> {
    let id = app.config().identifier.clone();
    let (open_app, raise_app) = (app.clone(), app.clone());
    let application = Application {
        open: Box::new(move |reminder| crate::opened(&open_app, reminder)),
        raise: Box::new(move || {
            for window in raise_app.webview_windows().values() {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }),
    };
    // Owning the application id fails when another instance already has it;
    // that instance is the one a tap should reach, so this one only talks.
    let with_name = block_on(zbus::connection::Builder::session().name(id.as_str()).serve_at(names::app_path(&id), application).build());
    let conn = match with_name {
        Ok(conn) => Ok(conn),
        Err(_) => block_on(zbus::connection::Builder::session().build()),
    };
    match conn {
        Ok(conn) => {
            app.manage(Bus(conn));
        }
        Err(e) => eprintln!("droid-kit-reminders: no session bus ({e}); reminders will not be delivered while the app is closed"),
    }
    Ok(())
}

pub fn ensure_permission<R: Runtime>(_app: &AppHandle<R>) -> Result<(), ReminderError> {
    Ok(())
}

pub fn schedule<R: Runtime>(_app: &AppHandle<R>, _reminder: &Reminder, _utc_offset_minutes: i32) -> Result<(), ReminderError> {
    Ok(())
}

pub fn cancel<R: Runtime>(_app: &AppHandle<R>, _reminder_id: &str) -> Result<(), ReminderError> {
    Ok(())
}

/// Installs and starts the service if needed, and tells it the schedule changed.
pub fn changed<R: Runtime>(app: &AppHandle<R>) -> Result<(), ReminderError> {
    let bus = app.try_state::<Bus>().ok_or_else(|| ReminderError::platform("no session bus: the reminders service cannot be reached"))?;
    let id = app.config().identifier.clone();
    let name = app.config().product_name.clone().unwrap_or_else(|| id.clone());
    let data_dir = app.path().app_data_dir().map_err(ReminderError::platform)?;
    let setup = ServiceSetup::find(&id, &name, &data_dir)?;
    block_on(async {
        setup.install_and_start(&bus.0).await?;
        bus.0
            .emit_signal(None::<&str>, names::service_path(&id), names::INTERFACE, names::CHANGED, &())
            .await
            .map_err(ReminderError::platform)
    })
}

static LAUNCH_ID: OnceLock<Option<String>> = OnceLock::new();
static LAUNCH_ID_TAKEN: AtomicBool = AtomicBool::new(false);

fn launch_argument(args: impl IntoIterator<Item = String>) -> Option<String> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == names::LAUNCH_ARG {
            return args.next();
        }
        if let Some(id) = arg.strip_prefix(&format!("{}=", names::LAUNCH_ARG)) {
            return Some(id.to_string());
        }
    }
    None
}

/// The reminder whose notification started the app (`--dk-reminder <id>`), once.
pub fn pending_opened<R: Runtime>(_app: &AppHandle<R>) -> Option<String> {
    let id = LAUNCH_ID.get_or_init(|| launch_argument(std::env::args().skip(1))).clone()?;
    (!LAUNCH_ID_TAKEN.swap(true, Ordering::SeqCst)).then_some(id)
}

pub fn capabilities<R: Runtime>(app: &AppHandle<R>) -> Capabilities {
    let can_wake = match app.try_state::<Bus>() {
        Some(bus) => block_on(async {
            let service = RemindersProxy::builder(&bus.0).destination(names::service_bus_name(&app.config().identifier)).path(names::service_path(&app.config().identifier)).build().await;
            if let Ok(service) = service {
                if let Ok(can_wake) = service.can_wake().await {
                    return can_wake;
                }
            }
            // The service is not running (nothing scheduled yet): ask the same question it would.
            wake::probe(&bus.0).await.can_wake
        }),
        None => false,
    };
    Capabilities { platform: "linux".into(), can_wake }
}

/// What the unit needs, from the environment.
struct ServiceSetup {
    id: String,
    name: String,
    data_dir: PathBuf,
    service_exe: PathBuf,
    launcher: PathBuf,
    unit_dir: PathBuf,
}

impl ServiceSetup {
    fn find(id: &str, name: &str, data_dir: &std::path::Path) -> Result<Self, ReminderError> {
        let exe = std::env::current_exe().map_err(ReminderError::platform)?;
        let env_path = |key: &str| std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from);
        let service_exe = env_path("DK_REMINDERD").unwrap_or_else(|| exe.with_file_name("droid-kit-reminderd"));
        if !service_exe.is_file() {
            return Err(ReminderError::platform(format!("the reminders service {} is not installed", service_exe.display())));
        }
        let config_home = env_path("XDG_CONFIG_HOME").or_else(|| env_path("HOME").map(|h| h.join(".config")));
        let unit_dir = env_path("DK_SYSTEMD_USER_DIR")
            .or_else(|| config_home.map(|c| c.join("systemd/user")))
            .ok_or_else(|| ReminderError::platform("cannot find the user's systemd directory"))?;
        Ok(ServiceSetup {
            id: id.into(),
            name: name.into(),
            data_dir: data_dir.into(),
            service_exe,
            launcher: env_path("DK_REMINDER_LAUNCHER").unwrap_or(exe),
            unit_dir,
        })
    }

    fn unit_text(&self) -> String {
        names::render_unit(&UnitSpec {
            app_id: &self.id,
            app_name: &self.name,
            service_exe: &self.service_exe.to_string_lossy(),
            data_dir: &self.data_dir.to_string_lossy(),
            launcher: &self.launcher.to_string_lossy(),
        })
    }

    async fn install_and_start(&self, conn: &Connection) -> Result<(), ReminderError> {
        let unit = names::unit_name(&self.id);
        let path = self.unit_dir.join(&unit);
        let text = self.unit_text();
        let changed = std::fs::read_to_string(&path).map(|old| old != text).unwrap_or(true);
        if changed {
            std::fs::create_dir_all(&self.unit_dir).map_err(ReminderError::platform)?;
            let tmp = self.unit_dir.join(format!("{unit}.tmp"));
            std::fs::write(&tmp, &text).map_err(ReminderError::platform)?;
            std::fs::rename(&tmp, &path).map_err(ReminderError::platform)?;
        }
        let systemd = SystemdManagerProxy::new(conn).await.map_err(ReminderError::platform)?;
        systemd.enable_unit_files(&[unit.as_str()], false, true).await.map_err(ReminderError::platform)?;
        if changed {
            systemd.reload().await.map_err(ReminderError::platform)?;
            systemd.restart_unit(&unit, "replace").await.map_err(ReminderError::platform)?;
        } else {
            systemd.start_unit(&unit, "replace").await.map_err(ReminderError::platform)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Repeat;

    #[test]
    fn the_service_reads_what_the_plugin_writes() {
        let list = vec![
            Reminder { id: "a".into(), title: "A".into(), body: "b".into(), repeat: Repeat::Once { date: "2026-11-26".into(), time: "07:00".into() } },
            Reminder { id: "b".into(), title: "B".into(), body: "b".into(), repeat: Repeat::Daily { time: "06:30".into() } },
            Reminder { id: "c".into(), title: "C".into(), body: "b".into(), repeat: Repeat::Weekly { weekdays: vec![1, 4], time: "07:00".into() } },
        ];
        // The same call the plugin's `write_store` makes.
        let json = serde_json::to_string_pretty(&list).unwrap();
        let read = droid_kit_reminderd::model::parse_schedule(&json).unwrap();
        assert_eq!(read.len(), 3);
        assert_eq!(read[2].id, "c");
        assert_eq!(serde_json::to_value(&read).unwrap(), serde_json::to_value(&list).unwrap());
    }

    #[test]
    fn the_launch_argument_names_the_reminder() {
        let args = |s: &[&str]| s.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(launch_argument(args(&["--dk-reminder", "habit-run"])), Some("habit-run".into()));
        assert_eq!(launch_argument(args(&["--other", "--dk-reminder=x"])), Some("x".into()));
        assert_eq!(launch_argument(args(&["--dk-reminder"])), None);
        assert_eq!(launch_argument(args(&[])), None);
    }

    #[test]
    fn the_unit_names_the_data_directory_and_launcher() {
        let setup = ServiceSetup {
            id: "com.example.app".into(),
            name: "Example".into(),
            data_dir: "/home/u/.local/share/com.example.app".into(),
            service_exe: "/opt/app/droid-kit-reminderd".into(),
            launcher: "/opt/app/app".into(),
            unit_dir: "/home/u/.config/systemd/user".into(),
        };
        let text = setup.unit_text();
        assert!(text.contains("\"--data-dir\" \"/home/u/.local/share/com.example.app\""));
        assert!(text.contains("\"--launcher\" \"/opt/app/app\""));
    }
}
