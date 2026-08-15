package com.junkyardolympics.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var reconnectOverlay: View
    private lateinit var reconnectMessage: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val retryPolicy = RetryPolicy()
    private var mainFrameFailed = false
    private var lastBackPressedAt = 0L

    private val retryLoad = Runnable {
        showReconnect(getString(R.string.reconnecting))
        webView.loadUrl(BuildConfig.KIOSK_URL)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        immersive()
        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.web_view)
        reconnectOverlay = findViewById(R.id.reconnect_overlay)
        reconnectMessage = findViewById(R.id.reconnect_message)
        configureWebView()
        showReconnect(getString(R.string.connecting))
        webView.loadUrl(BuildConfig.KIOSK_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.setBackgroundColor(Color.BLACK)
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.webChromeClient = WebChromeClient()
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return !isApprovedUrl(request.url)
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                mainFrameFailed = false
                super.onPageStarted(view, url, favicon)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) scheduleRetry()
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse
            ) {
                if (request.isForMainFrame && errorResponse.statusCode >= 400) scheduleRetry()
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!mainFrameFailed && isApprovedUrl(Uri.parse(url))) {
                    handler.removeCallbacks(retryLoad)
                    retryPolicy.reset()
                    reconnectOverlay.visibility = View.GONE
                }
                super.onPageFinished(view, url)
            }
        }
    }

    private fun isApprovedUrl(uri: Uri): Boolean =
        uri.scheme == "http" && uri.host == "192.168.1.101" && uri.port == 8791 && uri.path == "/tv.html"

    private fun scheduleRetry() {
        if (mainFrameFailed) return
        mainFrameFailed = true
        handler.removeCallbacks(retryLoad)
        val delay = retryPolicy.nextDelayMillis()
        showReconnect(getString(R.string.retrying_in_seconds, delay / 1_000L))
        handler.postDelayed(retryLoad, delay)
    }

    private fun showReconnect(message: String) {
        reconnectMessage.text = message
        reconnectOverlay.visibility = View.VISIBLE
    }

    private fun reloadNow() {
        handler.removeCallbacks(retryLoad)
        retryPolicy.reset()
        showReconnect(getString(R.string.reconnecting))
        webView.loadUrl(BuildConfig.KIOSK_URL)
    }

    private fun stepRemotePanel(method: String) {
        val script = "(window.JunkyardTV && typeof window.JunkyardTV.$method === 'function') ? window.JunkyardTV.$method() : false"
        webView.evaluateJavascript(script) { handled ->
            if (handled != "true") reloadNow()
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_DPAD_LEFT -> true
            else -> super.onKeyDown(keyCode, event)
        }
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER -> {
                stepRemotePanel("nextPanel")
                return true
            }
            KeyEvent.KEYCODE_DPAD_LEFT -> {
                stepRemotePanel("previousPanel")
                return true
            }
        }
        return super.onKeyUp(keyCode, event)
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        val now = System.currentTimeMillis()
        if (now - lastBackPressedAt <= BACK_EXIT_WINDOW_MS) {
            super.onBackPressed()
        } else {
            lastBackPressedAt = now
            Toast.makeText(this, "Press BACK again to exit", Toast.LENGTH_SHORT).show()
        }
    }

    private fun immersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        webView.stopLoading()
        webView.loadUrl("about:blank")
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val BACK_EXIT_WINDOW_MS = 2_000L
    }
}
