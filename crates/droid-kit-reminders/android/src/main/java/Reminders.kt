package com.ortusnova.droidkit.reminders

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Calendar

/**
 * Reminder alarms. Every occurrence is an exact alarm allowed while idle
 * (RTC_WAKEUP), so it wakes a dozing phone. Repeating reminders compute their
 * next occurrence on the device's calendar when one fires, so they keep their
 * wall-clock time across daylight-saving and time-zone changes.
 *
 * Repeat rules: once, daily, weekly, monthly (a day 1 to 31; a month with
 * fewer days takes its last day, so 31 means the last day) and yearly (a month
 * and day; 29 February falls on 28 February in years without one). Any other
 * kind is refused: logged and skipped, never treated as daily.
 *
 * Not tauri-plugin-notification's scheduler: in 2.8.1 it reschedules each
 * later occurrence of a repeating notification as a plain RTC alarm, which
 * does not wake the device.
 *
 * Missed occurrences follow the Linux service (droid-kit-reminderd): for each
 * reminder `reminders-android.json` keeps the rule it was last looked at under
 * and a time up to which occurrences are done. When the reminders are restored
 * (boot, app update, clock or time-zone change, app start), the newest
 * occurrence after that time and up to now is delivered once, the time moves
 * to now, and the next occurrence is armed. A reminder seen for the first time,
 * or whose rule changed, starts from now, so nothing before it is delivered.
 * Every path that delivers goes through [lock] and that time, so an alarm and
 * a restore never deliver the same occurrence twice.
 */
object Reminders {
    const val EXTRA_ID = "dk.reminder.id"
    private const val EXTRA_JSON = "dk.reminder.json"
    private const val EXTRA_AT = "dk.reminder.at"
    private const val CHANNEL = "dk-reminders"
    private const val TAG = "droid-kit-reminders"
    private val KINDS = setOf("once", "daily", "weekly", "monthly", "yearly")
    private val lock = Any()

    /** reminders.json in the app's data directory, written by the Rust side. */
    fun storeFile(context: Context): File = File(context.dataDir, "reminders.json")

    /** What has been delivered: { id: { fingerprint, until } }, in milliseconds. */
    private fun stateFile(context: Context): File = File(context.dataDir, "reminders-android.json")

    private fun requestCode(id: String): Int = ("dk-reminder:$id").hashCode()

    private fun pending(context: Context, id: String, reminder: JSONObject?, trigger: Long, flags: Int): PendingIntent? {
        val intent = Intent(context, ReminderReceiver::class.java).setAction("com.ortusnova.droidkit.reminders.FIRE").putExtra(EXTRA_ID, id)
        if (reminder != null) intent.putExtra(EXTRA_JSON, reminder.toString()).putExtra(EXTRA_AT, trigger)
        return PendingIntent.getBroadcast(context, requestCode(id), intent, flags or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Whether this build knows the reminder's repeat kind. An unknown one is logged and skipped by every path below. */
    private fun supported(reminder: JSONObject): Boolean {
        val kind = reminder.optJSONObject("repeat")?.optString("kind") ?: ""
        if (kind in KINDS) return true
        android.util.Log.w(TAG, "ignoring reminder ${reminder.optString("id")}: unknown repeat kind \"$kind\"")
        return false
    }

    /** The time rule of a reminder, as text: it changes when the app replaces the reminder with another rule. */
    private fun fingerprint(reminder: JSONObject): String {
        val repeat = reminder.getJSONObject("repeat")
        return when (repeat.getString("kind")) {
            "once" -> "once ${repeat.getString("date")} ${repeat.getString("time")}"
            "weekly" -> {
                val arr = repeat.getJSONArray("weekdays")
                "weekly ${(0 until arr.length()).map { arr.getInt(it) }.sorted().joinToString(",")} ${repeat.getString("time")}"
            }
            "daily" -> "daily ${repeat.getString("time")}"
            "monthly" -> "monthly ${repeat.getInt("day")} ${repeat.getString("time")}"
            "yearly" -> "yearly ${repeat.getInt("month")} ${repeat.getInt("day")} ${repeat.getString("time")}"
            else -> throw IllegalArgumentException("unknown repeat kind ${repeat.getString("kind")}")
        }
    }

    private fun isOnce(reminder: JSONObject): Boolean = reminder.getJSONObject("repeat").getString("kind") == "once"

    /**
     * The occurrence of a monthly or yearly rule in one month, in the device's zone.
     * `month` counts from 0. A day past the month's end becomes its last day.
     */
    private fun occurrence(year: Int, month: Int, day: Int, h: Int, m: Int): Long {
        val cal = Calendar.getInstance()
        cal.clear()
        cal.set(year, month, 1)
        val last = cal.getActualMaximum(Calendar.DAY_OF_MONTH)
        cal.set(year, month, minOf(day, last), h, m, 0)
        return cal.timeInMillis
    }

    /** The first occurrence strictly after `after`, or null if there is none (also for a kind this build does not know). */
    fun nextTrigger(reminder: JSONObject, after: Long): Long? {
        val repeat = reminder.getJSONObject("repeat")
        when (repeat.getString("kind")) {
            "once" -> {
                val (y, mo, d) = repeat.getString("date").split("-").map { it.toInt() }
                val (h, m) = repeat.getString("time").split(":").map { it.toInt() }
                val cal = Calendar.getInstance()
                cal.clear()
                cal.set(y, mo - 1, d, h, m, 0)
                return if (cal.timeInMillis > after) cal.timeInMillis else null
            }
            "daily", "weekly" -> {
                val (h, m) = repeat.getString("time").split(":").map { it.toInt() }
                val weekdays = if (repeat.getString("kind") == "weekly") {
                    val arr = repeat.getJSONArray("weekdays")
                    (0 until arr.length()).map { arr.getInt(it) }.toSet()
                } else null
                val cal = Calendar.getInstance()
                cal.timeInMillis = after
                // From the day before: a time-zone change can put an occurrence of the previous civil day after `after`.
                cal.add(Calendar.DAY_OF_MONTH, -1)
                for (i in 0..9) {
                    cal.set(Calendar.HOUR_OF_DAY, h)
                    cal.set(Calendar.MINUTE, m)
                    cal.set(Calendar.SECOND, 0)
                    cal.set(Calendar.MILLISECOND, 0)
                    // Calendar counts Sunday = 1; ISO counts Monday = 1.
                    val iso = (cal.get(Calendar.DAY_OF_WEEK) + 5) % 7 + 1
                    if (cal.timeInMillis > after && (weekdays == null || iso in weekdays)) return cal.timeInMillis
                    cal.add(Calendar.DAY_OF_MONTH, 1)
                }
                return null
            }
            "monthly", "yearly" -> {
                val (h, m) = repeat.getString("time").split(":").map { it.toInt() }
                val day = repeat.getInt("day")
                val yearly = repeat.getString("kind") == "yearly"
                val month = if (yearly) repeat.getInt("month") - 1 else 0
                val start = Calendar.getInstance()
                start.timeInMillis = after
                val year = start.get(Calendar.YEAR)
                val startMonth = start.get(Calendar.MONTH)
                // From the month (year) before: a time-zone change can put an occurrence of the previous one after `after`.
                if (yearly) {
                    for (y in year - 1..year + 8) {
                        val t = occurrence(y, month, day, h, m)
                        if (t > after) return t
                    }
                } else {
                    for (i in -1..14) {
                        val index = year * 12 + startMonth + i
                        val t = occurrence(index / 12, index % 12, day, h, m)
                        if (t > after) return t
                    }
                }
                return null
            }
        }
        return null
    }

    /** The longest gap between two occurrences of a rule, in days: how far back a missed one can matter. */
    private fun maxGapDays(reminder: JSONObject): Long = when (reminder.getJSONObject("repeat").getString("kind")) {
        "yearly" -> 367
        "monthly" -> 32
        else -> 9
    }

    /** The newest occurrence in (after, upto]: the one to deliver when several passed while nothing was armed. */
    fun latestIn(reminder: JSONObject, after: Long, upto: Long): Long? {
        // Only the newest missed occurrence is delivered, so look back no further than the rule's longest gap.
        var cursor = maxOf(after, upto - maxGapDays(reminder) * 24 * 3600 * 1000)
        var last: Long? = null
        for (i in 0 until 16) {
            val t = nextTrigger(reminder, cursor)
            if (t == null || t > upto) break
            last = t
            cursor = t
        }
        return last
    }

    private fun loadState(context: Context): JSONObject = try {
        JSONObject(stateFile(context).readText())
    } catch (e: Exception) {
        JSONObject()
    }

    private fun saveState(context: Context, state: JSONObject) {
        val file = stateFile(context)
        val temp = File(file.parentFile, "reminders-android.json.tmp")
        temp.writeText(state.toString())
        temp.renameTo(file)
    }

    private fun arm(context: Context, id: String, reminder: JSONObject, trigger: Long) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = pending(context, id, reminder, trigger, PendingIntent.FLAG_UPDATE_CURRENT)!!
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarms.canScheduleExactAlarms()) {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi)
        } else {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi)
        }
    }

    private fun disarm(context: Context, id: String) {
        val pi = pending(context, id, null, 0, PendingIntent.FLAG_NO_CREATE) ?: return
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pi)
        pi.cancel()
    }

    /**
     * Brings one reminder up to date: delivers the occurrence that was missed,
     * if any, and arms the next. A one-time reminder that has been delivered is
     * done. Call with [lock] held; `state` is saved by the caller.
     */
    private fun sync(context: Context, reminder: JSONObject, state: JSONObject, now: Long) {
        val id = reminder.getString("id")
        if (!supported(reminder)) {
            disarm(context, id)
            state.remove(id)
            return
        }
        val fp = fingerprint(reminder)
        var entry = state.optJSONObject(id)
        if (entry == null || entry.getString("fingerprint") != fp) {
            entry = JSONObject().put("fingerprint", fp).put("until", now)
            state.put(id, entry)
        }
        // A clock set back must not hold deliveries off until it catches up.
        val until = minOf(entry.getLong("until"), now)
        val missed = latestIn(reminder, until, now)
        entry.put("until", now)
        if (missed != null) show(context, reminder)
        if (isOnce(reminder) && missed != null) {
            disarm(context, id)
            state.remove(id)
            forget(context, id)
            return
        }
        val trigger = nextTrigger(reminder, now)
        if (trigger == null) disarm(context, id) else arm(context, id, reminder, trigger)
    }

    /** Called by the app: a reminder is new, replaced, or still the same. */
    fun schedule(context: Context, reminder: JSONObject) {
        synchronized(lock) {
            val state = loadState(context)
            sync(context, reminder, state, System.currentTimeMillis())
            saveState(context, state)
        }
    }

    fun cancel(context: Context, id: String) {
        synchronized(lock) {
            disarm(context, id)
            val state = loadState(context)
            if (state.remove(id) != null) saveState(context, state)
        }
    }

    /**
     * Brings every stored reminder up to date: at boot, after an app update, a
     * clock or time-zone change, and when the app starts (a force-stop removes
     * all alarms). Delivers what was missed, once, and arms the next occurrences.
     */
    fun restoreAll(context: Context) {
        synchronized(lock) {
            val file = storeFile(context)
            if (!file.exists()) return
            val list = JSONArray(file.readText())
            val state = loadState(context)
            val now = System.currentTimeMillis()
            val ids = HashSet<String>()
            for (i in 0 until list.length()) {
                val reminder = list.getJSONObject(i)
                ids.add(reminder.getString("id"))
                try {
                    sync(context, reminder, state, now)
                } catch (e: Exception) {
                    android.util.Log.w(TAG, "cannot restore ${reminder.optString("id")}: $e")
                }
            }
            // Reminders the app removed no longer count as seen.
            for (id in state.keys().asSequence().toList()) if (id !in ids) state.remove(id)
            saveState(context, state)
        }
    }

    fun show(context: Context, reminder: JSONObject) {
        android.util.Log.i("droid-kit-reminders", "delivering ${reminder.optString("id")} at ${System.currentTimeMillis()}")
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH))
        }
        val id = reminder.getString("id")
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)!!
            .setAction(Intent.ACTION_MAIN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_ID, id)
        val content = PendingIntent.getActivity(context, requestCode(id), launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val icon = context.applicationInfo.icon
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(icon)
            .setContentTitle(reminder.optString("title"))
            .setContentText(reminder.optString("body"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(content)
            .build()
        manager.notify(requestCode(id), notification)
    }

    /** An alarm went off: deliver its occurrence unless a restore already did, then arm the next. */
    fun fired(context: Context, intent: Intent) {
        val json = intent.getStringExtra(EXTRA_JSON) ?: return
        val reminder = JSONObject(json)
        val id = reminder.getString("id")
        if (!supported(reminder)) {
            disarm(context, id)
            return
        }
        synchronized(lock) {
            val now = System.currentTimeMillis()
            val at = intent.getLongExtra(EXTRA_AT, now)
            val state = loadState(context)
            val fp = fingerprint(reminder)
            val entry = state.optJSONObject(id)
            // No record, or one for another rule: nothing says it was delivered.
            val until = if (entry != null && entry.getString("fingerprint") == fp) minOf(entry.getLong("until"), now) else Long.MIN_VALUE
            if (at > until) show(context, reminder)
            state.put(id, JSONObject().put("fingerprint", fp).put("until", now))
            if (isOnce(reminder)) {
                state.remove(id)
                forget(context, id)
            } else {
                // Repeating reminders: the next occurrence, from the calendar as it is now.
                val trigger = nextTrigger(reminder, now)
                if (trigger == null) disarm(context, id) else arm(context, id, reminder, trigger)
            }
            saveState(context, state)
        }
    }

    /** Takes a one-time reminder that has been delivered out of the stored list, so `list` shows only what is still scheduled. */
    private fun forget(context: Context, id: String) {
        val file = storeFile(context)
        if (!file.exists()) return
        val list = JSONArray(file.readText())
        val kept = JSONArray()
        for (i in 0 until list.length()) if (list.getJSONObject(i).getString("id") != id) kept.put(list.getJSONObject(i))
        if (kept.length() == list.length()) return
        val temp = File(file.parentFile, "reminders.json.tmp")
        temp.writeText(kept.toString(2))
        temp.renameTo(file)
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Reminders.fired(context, intent)
    }
}

/** Re-arms every reminder, and delivers what was missed, after a reboot, an app update, or a change of clock or time zone. */
class ReminderRestoreReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Reminders.restoreAll(context)
    }
}
