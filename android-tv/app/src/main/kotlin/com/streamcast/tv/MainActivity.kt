package com.streamcast.tv

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var errorView: TextView
    
    // IMPORTANT: Replace this URL with your final Vercel deployment URL
    private val TV_URL = "https://stream-cast-tv.vercel.app/tv"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Build layout: WebView + error message overlay
        val container = FrameLayout(this)

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        errorView = TextView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            textSize = 20f
            setTextColor(0xFFCCCCCC.toInt())
            gravity = android.view.Gravity.CENTER
            visibility = android.view.View.GONE
            setPadding(48, 48, 48, 48)
        }

        container.addView(webView)
        container.addView(errorView)
        setContentView(container)

        // ── WebView settings ───────────────────────────────────────────────────
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // for localStorage (Supabase client needs this)
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
            // Allow mixed content (HTTP API calls from HTTPS Vercel page)
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        // Enable WebView debugging (remove for production if desired)
        WebView.setWebContentsDebuggingEnabled(false)

        // ── Custom URL scheme interceptor ──────────────────────────────────────
        // This is the KEY part: intercepts app URL schemes that the Sony browser blocks,
        // and launches the correct Android app via native Intent.
        webView.webViewClient = object : WebViewClient() {

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false

                return when {
                    // MX Player native scheme: mxplayer:video?url=ENCODED_URL
                    url.startsWith("mxplayer:") -> {
                        launchAppIntent(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    }

                    // VLC native scheme: vlc://FULL_URL
                    url.startsWith("vlc:") -> {
                        launchAppIntent(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    }

                    // Chrome-style intent:// format (works with any app that handles VIEW)
                    url.startsWith("intent:") -> {
                        try {
                            val intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
                            launchAppIntent(intent)
                        } catch (e: Exception) {
                            false
                        }
                    }

                    // Standard http/https — let the WebView load it
                    else -> false
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                // Only show error for the main frame (not sub-resources)
                if (request?.isForMainFrame == true) {
                    errorView.visibility = android.view.View.VISIBLE
                    errorView.text = "⚠️ Cannot load StreamCast TV\n\n" +
                            "Make sure your device is connected to the internet.\n\n" +
                            "URL: $TV_URL\n\n" +
                            "Press BACK to retry."
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                errorView.visibility = android.view.View.GONE
            }
        }

        // Load the TV page
        webView.loadUrl(TV_URL)
    }

    // ── Helper: launch an Android intent, catch "app not installed" gracefully ──
    private fun launchAppIntent(intent: Intent): Boolean {
        return try {
            startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            // App not installed — try to open Play Store for the package
            val pkg = intent.`package`
            if (pkg != null) {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg")))
                } catch (e2: Exception) {
                    // Play Store not available
                }
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    // ── D-pad / TV remote: Back button navigates WebView history ──────────────
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            // Reload the page instead of exiting (keeps the app always visible on TV)
            webView.reload()
        }
    }

    // ── TV remote: make sure D-pad navigation works in WebView ────────────────
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                    // Let WebView handle Enter/Select
                    return webView.dispatchKeyEvent(event)
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        super.onDestroy()
        webView.destroy()
    }
}
