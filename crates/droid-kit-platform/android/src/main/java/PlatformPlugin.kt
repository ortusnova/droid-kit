package com.ortusnova.droidkit.platform

import android.app.Activity
import android.app.UiModeManager
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.webkit.WebView
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SystemBarsArgs {
    var dark: Boolean = false
    var background: String? = null
    /** "light", "dark" or "system": the app's theme choice. */
    var preference: String? = null
}

@TauriPlugin
class PlatformPlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null

    override fun load(webView: WebView) {
        this.webView = webView
    }

    /**
     * Status and navigation bar icons contrast with the page, and the window
     * and web view behind the page take its background colour, so nothing of
     * another colour shows while the page loads or resizes.
     */
    @Command
    fun setSystemBars(invoke: Invoke) {
        val args = invoke.parseArgs(SystemBarsArgs::class.java)
        activity.runOnUiThread {
            val window = activity.window
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            controller.isAppearanceLightStatusBars = !args.dark
            controller.isAppearanceLightNavigationBars = !args.dark
            // The icons already contrast with the page, so drop the translucent
            // scrim Android puts behind 3-button navigation; the page's own bar
            // background then reaches the bottom edge.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isNavigationBarContrastEnforced = false
                window.isStatusBarContrastEnforced = false
            }
            // Android 12+ keeps a night mode per app and uses it for the
            // starting window drawn before the app runs, so an override of the
            // system setting shows no frame of the other theme at launch.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && args.preference != null) {
                val uiMode = activity.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
                val mode = when (args.preference) {
                    "dark" -> UiModeManager.MODE_NIGHT_YES
                    "light" -> UiModeManager.MODE_NIGHT_NO
                    else -> UiModeManager.MODE_NIGHT_AUTO
                }
                uiMode.setApplicationNightMode(mode)
            }
            args.background?.let { hex ->
                val colour = Color.parseColor(hex)
                window.decorView.setBackgroundColor(colour)
                webView?.setBackgroundColor(colour)
            }
            invoke.resolve()
        }
    }

    /** What the system back action does on a start screen. */
    @Command
    fun moveToBackground(invoke: Invoke) {
        activity.runOnUiThread {
            activity.moveTaskToBack(true)
            invoke.resolve()
        }
    }
}
