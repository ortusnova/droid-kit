//! The service: reads the schedule, delivers each reminder at its time, and
//! asks the power manager to wake the device for the next one.
//!
//! One loop owns all the state. Everything that can happen reaches it as an
//! [`Event`] (the app changed the schedule, PowerDevil called back, the user
//! tapped a notification, the device resumed), and after each event, and at
//! least every [`MAX_SLEEP`], it works out what is due.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use futures_util::StreamExt;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use zbus::fdo::DBusProxy;
use zbus::names::BusName;
use zbus::{Connection, MatchRule, MessageStream, Variant, interface};

use crate::dbus::{ApplicationProxy, LoginProxy, NotificationsProxy, POWERDEVIL_NAME, PowerManagementProxy};
use crate::model::{Reminder, parse_schedule};
use crate::{due, names, wake};

/// The longest the loop sleeps. The monotonic clock stops while the device is
/// suspended, so a long sleep would overshoot after a resume; this bounds the
/// lateness when no resume signal arrives, and re-reads the time zone.
const MAX_SLEEP: Duration = Duration::from_secs(300);
/// How soon to try again when the notification server did not take a reminder.
const RETRY: Duration = Duration::from_secs(15);

pub struct Config {
    pub app_id: String,
    pub app_name: String,
    /// The app's data directory, where `reminders.json` is.
    pub data_dir: PathBuf,
    /// Where the service keeps what it has delivered.
    pub state_dir: PathBuf,
    /// Run as `<launcher> --dk-reminder <id>` to start the app when it is not running.
    pub launcher: PathBuf,
}

macro_rules! log {
    ($($arg:tt)*) => {
        eprintln!("{} {}", Timestamp::now(), format_args!($($arg)*))
    };
}

enum Event {
    /// The app says `reminders.json` changed.
    Changed,
    /// PowerDevil called `wakeupCallback`.
    WakeCallback(i32),
    /// A notification action was invoked.
    Action(u32, String),
    /// Open the app for this reminder, as a tap on its notification does.
    Open(String),
    /// The device resumed from suspend.
    Resumed,
    /// PowerDevil appeared or went away: its wake-up list is empty again.
    PowerDevilOwner,
}

/// The service's own object: `CanWake`, and a way to ask for a reload by hand.
struct Service {
    can_wake: Arc<AtomicBool>,
    events: UnboundedSender<Event>,
}

#[interface(name = "dev.droidkit.Reminders1")]
impl Service {
    #[zbus(property)]
    fn can_wake(&self) -> bool {
        self.can_wake.load(Ordering::Relaxed)
    }

    fn reload(&self) {
        let _ = self.events.send(Event::Changed);
    }

    /// Does what the default action of a reminder's notification does: opens the app with this id.
    fn open_reminder(&self, id: String) {
        let _ = self.events.send(Event::Open(id));
    }
}

/// What PowerDevil calls at the wake-up time.
struct WakeCallback {
    events: UnboundedSender<Event>,
}

#[interface(name = "org.kde.PowerManagement")]
impl WakeCallback {
    #[zbus(name = "wakeupCallback")]
    fn wakeup_callback(&self, cookie: i32) {
        let _ = self.events.send(Event::WakeCallback(cookie));
    }
}

/// What has been delivered, kept across restarts.
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    handled: HashMap<String, Handled>,
    /// Notification id from the server → reminder id, so a tap after a restart still finds it.
    notifications: Vec<(u32, String)>,
    /// The wake-up PowerDevil may still hold from the last run, cleared when the service starts.
    #[serde(default)]
    wake_cookie: Option<u32>,
}

#[derive(Serialize, Deserialize)]
struct Handled {
    /// The reminder's time rule when it was last looked at.
    fingerprint: String,
    /// Occurrences up to this unix time are done (delivered, or before the reminder existed).
    until: i64,
}

struct Daemon {
    cfg: Config,
    conn: Connection,
    saved: Saved,
    reminders: Vec<Reminder>,
    file_stamp: Option<(SystemTime, u64)>,
    force_reload: bool,
    /// The wake-up PowerDevil holds for us: (cookie, due unix time).
    registered: Option<(u32, i64)>,
    wake_accepted: bool,
    powerdevil_can_wake: bool,
    can_wake: Arc<AtomicBool>,
}

pub async fn run(cfg: Config) -> Result<(), Box<dyn std::error::Error>> {
    let (tx, mut rx) = unbounded_channel::<Event>();
    let can_wake = Arc::new(AtomicBool::new(false));
    let service_path = names::service_path(&cfg.app_id);

    let conn = zbus::connection::Builder::session()
        .name(names::service_bus_name(&cfg.app_id))
        .serve_at(service_path.as_str(), Service { can_wake: can_wake.clone(), events: tx.clone() })
        .serve_at(service_path.as_str(), WakeCallback { events: tx.clone() })
        .build()
        .await?;
    log!("{} up on the session bus as {} at {}", cfg.app_id, names::service_bus_name(&cfg.app_id), service_path);

    watch_changed(&conn, &service_path, tx.clone()).await?;
    watch_actions(&conn, tx.clone()).await?;
    watch_powerdevil(&conn, tx.clone()).await?;
    watch_resume(tx.clone()).await;

    let state_file = cfg.state_dir.join("reminderd.json");
    let saved = std::fs::read_to_string(&state_file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let mut daemon = Daemon {
        cfg,
        conn,
        saved,
        reminders: Vec::new(),
        file_stamp: None,
        force_reload: true,
        registered: None,
        wake_accepted: false,
        powerdevil_can_wake: false,
        can_wake,
    };
    daemon.refresh_wake_support().await;
    daemon.clear_stale_wake().await;

    loop {
        let sleep_for = daemon.tick().await;
        tokio::select! {
            event = rx.recv() => match event {
                Some(event) => daemon.handle(event).await,
                None => return Ok(()),
            },
            () = tokio::time::sleep(sleep_for) => {}
        }
    }
}

/// The app's `Changed` signal, sent on the service's object path.
async fn watch_changed(conn: &Connection, path: &str, tx: UnboundedSender<Event>) -> zbus::Result<()> {
    let rule = MatchRule::builder().msg_type(zbus::message::Type::Signal).interface(names::INTERFACE).member(names::CHANGED).path(path).build()?;
    let mut stream = MessageStream::for_match_rule(rule, conn, None).await?;
    tokio::spawn(async move {
        while stream.next().await.is_some() {
            let _ = tx.send(Event::Changed);
        }
    });
    Ok(())
}

async fn watch_actions(conn: &Connection, tx: UnboundedSender<Event>) -> zbus::Result<()> {
    let notifications = NotificationsProxy::new(conn).await?;
    let mut stream = notifications.receive_action_invoked().await?;
    tokio::spawn(async move {
        while let Some(signal) = stream.next().await {
            if let Ok(args) = signal.args() {
                let _ = tx.send(Event::Action(args.id, args.action_key));
            }
        }
    });
    Ok(())
}

async fn watch_powerdevil(conn: &Connection, tx: UnboundedSender<Event>) -> zbus::Result<()> {
    let bus = DBusProxy::new(conn).await?;
    let mut stream = bus.receive_name_owner_changed().await?;
    tokio::spawn(async move {
        while let Some(signal) = stream.next().await {
            if let Ok(args) = signal.args() {
                if args.name().as_str() == POWERDEVIL_NAME {
                    let _ = tx.send(Event::PowerDevilOwner);
                }
            }
        }
    });
    Ok(())
}

/// Resume from suspend, from logind on the system bus. Without a system bus
/// the loop's bounded sleep still catches up.
async fn watch_resume(tx: UnboundedSender<Event>) {
    let Ok(system) = Connection::system().await else {
        log!("no system bus: resume is noticed by the periodic check only");
        return;
    };
    let Ok(login) = LoginProxy::new(&system).await else { return };
    let Ok(mut stream) = login.receive_prepare_for_sleep().await else { return };
    tokio::spawn(async move {
        let _keep_open = system;
        while let Some(signal) = stream.next().await {
            if signal.args().is_ok_and(|a| !a.start) {
                let _ = tx.send(Event::Resumed);
            }
        }
    });
}

impl Daemon {
    async fn handle(&mut self, event: Event) {
        match event {
            Event::Changed => {
                log!("the app changed the schedule");
                self.force_reload = true;
            }
            Event::WakeCallback(cookie) => {
                log!("PowerDevil called wakeupCallback({cookie})");
                if self.registered.is_some_and(|(c, _)| c as i32 == cookie) {
                    self.registered = None;
                    self.saved.wake_cookie = None;
                    self.save();
                }
            }
            Event::Resumed => log!("the device resumed"),
            Event::PowerDevilOwner => {
                log!("PowerDevil changed owner; registering the wake-up again");
                self.registered = None;
                self.refresh_wake_support().await;
            }
            Event::Action(id, key) => self.action(id, key).await,
            Event::Open(reminder) => self.open(&reminder).await,
        }
    }

    /// PowerDevil keeps a wake-up after the service that asked for it was restarted,
    /// and would call back for it as well as for the new one.
    async fn clear_stale_wake(&mut self) {
        let Some(cookie) = self.saved.wake_cookie.take() else { return };
        if let Ok(power) = PowerManagementProxy::new(&self.conn).await {
            let _ = power.clear_wakeup(cookie as i32).await;
        }
        self.save();
    }

    async fn refresh_wake_support(&mut self) {
        let support = wake::probe(&self.conn).await;
        log!("wake support: {}", support.detail);
        self.powerdevil_can_wake = support.powerdevil && support.can_wake;
        self.publish_can_wake();
    }

    /// `canWake` is true only when PowerDevil holds our request and can wake the device.
    fn publish_can_wake(&self) {
        self.can_wake.store(self.powerdevil_can_wake && self.wake_accepted, Ordering::Relaxed);
    }

    fn reload_schedule(&mut self) {
        let path = self.cfg.data_dir.join("reminders.json");
        let stamp = std::fs::metadata(&path).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
        if !self.force_reload && stamp == self.file_stamp {
            return;
        }
        self.force_reload = false;
        match std::fs::read_to_string(&path) {
            Ok(text) => match parse_schedule(&text) {
                Ok(list) => {
                    log!("schedule: {} reminder(s): {}", list.len(), list.iter().map(|r| r.id.as_str()).collect::<Vec<_>>().join(", "));
                    self.reminders = list;
                    self.file_stamp = stamp;
                }
                // Probably caught mid-write; the next pass reads it again.
                Err(e) => log!("cannot read the schedule yet: {e}"),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.reminders.clear();
                self.file_stamp = None;
            }
            Err(e) => log!("cannot read {}: {e}", path.display()),
        }
    }

    fn save(&self) {
        let _ = std::fs::create_dir_all(&self.cfg.state_dir);
        let file = self.cfg.state_dir.join("reminderd.json");
        let tmp = self.cfg.state_dir.join("reminderd.json.tmp");
        if let Ok(json) = serde_json::to_string_pretty(&self.saved) {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &file);
            }
        }
    }

    /// Delivers what is due, keeps PowerDevil's wake-up on the next due time,
    /// and says how long the loop may sleep.
    async fn tick(&mut self) -> Duration {
        self.reload_schedule();
        let now = Timestamp::now();
        let now_s = now.as_second();
        let tz = TimeZone::system();
        let mut dirty = false;
        let mut retry = false;
        let mut next: Option<Timestamp> = None;

        let ids: Vec<&str> = self.reminders.iter().map(|r| r.id.as_str()).collect();
        let before = self.saved.handled.len();
        self.saved.handled.retain(|id, _| ids.contains(&id.as_str()));
        dirty |= self.saved.handled.len() != before;

        for r in self.reminders.clone() {
            let fingerprint = r.repeat.fingerprint();
            let known = self.saved.handled.contains_key(&r.id);
            // First sight: occurrences before now are not ours to deliver. Saved, so a restart keeps the baseline.
            dirty |= !known;
            let entry = self.saved.handled.entry(r.id.clone()).or_insert_with(|| Handled { fingerprint: fingerprint.clone(), until: now_s });
            if entry.fingerprint != fingerprint {
                // Replaced: a new rule starts from now.
                *entry = Handled { fingerprint, until: now_s };
                dirty = true;
            }
            let after = Timestamp::from_second(entry.until).unwrap_or(now);
            match due::latest_in(&r.repeat, after, now, &tz) {
                Ok(Some(at)) => match self.deliver(&r, at).await {
                    Ok(()) => {
                        if let Some(e) = self.saved.handled.get_mut(&r.id) {
                            e.until = now_s;
                        }
                        dirty = true;
                    }
                    Err(e) => {
                        log!("could not deliver {}: {e}; trying again in {}s", r.id, RETRY.as_secs());
                        retry = true;
                    }
                },
                Ok(None) => {
                    if let Some(e) = self.saved.handled.get_mut(&r.id) {
                        if e.until < now_s {
                            e.until = now_s;
                            dirty = true;
                        }
                    }
                }
                Err(e) => log!("skipping {}: {e}", r.id),
            }
            if let Ok(Some(t)) = due::next_after(&r.repeat, now, &tz) {
                next = Some(next.map_or(t, |n| n.min(t)));
            }
        }
        if dirty {
            self.save();
        }

        self.sync_wake(next).await;

        let mut sleep_for = MAX_SLEEP;
        if let Some(t) = next {
            // A little past the due second, so that the check sees it as due.
            let ms = (t.as_millisecond() - Timestamp::now().as_millisecond()).max(0) as u64 + 50;
            sleep_for = sleep_for.min(Duration::from_millis(ms));
        }
        if retry {
            sleep_for = sleep_for.min(RETRY);
        }
        sleep_for.max(Duration::from_millis(100))
    }

    /// Holds exactly one PowerDevil wake-up: the next due time.
    async fn sync_wake(&mut self, next: Option<Timestamp>) {
        let want = next.map(|t| t.as_second());
        if self.registered.map(|(_, due)| due) == want {
            return;
        }
        let Ok(power) = PowerManagementProxy::new(&self.conn).await else { return };
        if let Some((cookie, _)) = self.registered.take() {
            let _ = power.clear_wakeup(cookie as i32).await;
            self.saved.wake_cookie = None;
        }
        let Some(due) = want else {
            self.save();
            self.wake_accepted = false;
            self.publish_can_wake();
            return;
        };
        let path = zbus::wire::ObjectPath::try_from(names::service_path(&self.cfg.app_id)).expect("a valid object path");
        match power.schedule_wakeup(&names::service_bus_name(&self.cfg.app_id), &path, due.max(0) as u64).await {
            Ok(cookie) => {
                log!("PowerDevil accepted scheduleWakeup({:?}, {path}, {due}): cookie {cookie}", names::service_bus_name(&self.cfg.app_id));
                self.registered = Some((cookie, due));
                self.saved.wake_cookie = Some(cookie);
                self.save();
                self.wake_accepted = true;
            }
            Err(e) => {
                log!("PowerDevil refused scheduleWakeup: {e}; using the timer only");
                self.wake_accepted = false;
            }
        }
        self.publish_can_wake();
    }

    async fn deliver(&mut self, r: &Reminder, due_at: Timestamp) -> zbus::Result<()> {
        let notifications = NotificationsProxy::new(&self.conn).await?;
        let mut hints: HashMap<&str, Variant<'_>> = HashMap::new();
        hints.insert("urgency", Variant::new(1u8));
        let id = notifications.notify(&self.cfg.app_name, 0, "", &r.title, &r.body, &["default", "Open"], hints, -1).await?;
        log!("delivered {} (due {due_at}) as notification {id}", r.id);
        self.saved.notifications.push((id, r.id.clone()));
        let extra = self.saved.notifications.len().saturating_sub(100);
        self.saved.notifications.drain(..extra);
        Ok(())
    }

    /// A notification action: the default one opens the app with the reminder's id.
    async fn action(&mut self, notification: u32, key: String) {
        let Some(reminder) = self.saved.notifications.iter().rev().find(|(n, _)| *n == notification).map(|(_, id)| id.clone()) else {
            return;
        };
        if key != "default" && key != "open" {
            return;
        }
        log!("notification {notification} ({reminder}) tapped");
        self.open(&reminder).await;
    }

    async fn open(&self, reminder: &str) {
        if let Err(e) = self.open_app(reminder).await {
            log!("could not open the app for {reminder}: {e}");
        }
    }

    /// A running app is asked through `org.freedesktop.Application`; otherwise it is started with `--dk-reminder <id>`.
    async fn open_app(&self, reminder: &str) -> Result<(), String> {
        let bus = DBusProxy::new(&self.conn).await.map_err(|e| e.to_string())?;
        let name = BusName::try_from(self.cfg.app_id.as_str()).map_err(|e| e.to_string())?;
        if bus.name_has_owner(name).await.unwrap_or(false) {
            let app = ApplicationProxy::builder(&self.conn)
                .destination(self.cfg.app_id.clone())
                .path(names::app_path(&self.cfg.app_id))
                .build()
                .await
                .map_err(|e| e.to_string())?;
            app.activate_action(names::OPEN_ACTION, vec![Variant::new(reminder)], HashMap::new()).await.map_err(|e| e.to_string())?;
            log!("running app asked to open {reminder}");
            return Ok(());
        }
        let mut cmd = Command::new(&self.cfg.launcher);
        cmd.arg(names::LAUNCH_ARG).arg(reminder).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // Its own process group, so that stopping this service does not signal the app.
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", self.cfg.launcher.display()))?;
        log!("started {} {} {reminder} (pid {})", self.cfg.launcher.display(), names::LAUNCH_ARG, child.id());
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}
