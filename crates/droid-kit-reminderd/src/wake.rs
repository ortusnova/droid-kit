//! Whether PowerDevil's wake-up can really wake the device.
//!
//! PowerDevil arms a `CLOCK_REALTIME_ALARM` timer, which needs `CAP_WAKE_ALARM`.
//! Without it, PowerDevil quietly falls back to `CLOCK_REALTIME`: the request is
//! accepted and the callback comes on time while the device is awake, but a
//! suspended device is not woken. So a wake-up counts only if PowerDevil's
//! effective capabilities include `CAP_WAKE_ALARM`.

use zbus::Connection;
use zbus::fdo::DBusProxy;
use zbus::names::BusName;

use crate::dbus::POWERDEVIL_NAME;

pub const CAP_WAKE_ALARM: u32 = 35;

/// The effective capability set from the text of `/proc/<pid>/status`.
pub fn cap_eff(status: &str) -> Option<u64> {
    let line = status.lines().find_map(|l| l.strip_prefix("CapEff:"))?;
    u64::from_str_radix(line.trim(), 16).ok()
}

pub fn has_cap(status: &str, cap: u32) -> bool {
    cap_eff(status).is_some_and(|set| set >> cap & 1 == 1)
}

#[derive(Debug, Clone, PartialEq)]
pub struct WakeSupport {
    /// PowerDevil is on the session bus.
    pub powerdevil: bool,
    /// PowerDevil's effective capabilities include `CAP_WAKE_ALARM`.
    pub can_wake: bool,
    pub detail: String,
}

/// Looks at the PowerDevil process on the session bus.
pub async fn probe(conn: &Connection) -> WakeSupport {
    let absent = |detail: String| WakeSupport { powerdevil: false, can_wake: false, detail };
    let Ok(bus) = DBusProxy::new(conn).await else {
        return absent("no session bus".into());
    };
    let Ok(name) = BusName::try_from(POWERDEVIL_NAME) else {
        return absent("bad name".into());
    };
    let pid = match bus.get_connection_unix_process_id(name).await {
        Ok(pid) => pid,
        Err(_) => return absent(format!("{POWERDEVIL_NAME} is not on the session bus")),
    };
    match std::fs::read_to_string(format!("/proc/{pid}/status")) {
        Ok(status) => {
            let set = cap_eff(&status).unwrap_or(0);
            let can_wake = has_cap(&status, CAP_WAKE_ALARM);
            WakeSupport {
                powerdevil: true,
                can_wake,
                detail: format!("powerdevil pid {pid} CapEff={set:016x}, CAP_WAKE_ALARM {}", if can_wake { "present" } else { "missing" }),
            }
        }
        Err(e) => WakeSupport { powerdevil: true, can_wake: false, detail: format!("cannot read /proc/{pid}/status: {e}") },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_wake_alarm_bit() {
        let without = "Name:\tx\nCapInh:\t0000000800000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\n";
        assert_eq!(cap_eff(without), Some(0));
        assert!(!has_cap(without, CAP_WAKE_ALARM));
        let with = "CapEff:\t0000000800000000\n";
        assert!(has_cap(with, CAP_WAKE_ALARM));
        assert!(!has_cap(with, 34));
        assert_eq!(cap_eff("nothing here"), None);
    }
}
