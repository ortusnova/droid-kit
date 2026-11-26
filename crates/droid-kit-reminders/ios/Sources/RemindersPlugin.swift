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
// occurrences (slots 10 and up: `monthlyAhead` and `leapDayAhead` of them) and
// arms the next ones again at every app start and at every `schedule` call.
// That is the only time it can: a person who does not open the app for a year
// (12 months ahead) stops getting those reminders, because iOS gives an app no
// dependable way to run in the background.
//
// The rules come from `reminders.json`, the list the Rust side writes in the
// app's data directory (its path arrives with `configure` and `schedule`): the
// same file Android's boot receiver and Linux's reminderd read. UserDefaults
// keeps only this device's delivery state, as Android's `reminders-android.json`
// does: for each reminder that is armed with one-time triggers, its share of
// the 64 and the time of the last occurrence armed.
//
// Times are floating: the trigger's date components carry no calendar and no
// time zone, so the system reads them in the phone's time zone at the time a
// notification is due, and a 07:00 reminder is at 07:00 wherever the phone is.
// A Gregorian calendar is made, in the zone of the moment, only to work out
// which days are the last of a month.
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
//
// Known limit: the month and day of a repeating trigger are read in the
// calendar the phone is set to, so a phone set to a non-Gregorian calendar
// would read "monthly on the 15th" in that calendar. Not tried.

import Tauri
import UIKit
import UserNotifications
import WebKit

/// What iOS allows a single app to have pending.
let maxPending = 64
/// How many one-time occurrences a monthly rule on the 29th to 31st keeps armed: a year.
let monthlyAhead = 12
/// How many one-time occurrences a yearly rule on 29 February keeps armed: four years (one of them a 29 February).
let leapDayAhead = 4

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

/// One element of a list that may hold entries this build cannot read: it is nil, not an error for the whole list.
struct Lossy<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws {
    value = try? T(from: decoder)
  }
}

struct ScheduleArgs: Decodable {
  // The reminder as JSON, as the Kotlin side takes it.
  let reminder: String
  /// The path of reminders.json.
  let store: String?
}

struct ConfigureArgs: Decodable {
  let store: String
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

/// This device's state for a reminder armed with one-time triggers.
struct Delivery: Codable {
  /// Its share of the 64 pending requests.
  let reserved: Int
  /// The last occurrence armed, local `YYYY-MM-DDTHH:MM`.
  let until: String?
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
  /// The last one-time occurrence, if the rule is made of one-time triggers (so it needs arming again later).
  let last: String?
  let reserved: Int
  var rearm: Bool { last != nil }
}

/// A Gregorian calendar in the time zone of this moment (not one kept from an earlier one).
private func gregorianNow() -> Calendar {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone.autoupdatingCurrent
  return calendar
}

/// The key in UserDefaults: reminder id -> Delivery (as JSON), this device's state only.
let deliveryKey = "droid-kit-reminders.delivery"
/// The key of the version 0.2.0 copy of the rules, which is no longer used.
let oldRulesKey = "droid-kit-reminders.rearm"
/// The key of the path of reminders.json, remembered for the next start.
let storeKey = "droid-kit-reminders.store"

class RemindersPlugin: Plugin, UNUserNotificationCenterDelegate {
  /// The reminder whose notification was tapped before the page asked (cold start).
  private var tapped: String?
  /// Whether the page has called takeTapped, so it now listens for `tapped`.
  private var pageListens = false
  private let queue = DispatchQueue(label: "com.ortusnova.droidkit.reminders")
  /// Where reminders.json is (set by `configure`, and by each `schedule`).
  private var storePath: String? = UserDefaults.standard.string(forKey: storeKey)

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

  /// Called by the Rust side at start-up with the path of reminders.json: arms the next occurrences of the
  /// rules that are made of one-time triggers.
  @objc public func configure(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ConfigureArgs.self)
    queue.async {
      self.remember(args.store)
      UserDefaults.standard.removeObject(forKey: oldRulesKey)
      let armed = self.rearmAll(except: nil, purgeOrphans: true)
      self.emitArmed()
      NSLog("droid-kit-reminders: at start, armed \(armed) rule(s) of one-time triggers")
      invoke.resolve()
    }
  }

  @objc public func schedule(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ScheduleArgs.self)
    let reminder = try JSONDecoder().decode(Reminder.self, from: Data(args.reminder.utf8))
    queue.async {
      do {
        if let store = args.store { self.remember(store) }
        try self.arm(reminder)
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
      var state = self.deliveries()
      state.removeValue(forKey: args.id)
      self.save(state)
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
  private func arm(_ reminder: Reminder) throws {
    let now = Date()
    let plan = try makePlan(reminder.repeat, after: now)
    let pending = pendingRequests()
    var state = deliveries()

    // What the other reminders hold: a reminder armed with one-time triggers keeps its full share even when some
    // of its occurrences have fired; the others hold what is pending.
    var others = 0
    var counted = Set<String>([reminder.id])
    for (id, delivery) in state where id != reminder.id {
      counted.insert(id)
      others += delivery.reserved
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
    if plan.rearm {
      state[reminder.id] = Delivery(reserved: plan.reserved, until: plan.last)
    } else {
      state.removeValue(forKey: reminder.id)
    }
    save(state)
    rearmAll(except: reminder.id, purgeOrphans: false)
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

  /// Arms the next occurrences of every reminder this device armed with one-time triggers (but one), from the
  /// rules in reminders.json. A reminder that fails, or one whose rule cannot be read, is left as it was.
  /// With `purgeOrphans` (at start, when no call is half done) a reminder the file no longer lists is removed;
  /// with no readable file nothing is removed. Returns how many it armed.
  @discardableResult
  private func rearmAll(except skip: String?, purgeOrphans: Bool) -> Int {
    var state = deliveries()
    let wanted = state.keys.filter { $0 != skip }
    if wanted.isEmpty { return 0 }
    guard let list = readStore() else {
      NSLog("droid-kit-reminders: reminders.json is missing or unreadable, so \(wanted.count) rule(s) are not armed again")
      return 0
    }
    let pending = pendingRequests()
    let now = Date()
    var armed = 0
    for id in wanted {
      guard let reminder = list.first(where: { $0.id == id }) else {
        if purgeOrphans {
          let identifiers = pending.filter { reminderId(of: $0) == id }.map { $0.identifier }
          UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiers)
          state.removeValue(forKey: id)
        }
        continue
      }
      guard let plan = try? makePlan(reminder.repeat, after: now), plan.rearm else {
        NSLog("droid-kit-reminders: \(id) has a rule this build does not arm again")
        continue
      }
      do {
        try replace(reminder, plan: plan, pending: pending)
        state[id] = Delivery(reserved: plan.reserved, until: plan.last)
        armed += 1
      } catch {
        NSLog("droid-kit-reminders: could not arm \(id): \(error.localizedDescription)")
      }
    }
    save(state)
    return armed
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

  // MARK: reminders.json, and this device's own state

  private func remember(_ path: String) {
    storePath = path
    UserDefaults.standard.set(path, forKey: storeKey)
  }

  /// The reminders in reminders.json, or nil when the file is not there or cannot be read. An entry this build
  /// cannot read is left out, and the others are used.
  private func readStore() -> [Reminder]? {
    guard let path = storePath else { return nil }
    // Not there is as unreadable, not an empty list: the Rust side writes the file ([] when it is empty)
    // after every schedule and cancel, so a missing file means something went wrong, and nothing is removed.
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    guard let entries = try? JSONDecoder().decode([Lossy<Reminder>].self, from: data) else { return nil }
    return entries.compactMap { $0.value }
  }

  private func deliveries() -> [String: Delivery] {
    guard let data = UserDefaults.standard.data(forKey: deliveryKey) else { return [:] }
    return (try? JSONDecoder().decode([String: Delivery].self, from: data)) ?? [:]
  }

  private func save(_ state: [String: Delivery]) {
    UserDefaults.standard.set(try? JSONEncoder().encode(state), forKey: deliveryKey)
  }

  // MARK: the rules

  /// The triggers a rule needs from `now` on, and its share of the 64.
  private func makePlan(_ rule: Repeat, after now: Date) throws -> Plan {
    let (hour, minute) = try parseTime(rule.time)
    /// Floating date components: no calendar and no time zone, read in the phone's zone when a notification is due.
    func components(_ month: Int?, _ day: Int?, weekday: Int? = nil) -> DateComponents {
      DateComponents(month: month, day: day, hour: hour, minute: minute, second: 0, weekday: weekday)
    }
    func repeating(_ when: DateComponents) -> UNCalendarNotificationTrigger {
      UNCalendarNotificationTrigger(dateMatching: when, repeats: true)
    }
    /// A one-time trigger on a Gregorian date, in the phone's calendar (the same unless it is set to another).
    func once(_ year: Int, _ month: Int, _ day: Int) -> UNCalendarNotificationTrigger {
      var when = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: 0)
      let mine = Calendar.autoupdatingCurrent
      if mine.identifier != .gregorian, let date = gregorianNow().date(from: when) {
        when = mine.dateComponents([.era, .year, .month, .day], from: date)
        when.hour = hour
        when.minute = minute
        when.second = 0
      }
      return UNCalendarNotificationTrigger(dateMatching: when, repeats: false)
    }
    /// The next `count` occurrences, as one-time triggers in slots 10 and up, and the last one's time.
    func oneTime(count: Int, months: Set<Int>? = nil, day: Int) -> ([(Int, UNCalendarNotificationTrigger)], String?) {
      let found = occurrences(after: now, count: count, hour: hour, minute: minute, months: months, day: day)
      let triggers = found.enumerated().map { index, date in (10 + index, once(date.0, date.1, date.2)) }
      let last = found.last.map { String(format: "%04d-%02d-%02dT%02d:%02d", $0.0, $0.1, $0.2, hour, minute) }
      // A rule with no occurrence in sight still needs arming again later.
      return (triggers, last ?? "")
    }
    switch rule.kind {
    case "once":
      guard let date = rule.date else { throw ReminderError.invalid("a one-time reminder needs a date") }
      let (year, month, day) = try parseDate(date)
      return Plan(triggers: [(0, once(year, month, day))], last: nil, reserved: 1)
    case "daily":
      return Plan(triggers: [(0, repeating(components(nil, nil)))], last: nil, reserved: 1)
    case "weekly":
      guard let weekdays = rule.weekdays, !weekdays.isEmpty, weekdays.allSatisfy({ (1...7).contains($0) }) else {
        throw ReminderError.invalid("a weekly reminder needs weekdays 1 (Monday) to 7 (Sunday)")
      }
      // ISO 1 = Monday … 7 = Sunday; Apple's calendar: 1 = Sunday … 7 = Saturday.
      let slots = Set(weekdays).sorted()
      return Plan(triggers: slots.map { ($0, repeating(components(nil, nil, weekday: $0 % 7 + 1))) }, last: nil, reserved: slots.count)
    case "monthly":
      guard let day = rule.day, (1...31).contains(day) else {
        throw ReminderError.invalid("a monthly reminder needs a day 1 to 31")
      }
      // Up to the 28th every month has the day; past it, 31 means the last day of the month.
      if day <= 28 {
        return Plan(triggers: [(0, repeating(components(nil, day)))], last: nil, reserved: 1)
      }
      let (triggers, last) = oneTime(count: monthlyAhead, day: day)
      return Plan(triggers: triggers, last: last, reserved: monthlyAhead)
    case "yearly":
      guard let month = rule.month, let day = rule.day, (1...12).contains(month), day >= 1,
        day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
      else {
        throw ReminderError.invalid("a yearly reminder needs a month and a day of the year")
      }
      if month == 2 && day == 29 {
        // 29 February is 28 February in a year without one.
        let (triggers, last) = oneTime(count: leapDayAhead, months: [2], day: 29)
        return Plan(triggers: triggers, last: last, reserved: leapDayAhead)
      }
      return Plan(triggers: [(0, repeating(components(month, day)))], last: nil, reserved: 1)
    default:
      throw ReminderError.invalid("unknown repeat kind \(rule.kind)")
    }
  }

  private func lastDay(_ calendar: Calendar, _ year: Int, _ month: Int) -> Int {
    let first = calendar.date(from: DateComponents(year: year, month: month, day: 1))!
    return calendar.range(of: .day, in: .month, for: first)!.count
  }

  /// The next `count` (year, month, day) strictly after `now` at `hour:minute`, in the months in `months` (all
  /// by default). A day past the month's end is the month's last day.
  private func occurrences(after now: Date, count: Int, hour: Int, minute: Int, months only: Set<Int>?, day: Int) -> [(Int, Int, Int)] {
    let calendar = gregorianNow()
    var found: [(Int, Int, Int)] = []
    let today = calendar.dateComponents([.year, .month], from: now)
    var year = today.year!
    var month = today.month!
    for _ in 0..<(12 * 12) where found.count < count {
      if only == nil || only!.contains(month) {
        let d = min(day, lastDay(calendar, year, month))
        let at = calendar.date(from: DateComponents(year: year, month: month, day: d, hour: hour, minute: minute))!
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
  formatter.calendar = gregorianNow()
  formatter.timeZone = TimeZone.autoupdatingCurrent
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
  return formatter.string(from: date)
}

@_cdecl("init_plugin_droid_kit_reminders")
public func initPlugin() -> Plugin {
  return RemindersPlugin()
}
