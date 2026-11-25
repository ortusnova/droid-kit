/* droid-kit boot script. Inlined first in <head> by the droidKit() Vite
 * plugin, so it runs before the app bundle is requested.
 *
 * ES5 only: it must run on engines far older than the ones the app supports,
 * to tell their users to update.
 *
 * It checks the engine against the minimums, and otherwise sets, before the
 * first paint:
 *   window.__DK__             { platform, engine, formFactor, theme, themePreference, debug, startRoute }
 *   <html data-platform data-form-factor data-theme>
 *   --dk-keyboard             height of the on-screen keyboard over the page
 * and then starts the app's module scripts, which the Vite plugin made inert.
 *
 * window.__DK_NATIVE__ is set by the droid-kit-platform plugin's init script:
 *   { platform: "android" | "linux" | ..., engine: { name, version }, debug, startRoute }
 * It is absent in a plain browser.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.boot(root);
})(this, function () {
  var MINIMUM = { 'android-webview': [140], webkitgtk: [2, 54] };
  var THEME_KEY = 'dk.theme';
  var ENGINE_OVERRIDE_KEY = 'dk.debug.engineVersion';

  function parseVersion(text) {
    var parts = String(text).split('.');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i], 10);
      if (isNaN(n)) break;
      out.push(n);
    }
    return out;
  }

  /* -1, 0 or 1, comparing only as many parts as `b` has. */
  function compareVersion(a, b) {
    for (var i = 0; i < b.length; i++) {
      var x = a[i] || 0;
      if (x !== b[i]) return x < b[i] ? -1 : 1;
    }
    return 0;
  }

  /* The engine and its version. Android's reduced user agent still carries
   * the WebView's major version; WebKitGTK's does not, so it comes from native. */
  function detectEngine(native, userAgent) {
    if (native && native.engine && native.engine.version) {
      return { name: native.engine.name, version: native.engine.version };
    }
    var chrome = /Chrome\/(\d+)/.exec(userAgent);
    if (/; wv\)/.test(userAgent) && chrome) return { name: 'android-webview', version: chrome[1] };
    if (native && native.engine) return { name: native.engine.name, version: null };
    return { name: 'browser', version: null };
  }

  /* Whether the engine meets the minimum. Unknown engines and versions pass. */
  function engineSupported(engine) {
    var min = MINIMUM[engine.name];
    if (!min || !engine.version) return true;
    return compareVersion(parseVersion(engine.version), min) >= 0;
  }

  function minimumText(name) {
    return MINIMUM[name] ? MINIMUM[name].join('.') : '';
  }

  /* app-platform spec: phone on Android; on Linux when touch is the primary
   * input and the narrower side of the screen is under 600 CSS pixels. */
  function formFactor(platform, coarsePointer, screenWidth, screenHeight) {
    if (platform === 'android' || platform === 'ios') return 'phone';
    if (coarsePointer && Math.min(screenWidth, screenHeight) < 600) return 'phone';
    return 'desktop';
  }

  function resolveTheme(preference, systemDark) {
    if (preference === 'light' || preference === 'dark') return preference;
    return systemDark ? 'dark' : 'light';
  }

  function updateScreen(engine) {
    var label = engine.name === 'android-webview' ? 'Android System WebView' : engine.name === 'webkitgtk' ? 'WebKitGTK' : engine.name;
    var action =
      engine.name === 'android-webview'
        ? '<p><a href="market://details?id=com.google.android.webview" style="color:#155dfc">Open Android System WebView in the store</a></p>'
        : '<p>Update WebKitGTK with your system\'s package manager.</p>';
    return (
      '<div style="font-family:sans-serif;padding:32px 24px;padding-top:calc(32px + env(safe-area-inset-top, 0px));max-width:480px;line-height:1.5;color:#09090b;background:#fff">' +
      '<h1 style="font-size:22px;margin:0 0 12px">Please update ' + label + '</h1>' +
      '<p>This app needs ' + label + ' ' + minimumText(engine.name) + ' or newer. This device has version ' + engine.version + '.</p>' +
      action +
      '</div>'
    );
  }

  function readPreference(storage) {
    try {
      var p = storage.getItem(THEME_KEY);
      return p === 'light' || p === 'dark' ? p : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function boot(window) {
    var document = window.document;
    var html = document.documentElement;
    var native = window.__DK_NATIVE__ || null;
    var platform = native && native.platform ? native.platform : 'web';
    var debug = !!(native && native.debug);
    var engine = detectEngine(native, window.navigator.userAgent);
    if (debug) {
      try {
        var forced = window.localStorage.getItem(ENGINE_OVERRIDE_KEY);
        if (forced) engine = { name: engine.name === 'browser' ? 'android-webview' : engine.name, version: forced };
      } catch (e) {}
    }

    if (!engineSupported(engine)) {
      /* Stop loading, so the app bundle is never requested, and show why. */
      if (window.stop) window.stop();
      else if (document.execCommand) document.execCommand('Stop');
      html.innerHTML = '<head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">' + updateScreen(engine) + '</body>';
      window.__DK__ = { platform: platform, engine: engine, unsupported: true };
      return;
    }

    var media = window.matchMedia;
    var coarse = media ? media('(pointer: coarse)').matches : false;
    var dk = {
      platform: platform,
      engine: engine,
      formFactor: formFactor(platform, coarse, window.screen.width, window.screen.height),
      themePreference: readPreference(window.localStorage),
      theme: 'light',
      debug: debug,
      startRoute: debug && native && native.startRoute ? native.startRoute : null
    };
    window.__DK__ = dk;
    html.setAttribute('data-platform', platform);
    html.setAttribute('data-form-factor', dk.formFactor);

    var dark = media ? media('(prefers-color-scheme: dark)') : null;
    /* Announces a change of theme, or of preference (`force`), with a dk:theme event. */
    function applyTheme(force) {
      var theme = resolveTheme(dk.themePreference, dark ? dark.matches : false);
      var changed = force === true || theme !== dk.theme || !html.getAttribute('data-theme');
      dk.theme = theme;
      html.setAttribute('data-theme', theme);
      html.style.colorScheme = theme;
      if (changed && window.CustomEvent && window.dispatchEvent) window.dispatchEvent(new window.CustomEvent('dk:theme', { detail: theme }));
    }
    dk.setThemePreference = function (preference) {
      dk.themePreference = preference === 'light' || preference === 'dark' ? preference : 'system';
      try {
        if (dk.themePreference === 'system') window.localStorage.removeItem(THEME_KEY);
        else window.localStorage.setItem(THEME_KEY, dk.themePreference);
      } catch (e) {}
      applyTheme(true);
    };
    applyTheme();
    if (dark) {
      if (dark.addEventListener) dark.addEventListener('change', applyTheme);
      else if (dark.addListener) dark.addListener(applyTheme);
    }

    /* The app's module scripts were made inert by the droidKit() Vite plugin;
     * start them now, in document order, once the document is parsed. */
    function startApp() {
      var inert = document.querySelectorAll('script[type="dk/module"]');
      for (var i = 0; i < inert.length; i++) {
        var old = inert[i];
        var script = document.createElement('script');
        script.type = 'module';
        script.async = false;
        if (old.src) script.src = old.src;
        else script.text = old.text;
        if (old.crossOrigin !== null) script.crossOrigin = old.crossOrigin;
        old.parentNode.replaceChild(script, old);
      }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp);
    else startApp();

    /* The keyboard shrinks the visual viewport, not the layout viewport. */
    var vv = window.visualViewport;
    if (vv) {
      var updateKeyboard = function () {
        var covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        html.style.setProperty('--dk-keyboard', covered + 'px');
      };
      vv.addEventListener('resize', updateKeyboard);
      vv.addEventListener('scroll', updateKeyboard);
      updateKeyboard();
    }
  }

  return {
    boot: boot,
    parseVersion: parseVersion,
    compareVersion: compareVersion,
    detectEngine: detectEngine,
    engineSupported: engineSupported,
    formFactor: formFactor,
    resolveTheme: resolveTheme,
    MINIMUM: MINIMUM
  };
});
