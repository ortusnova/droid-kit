package com.ortusnova.droidkit.reminders

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class ScheduleArgs {
    /** The reminder as the Rust side stores it: { id, title, body, repeat }. */
    lateinit var reminder: String
}

@InvokeArg
class CancelArgs {
    lateinit var id: String
}

/**
 * The Android side of droid-kit-reminders: schedules reminder alarms (see
 * Reminders) and reports which reminder's notification opened the app.
 */
@TauriPlugin
class ReminderTapPlugin(private val activity: Activity) : Plugin(activity) {
    /**
     * The page has asked with `takeTapped` at least once, so it listens for the `tapped` event. Until then a tap
     * is kept for `takeTapped` ([ReminderTaps]).
     */
    @Volatile
    var pageAsked = false

    override fun load(webView: WebView) {
        super.load(webView)
        ReminderTaps.attach(this)
        // A force-stop removes every alarm, and a reminder may have come due while the app was closed:
        // bring them up to date. Off the main thread, because it reads and writes files; it never calls Rust.
        val context = activity.applicationContext
        Thread {
            try {
                Reminders.restoreAll(context)
            } catch (e: Exception) {
                android.util.Log.w("droid-kit-reminders", "cannot restore reminders at start: $e")
            }
        }.start()
    }

    /** A tap while the page listens: tell it now. */
    fun sendTapped(id: String) {
        val event = JSObject()
        event.put("id", id)
        trigger("tapped", event)
    }

    @Command
    fun schedule(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleArgs::class.java)
        Reminders.schedule(activity.applicationContext, JSONObject(args.reminder))
        invoke.resolve()
    }

    @Command
    fun cancel(invoke: Invoke) {
        val args = invoke.parseArgs(CancelArgs::class.java)
        Reminders.cancel(activity.applicationContext, args.id)
        invoke.resolve()
    }

    /** Opens the app's notification settings, or its details page if the system has no such screen. */
    @Command
    fun openSettings(invoke: Invoke) {
        val context = activity.applicationContext
        val notifications = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(notifications)
        } catch (e: ActivityNotFoundException) {
            activity.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
        invoke.resolve()
    }

    /** The id of the reminder whose notification started the app, once. */
    @Command
    fun takeTapped(invoke: Invoke) {
        val result = JSObject()
        result.put("id", ReminderTaps.take(this))
        invoke.resolve(result)
    }
}
