package com.ortusnova.droidkit.reminders

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity

/**
 * Which reminder's notification started or came back to the app.
 *
 * The id travels in the tap's intent, and Android may hand that intent over before the plugin exists: when the
 * app's process was killed but its task is still in the recents, the activity is recreated from the task's
 * first intent and the tap's intent follows through `onNewIntent`, which reaches the plugins that are registered
 * by then, and the Rust side registers this plugin only afterwards. So the intents are watched from the start of
 * the process (see [ReminderTapInit]) and the id is kept until the page asks for it. After that a tap is an event.
 * Either way a tap is told to the page once.
 */
object ReminderTaps {
    private val lock = Any()
    private var pending: String? = null
    private var plugin: ReminderTapPlugin? = null

    fun attach(p: ReminderTapPlugin) = synchronized(lock) { plugin = p }

    /** An intent that may carry a tap (an activity's own, or one that arrived later). Its id is read once. */
    fun offer(intent: Intent?) {
        val id = intent?.getStringExtra(Reminders.EXTRA_ID) ?: return
        intent.removeExtra(Reminders.EXTRA_ID)
        val live = synchronized(lock) {
            val p = plugin
            if (p != null && p.pageAsked) {
                p
            } else {
                pending = id
                null
            }
        }
        live?.sendTapped(id)
    }

    /** The page asks: the id kept for it, once. From now on taps are events. */
    fun take(p: ReminderTapPlugin): String? = synchronized(lock) {
        p.pageAsked = true
        val id = pending
        pending = null
        id
    }
}

/**
 * Runs when the process starts, before any activity (a content provider's `onCreate` does), and watches every
 * activity for tap intents. No content is served; this is only a way to be early.
 */
class ReminderTapInit : ContentProvider() {
    override fun onCreate(): Boolean {
        val app = context?.applicationContext as? Application ?: return false
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
                ReminderTaps.offer(activity.intent)
                (activity as? ComponentActivity)?.addOnNewIntentListener { ReminderTaps.offer(it) }
            }
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
