package com.ortusnova.droidkit.reminders

import android.app.Activity
import android.content.Intent
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
    private var tapped: String? = null

    override fun load(webView: WebView) {
        super.load(webView)
        activity.intent?.let { remember(it, notify = false) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        remember(intent, notify = true)
    }

    private fun remember(intent: Intent, notify: Boolean) {
        val id = intent.getStringExtra(Reminders.EXTRA_ID) ?: return
        intent.removeExtra(Reminders.EXTRA_ID)
        if (notify) {
            // The app is running: tell the page now.
            val event = JSObject()
            event.put("id", id)
            trigger("tapped", event)
        } else {
            // Cold start: the page asks with takeTapped once it is ready.
            tapped = id
        }
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

    /** The id of the reminder whose notification started the app, once. */
    @Command
    fun takeTapped(invoke: Invoke) {
        val result = JSObject()
        result.put("id", tapped)
        tapped = null
        invoke.resolve(result)
    }
}
