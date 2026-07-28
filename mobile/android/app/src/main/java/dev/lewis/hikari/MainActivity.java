package dev.lewis.hikari;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Adds an ACTION_SEND share target so a screenshot can be sent straight from
 * YouTube (or any app) into Hikari's identify flow.
 *
 * The image is read here and handed to the web layer as a data: URL via a
 * window event. That avoids a file-access plugin and any storage permission —
 * the receiving Intent already grants read access to this one URI, and the
 * grant does not outlive the activity, so copying the bytes out immediately is
 * the reliable move.
 */
public class MainActivity extends BridgeActivity {

    /** guard against the WebView not being ready when a cold-start share arrives */
    private String pending = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShare(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (pending != null) flush();
    }

    private void handleShare(Intent intent) {
        if (intent == null) return;
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("image/")) return;

        Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return;

        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            int total = 0;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > 25 * 1024 * 1024) return;   // matches the JS-side cap
                out.write(buf, 0, n);
            }
            String mime = type.equals("image/*") ? "image/jpeg" : type;
            pending = "data:" + mime + ";base64,"
                + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            flush();
        } catch (Exception ignored) {
            // a share we cannot read is not worth crashing over
        }
    }

    /** hand the image to the web layer; retried on resume if it isn't up yet */
    private void flush() {
        if (pending == null || getBridge() == null) return;
        final WebView web = getBridge().getWebView();
        if (web == null) return;
        final String payload = pending;
        web.post(() -> web.evaluateJavascript(
            "window.__hikariShared && window.__hikariShared("
                + org.json.JSONObject.quote(payload) + ")", null));
        pending = null;
    }
}
