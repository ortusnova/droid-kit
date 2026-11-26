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
 * Not tauri-plugin-notification's scheduler: in 2.8.1 it reschedules each
 * later occurrence of a repeating notification as a plain RTC alarm, which
 * does not wake the device.
 */
object Reminders {
    const val EXTRA_ID = "dk.reminder.id"
    private const val EXTRA_JSON = "dk.reminder.json"
    private const val CHANNEL = "dk-reminders"

    /** reminders.json in the app's data directory, written by the Rust side. */
    fun storeFile(context: Context): File = File(context.dataDir, "reminders.json")

    private fun requestCode(id: String): Int = ("dk-reminder:$id").hashCode()

    private fun pending(context: Context, id: String, reminder: JSONObject?, flags: Int): PendingIntent? {
        val intent = Intent(context, ReminderReceiver::class.java).setAction("com.ortusnova.droidkit.reminders.FIRE").putExtra(EXTRA_ID, id)
        if (reminder != null) intent.putExtra(EXTRA_JSON, reminder.toString())
        return PendingIntent.getBroadcast(context, requestCode(id), intent, flags or PendingIntent.FLAG_IMMUTABLE)
    }

    /** The next time a reminder fires after `now`, or null if it never will. */
    fun nextTrigger(reminder: JSONObject, now: Long): Long? {
        val repeat = reminder.getJSONObject("repeat")
        when (repeat.getString("kind")) {
            "once" -> {
                val (y, mo, d) = repeat.getString("date").split("-").map { it.toInt() }
                val (h, m) = repeat.getString("time").split(":").map { it.toInt() }
                val cal = Calendar.getInstance()
                cal.clear()
                cal.set(y, mo - 1, d, h, m, 0)
                return if (cal.timeInMillis > now) cal.timeInMillis else null
            }
            "daily", "weekly" -> {
                val (h, m) = repeat.getString("time").split(":").map { it.toInt() }
                val weekdays = if (repeat.getString("kind") == "weekly") {
                    val arr = repeat.getJSONArray("weekdays")
                    (0 until arr.length()).map { arr.getInt(it) }.toSet()
                } else null
                val cal = Calendar.getInstance()
                cal.timeInMillis = now
                cal.set(Calendar.HOUR_OF_DAY, h)
                cal.set(Calendar.MINUTE, m)
                cal.set(Calendar.SECOND, 0)
                cal.set(Calendar.MILLISECOND, 0)
                for (i in 0..7) {
                    // Calendar counts Sunday = 1; ISO counts Monday = 1.
                    val iso = (cal.get(Calendar.DAY_OF_WEEK) + 5) % 7 + 1
                    if (cal.timeInMillis > now && (weekdays == null || iso in weekdays)) return cal.timeInMillis
                    cal.add(Calendar.DAY_OF_MONTH, 1)
                    cal.set(Calendar.HOUR_OF_DAY, h)
                    cal.set(Calendar.MINUTE, m)
                }
                return null
            }
        }
        return null
    }

    fun schedule(context: Context, reminder: JSONObject) {
        val id = reminder.getString("id")
        val trigger = nextTrigger(reminder, System.currentTimeMillis()) ?: return cancel(context, id)
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = pending(context, id, reminder, PendingIntent.FLAG_UPDATE_CURRENT)!!
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarms.canScheduleExactAlarms()) {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi)
        } else {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi)
        }
    }

    fun cancel(context: Context, id: String) {
        val pi = pending(context, id, null, PendingIntent.FLAG_NO_CREATE) ?: return
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pi)
        pi.cancel()
    }

    /** Schedules every stored reminder again: after a reboot, or a clock or time-zone change. */
    fun restoreAll(context: Context) {
        val file = storeFile(context)
        if (!file.exists()) return
        val list = JSONArray(file.readText())
        for (i in 0 until list.length()) schedule(context, list.getJSONObject(i))
    }

    fun show(context: Context, reminder: JSONObject) {
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

    fun fired(context: Context, intent: Intent) {
        val json = intent.getStringExtra(EXTRA_JSON) ?: return
        val reminder = JSONObject(json)
        show(context, reminder)
        // Repeating reminders: the next occurrence, from the calendar as it is now.
        if (reminder.getJSONObject("repeat").getString("kind") != "once") schedule(context, reminder) else forget(context, reminder.getString("id"))
    }

    /** Takes a one-time reminder that has fired out of the stored list, so `list` shows only what is still scheduled. */
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

/** Re-arms every reminder after a reboot, an app update, or a change of clock or time zone. */
class ReminderRestoreReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Reminders.restoreAll(context)
    }
}
