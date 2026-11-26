// iOS: each reminder becomes pending notification requests with calendar
// triggers, which the system evaluates on the device's calendar and clock.
// Requests are named "<reminder id>#<slot>" and carry the reminder id in their
// user info, so cancelling removes every one of them.
//
// - once: one trigger at its local date and time (slot 0).
// - daily: a repeating trigger at its time (slot 0).
// - weekly: a repeating trigger per weekday (slot = ISO weekday, 1 to 7).
// - monthly, day 1 to 28: a repeating trigger on that day (slot 0).
// - yearly, any date but 29 February: a repeating trigger (slot 0).
//
// A repeating trigger cannot say "the last day of the month" (monthly on the
// 29th, 30th or 31st) or "28 February in a year without the 29th" (yearly on
// 29 February). For those the plugin schedules one-time triggers for the next
// few occurrences (slots 10 and up) and keeps the rule in UserDefaults, so it
// can arm the next ones: at every app start and at every `schedule` call.
//
// iOS keeps at most 64 pending requests per app. Each rule has a fixed share
// of them (its `reserved` count: one per trigger, and `monthlyAhead` or
// `leapDayAhead` for the one-time ones); `schedule` adds up the shares of all
// reminders and refuses, with an error that says why, when the sum would pass
// 64. Nothing is dropped silently.
//
// After every change, and at app start, the plugin tells a page that listens
// (`addPluginListener('droid-kit-reminders', 'armed', …)`) which requests are
// pending and when each is next due: the system's own pending list has no dates.
//
// Every change runs on one serial queue, so two calls at the same moment
// cannot interleave.

import Tauri
import UIKit
import UserNotifications
import WebKit

/// What iOS allows a single app to have pending.
let maxPending = 64
/// How many one-time occurrences a monthly rule on the 29th to 31st keeps armed.
let monthlyAhead = 6
/// How many one-time occurrences a yearly rule on 29 February keeps armed.
let leapDayAhead = 3

struct Repeat: Decodable {
  let kind: String
  let date: String?
  let time: String
  let weekdays: [Int]?
  let day: Int?
  let month: Int?
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

/// One pending request, for the `armed` event.
struct ArmedRequest: Encodable {
  let identifier: String
  let reminderId: String?
  /// The next time it is due, as local `YYYY-MM-DDTHH:MM`, or null when it never fires.
  let next: String?
  let repeats: Bool
}

struct Armed: Encodable {
  let pending: [ArmedRequest]
}

enum ReminderError: LocalizedError {
  case invalid(String)
  case tooMany(String)

  var errorDescription: String? {
    switch self {
    case .invalid(let message): return "invalid reminder: \(message)"
    case .tooMany(let message): return message
    }
  }
}

/// The requests one reminder needs, and how many of the 64 it keeps.
struct Plan {
  /// (slot, trigger)
  let triggers: [(Int, UNCalendarNotificationTrigger)]
  /// Whether the rule needs arming again later (it is made of one-time triggers).
  let rearm: Bool
  let reserved: Int
}

let gregorian: Calendar = {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone.current
  return calendar
}()

/// The key in UserDefaults: reminder id -> the reminder's JSON, for the rules made of one-time triggers.
let rulesKey = "droid-kit-reminders.rearm"

class RemindersPlugin: Plugin, UNUserNotificationCenterDelegate {
  /// The reminder whose notification was tapped before the page asked (cold start).
  private var tapped: String?
  /// Whether the page has called takeTapped, so it now listens for `tapped`.
  private var pageListens = false
  private let queue = DispatchQueue(label: "com.ortusnova.droidkit.reminders")

  /// This plugin is the notification delegate, so a reminder shows while the
  /// app is open and a tap is reported. tauri-plugin-notification, which the
  /// kit uses only for the permission, also makes itself the delegate, and
  /// its willPresent crashes on any notification it did not create; the
  /// reminders plugin is registered after it, so this assignment wins.
  override func load(webview: WKWebView) {
    UNUserNotificationCenter.current().delegate = self
    // Arm the next occurrences of the rules that are made of one-time triggers.
    queue.async {
      self.rearmAll(except: nil)
      self.emitArmed()
      NSLog("droid-kit-reminders: at start, armed \(self.storedRules().count) rule(s) of one-time triggers")
    }
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
    queue.async {
      do {
        try self.arm(reminder, json: args.reminder)
        self.emitArmed()
        invoke.resolve()
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  @objc public func cancel(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CancelArgs.self)
    queue.async {
      let center = UNUserNotificationCenter.current()
      let pending = self.pendingRequests().filter { reminderId(of: $0) == args.id }.map { $0.identifier }
      let delivered = self.deliveredRequests().filter { reminderId(of: $0.request) == args.id }.map { $0.request.identifier }
      center.removePendingNotificationRequests(withIdentifiers: pending)
      center.removeDeliveredNotifications(withIdentifiers: delivered)
      var rules = self.storedRules()
      rules.removeValue(forKey: args.id)
      self.store(rules)
      self.emitArmed()
      invoke.resolve()
    }
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

  // MARK: arming (always on `queue`)

  /// Replaces the reminder's pending requests, after checking that every reminder's share fits in 64.
  private func arm(_ reminder: Reminder, json: String) throws {
    let now = Date()
    let plan = try makePlan(reminder.repeat, after: now)
    let pending = pendingRequests()
    let rules = storedRules()

    // What the other reminders hold: a rule made of one-time triggers keeps its full share
    // even when some of its occurrences have fired; the rest hold what is pending.
    var others = 0
    var counted = Set<String>([reminder.id])
    for (id, ruleJson) in rules where id != reminder.id {
      counted.insert(id)
      if let other = decode(ruleJson), let otherPlan = try? makePlan(other.repeat, after: now) {
        others += otherPlan.reserved
      } else {
        others += pending.filter { reminderId(of: $0) == id }.count
      }
    }
    for request in pending {
      let id = reminderId(of: request)
      if id == nil || !counted.contains(id!) { others += 1 }
    }
    let total = others + plan.reserved
    guard total <= maxPending else {
      throw ReminderError.tooMany(
        "too many reminders: iOS allows \(maxPending) pending notifications per app, the other reminders hold \(others), and this one needs \(plan.reserved)"
      )
    }

    try replace(reminder, plan: plan, pending: pending)
    var rules2 = rules
    if plan.rearm { rules2[reminder.id] = json } else { rules2.removeValue(forKey: reminder.id) }
    store(rules2)
    rearmAll(except: reminder.id)
  }

  /// Makes the reminder's pending requests exactly the plan's: stale slots are removed, the others added or replaced.
  private func replace(_ reminder: Reminder, plan: Plan, pending: [UNNotificationRequest]) throws {
    let center = UNUserNotificationCenter.current()
    let content = UNMutableNotificationContent()
    content.title = reminder.title
    content.body = reminder.body
    content.sound = .default
    content.userInfo = ["reminderId": reminder.id]
    let requests = plan.triggers.map { slot, trigger in
      UNNotificationRequest(identifier: "\(reminder.id)#\(slot)", content: content, trigger: trigger)
    }
    let keep = Set(requests.map { $0.identifier })
    let stale = pending.filter { reminderId(of: $0) == reminder.id && !keep.contains($0.identifier) }.map { $0.identifier }
    center.removePendingNotificationRequests(withIdentifiers: stale)
    for request in requests {
      let done = DispatchSemaphore(value: 0)
      var failure: Error?
      center.add(request) { error in
        failure = error
        done.signal()
      }
      done.wait()
      if let failure = failure { throw failure }
    }
  }

  /// Arms the next occurrences of every stored rule (but one). A rule that fails is left as it was.
  private func rearmAll(except skip: String?) {
    let pending = pendingRequests()
    let now = Date()
    for (id, json) in storedRules() where id != skip {
      guard let reminder = decode(json), let plan = try? makePlan(reminder.repeat, after: now) else { continue }
      do {
        try replace(reminder, plan: plan, pending: pending)
      } catch {
        NSLog("droid-kit-reminders: could not arm \(id): \(error.localizedDescription)")
      }
    }
  }

  private func emitArmed() {
    let requests = pendingRequests().map { request -> ArmedRequest in
      let trigger = request.trigger as? UNCalendarNotificationTrigger
      return ArmedRequest(
        identifier: request.identifier, reminderId: reminderId(of: request),
        next: trigger?.nextTriggerDate().map(localText), repeats: trigger?.repeats ?? false)
    }
    try? trigger("armed", data: Armed(pending: requests.sorted { $0.identifier < $1.identifier }))
  }

  // MARK: the system's lists, waited for (on `queue`, never the main thread)

  private func pendingRequests() -> [UNNotificationRequest] {
    let done = DispatchSemaphore(value: 0)
    var result: [UNNotificationRequest] = []
    UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
      result = requests
      done.signal()
    }
    done.wait()
    return result
  }

  private func deliveredRequests() -> [UNNotification] {
    let done = DispatchSemaphore(value: 0)
    var result: [UNNotification] = []
    UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
      result = notifications
      done.signal()
    }
    done.wait()
    return result
  }

  private func storedRules() -> [String: String] {
    UserDefaults.standard.dictionary(forKey: rulesKey) as? [String: String] ?? [:]
  }

  private func store(_ rules: [String: String]) {
    UserDefaults.standard.set(rules, forKey: rulesKey)
  }

  private func decode(_ json: String) -> Reminder? {
    try? JSONDecoder().decode(Reminder.self, from: Data(json.utf8))
  }

  // MARK: the rules

  /// The triggers a rule needs from `now` on, and its share of the 64.
  private func makePlan(_ rule: Repeat, after now: Date) throws -> Plan {
    let (hour, minute) = try parseTime(rule.time)
    func components(_ year: Int?, _ month: Int?, _ day: Int?, weekday: Int? = nil) -> DateComponents {
      DateComponents(
        calendar: gregorian, year: year, month: month, day: day, hour: hour, minute: minute,
        second: 0, weekday: weekday)
    }
    func repeating(_ when: DateComponents) -> UNCalendarNotificationTrigger {
      UNCalendarNotificationTrigger(dateMatching: when, repeats: true)
    }
    /// The next `count` occurrences, as one-time triggers in slots 10 and up.
    func oneTime(count: Int, months: Set<Int>? = nil, day: Int) -> [(Int, UNCalendarNotificationTrigger)] {
      occurrences(after: now, count: count, hour: hour, minute: minute, months: months, day: day).enumerated().map { index, date in
        (10 + index, UNCalendarNotificationTrigger(dateMatching: components(date.0, date.1, date.2), repeats: false))
      }
    }
    switch rule.kind {
    case "once":
      guard let date = rule.date else { throw ReminderError.invalid("a one-time reminder needs a date") }
      let (year, month, day) = try parseDate(date)
      let when = components(year, month, day)
      return Plan(triggers: [(0, UNCalendarNotificationTrigger(dateMatching: when, repeats: false))], rearm: false, reserved: 1)
    case "daily":
      return Plan(triggers: [(0, repeating(components(nil, nil, nil)))], rearm: false, reserved: 1)
    case "weekly":
      guard let weekdays = rule.weekdays, !weekdays.isEmpty, weekdays.allSatisfy({ (1...7).contains($0) }) else {
        throw ReminderError.invalid("a weekly reminder needs weekdays 1 (Monday) to 7 (Sunday)")
      }
      // ISO 1 = Monday … 7 = Sunday; Apple's calendar: 1 = Sunday … 7 = Saturday.
      let slots = Set(weekdays).sorted()
      return Plan(
        triggers: slots.map { ($0, repeating(components(nil, nil, nil, weekday: $0 % 7 + 1))) }, rearm: false, reserved: slots.count)
    case "monthly":
      guard let day = rule.day, (1...31).contains(day) else {
        throw ReminderError.invalid("a monthly reminder needs a day 1 to 31")
      }
      // Up to the 28th every month has the day; past it, 31 means the last day of the month.
      if day <= 28 {
        return Plan(triggers: [(0, repeating(components(nil, nil, day)))], rearm: false, reserved: 1)
      }
      return Plan(triggers: oneTime(count: monthlyAhead, day: day), rearm: true, reserved: monthlyAhead)
    case "yearly":
      guard let month = rule.month, let day = rule.day, (1...12).contains(month), day >= 1,
        day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
      else {
        throw ReminderError.invalid("a yearly reminder needs a month and a day of the year")
      }
      if month == 2 && day == 29 {
        // 29 February is 28 February in a year without one.
        return Plan(triggers: oneTime(count: leapDayAhead, months: [2], day: 29), rearm: true, reserved: leapDayAhead)
      }
      return Plan(triggers: [(0, repeating(components(nil, month, day)))], rearm: false, reserved: 1)
    default:
      throw ReminderError.invalid("unknown repeat kind \(rule.kind)")
    }
  }

  private func lastDay(_ year: Int, _ month: Int) -> Int {
    let first = gregorian.date(from: DateComponents(year: year, month: month, day: 1))!
    return gregorian.range(of: .day, in: .month, for: first)!.count
  }

  /// The next `count` (year, month, day) strictly after `now` at `hour:minute`, in the months in `months` (all
  /// by default). A day past the month's end is the month's last day.
  private func occurrences(after now: Date, count: Int, hour: Int, minute: Int, months only: Set<Int>?, day: Int) -> [(Int, Int, Int)] {
    var found: [(Int, Int, Int)] = []
    let today = gregorian.dateComponents([.year, .month], from: now)
    var year = today.year!
    var month = today.month!
    for _ in 0..<(12 * 12) where found.count < count {
      if only == nil || only!.contains(month) {
        let d = min(day, lastDay(year, month))
        let at = gregorian.date(from: DateComponents(year: year, month: month, day: d, hour: hour, minute: minute))!
        if at > now { found.append((year, month, d)) }
      }
      month += 1
      if month > 12 {
        month = 1
        year += 1
      }
    }
    return found
  }

  private func parseTime(_ s: String) throws -> (Int, Int) {
    let parts = s.split(separator: ":").compactMap { Int($0) }
    guard parts.count == 2, (0...23).contains(parts[0]), (0...59).contains(parts[1]) else {
      throw ReminderError.invalid("time \(s) is not HH:MM")
    }
    return (parts[0], parts[1])
  }

  private func parseDate(_ s: String) throws -> (Int, Int, Int) {
    let parts = s.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { throw ReminderError.invalid("date \(s) is not YYYY-MM-DD") }
    return (parts[0], parts[1], parts[2])
  }
}

private func reminderId(of request: UNNotificationRequest) -> String? {
  request.content.userInfo["reminderId"] as? String
}

private func localText(_ date: Date) -> String {
  let formatter = DateFormatter()
  formatter.calendar = gregorian
  formatter.timeZone = TimeZone.current
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
  return formatter.string(from: date)
}

@_cdecl("init_plugin_droid_kit_reminders")
public func initPlugin() -> Plugin {
  return RemindersPlugin()
}
