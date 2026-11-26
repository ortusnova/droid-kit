// iOS: each reminder becomes one pending notification request per occurrence
// rule, with a calendar trigger that the system evaluates on the device's
// calendar and clock: a one-time reminder fires once at its local date and
// time, a daily one every day at its time, a weekly one on each of its
// weekdays. Requests are named "<reminder id>#<slot>" (slot 0 for one rule,
// the ISO weekday for each day of a weekly reminder), so cancelling removes
// every slot. iOS keeps at most 64 pending requests per app.

import Tauri
import UIKit
import UserNotifications
import WebKit

struct Repeat: Decodable {
  let kind: String
  let date: String?
  let time: String
  let weekdays: [Int]?
}

struct Reminder: Decodable {
  let id: String
  let title: String
  let body: String
  let `repeat`: Repeat
}

struct ScheduleArgs: Decodable {
  // The reminder as JSON, as the Kotlin side takes it.
  let reminder: String
}

struct CancelArgs: Decodable {
  let id: String
}

struct Tapped: Encodable {
  let id: String?
}

enum ReminderError: LocalizedError {
  case invalid(String)

  var errorDescription: String? {
    switch self {
    case .invalid(let message): return "invalid reminder: \(message)"
    }
  }
}

class RemindersPlugin: Plugin, UNUserNotificationCenterDelegate {
  /// The reminder whose notification was tapped before the page asked (cold start).
  private var tapped: String?
  /// Whether the page has called takeTapped, so it now listens for `tapped`.
  private var pageListens = false

  /// This plugin is the notification delegate, so a reminder shows while the
  /// app is open and a tap is reported. tauri-plugin-notification, which the
  /// kit uses only for the permission, also makes itself the delegate, and
  /// its willPresent crashes on any notification it did not create; the
  /// reminders plugin is registered after it, so this assignment wins.
  override func load(webview: WKWebView) {
    UNUserNotificationCenter.current().delegate = self
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if let id = response.notification.request.content.userInfo["reminderId"] as? String {
      if pageListens {
        trigger("tapped", data: ["id": id])
      } else {
        tapped = id
      }
    }
    completionHandler()
  }

  /// The id of the reminder whose notification started the app, once.
  @objc public func takeTapped(_ invoke: Invoke) {
    pageListens = true
    let id = tapped
    tapped = nil
    invoke.resolve(Tapped(id: id))
  }

  @objc public func schedule(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ScheduleArgs.self)
    let reminder = try JSONDecoder().decode(Reminder.self, from: Data(args.reminder.utf8))
    let content = UNMutableNotificationContent()
    content.title = reminder.title
    content.body = reminder.body
    content.sound = .default
    content.userInfo = ["reminderId": reminder.id]

    let center = UNUserNotificationCenter.current()
    let requests = try triggers(for: reminder.repeat).map { slot, trigger in
      UNNotificationRequest(identifier: "\(reminder.id)#\(slot)", content: content, trigger: trigger)
    }
    let group = DispatchGroup()
    var failure: Error?
    for request in requests {
      group.enter()
      center.add(request) { error in
        if let error = error { failure = error }
        group.leave()
      }
    }
    group.notify(queue: .main) {
      if let failure = failure {
        invoke.reject(failure.localizedDescription)
      } else {
        invoke.resolve()
      }
    }
  }

  @objc public func cancel(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CancelArgs.self)
    let ids = (0...7).map { "\(args.id)#\($0)" }
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
    invoke.resolve()
  }

  @objc public func openSettings(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let url: URL?
      if #available(iOS 16.0, *) {
        url = URL(string: UIApplication.openNotificationSettingsURLString)
      } else {
        url = URL(string: UIApplication.openSettingsURLString)
      }
      if let url = url {
        UIApplication.shared.open(url)
      }
      invoke.resolve()
    }
  }

  /// (slot, trigger) for each notification the reminder needs.
  private func triggers(for rule: Repeat) throws -> [(Int, UNCalendarNotificationTrigger)] {
    let (hour, minute) = try parseTime(rule.time)
    switch rule.kind {
    case "once":
      guard let date = rule.date else { throw ReminderError.invalid("a one-time reminder needs a date") }
      let (year, month, day) = try parseDate(date)
      let when = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: 0)
      return [(0, UNCalendarNotificationTrigger(dateMatching: when, repeats: false))]
    case "daily":
      let when = DateComponents(hour: hour, minute: minute, second: 0)
      return [(0, UNCalendarNotificationTrigger(dateMatching: when, repeats: true))]
    case "weekly":
      guard let weekdays = rule.weekdays, !weekdays.isEmpty else {
        throw ReminderError.invalid("a weekly reminder needs weekdays")
      }
      // ISO 1 = Monday … 7 = Sunday; Apple's calendar: 1 = Sunday … 7 = Saturday.
      return weekdays.map { iso in
        let when = DateComponents(hour: hour, minute: minute, second: 0, weekday: iso % 7 + 1)
        return (iso, UNCalendarNotificationTrigger(dateMatching: when, repeats: true))
      }
    default:
      throw ReminderError.invalid("unknown repeat kind \(rule.kind)")
    }
  }

  private func parseTime(_ s: String) throws -> (Int, Int) {
    let parts = s.split(separator: ":").compactMap { Int($0) }
    guard parts.count == 2 else { throw ReminderError.invalid("time \(s) is not HH:MM") }
    return (parts[0], parts[1])
  }

  private func parseDate(_ s: String) throws -> (Int, Int, Int) {
    let parts = s.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { throw ReminderError.invalid("date \(s) is not YYYY-MM-DD") }
    return (parts[0], parts[1], parts[2])
  }
}

@_cdecl("init_plugin_droid_kit_reminders")
public func initPlugin() -> Plugin {
  return RemindersPlugin()
}
