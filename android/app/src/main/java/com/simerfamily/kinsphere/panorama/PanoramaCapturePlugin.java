package com.simerfamily.kinsphere.panorama;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.UUID;
import org.json.JSONException;

/**
 * Capacitor bridge for the native, guided source-frame panorama capture flow.
 *
 * <p>This plugin deliberately returns synchronized source frames, camera pose,
 * and intrinsics. The shared web layer assembles those frames into a panorama.</p>
 */
@CapacitorPlugin(
    name = "PanoramaCapture",
    permissions = { @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) }
)
public final class PanoramaCapturePlugin extends Plugin {

    private static final String CALLBACK_CAPTURE = "captureFinished";
    private static final String CALLBACK_PERMISSION = "cameraPermissionResult";
    private boolean captureInProgress;

    /** Requests permission if needed, then opens one native guided capture session. */
    @PluginMethod
    public void startCapture(PluginCall call) {
        if (captureInProgress) {
            call.reject("A panorama capture is already in progress.", "CAPTURE_IN_PROGRESS");
            return;
        }
        // Reserve the single capture slot before asking for permission so two
        // rapid bridge calls cannot open two activities from separate callbacks.
        captureInProgress = true;

        if (getPermissionState("camera") != PermissionState.GRANTED) {
            try {
                requestPermissionForAlias("camera", call, CALLBACK_PERMISSION);
            } catch (RuntimeException error) {
                captureInProgress = false;
                call.reject(
                    "Camera permission could not be requested.",
                    "PERMISSION_REQUEST_FAILED",
                    error
                );
            }
            return;
        }

        launchCapture(call);
    }

    /** Deletes one UUID-named capture session from the app's private cache. */
    @PluginMethod
    public void discardCapture(PluginCall call) {
        if (captureInProgress) {
            call.reject("A panorama capture is still in progress.", "CAPTURE_IN_PROGRESS");
            return;
        }

        String directoryUrl = call.getString("directoryUrl");
        if (directoryUrl == null || directoryUrl.trim().isEmpty()) {
            call.reject("directoryUrl is required.", "INVALID_DIRECTORY");
            return;
        }

        try {
            Uri uri = Uri.parse(directoryUrl);
            if (uri.getScheme() != null && !"file".equalsIgnoreCase(uri.getScheme())) {
                call.reject("Only a file:// panorama session URL can be discarded.", "INVALID_DIRECTORY");
                return;
            }
            String candidatePath = uri.getScheme() == null ? directoryUrl : uri.getPath();
            if (candidatePath == null) {
                call.reject("The panorama session URL has no filesystem path.", "INVALID_DIRECTORY");
                return;
            }

            File root = new File(getContext().getCacheDir(), "panorama_captures").getCanonicalFile();
            File candidate = new File(candidatePath).getCanonicalFile();
            // Sessions are created as direct UUID-named children. Requiring that
            // exact shape is stricter than a prefix check and rejects traversal.
            if (candidate.equals(root) || !root.equals(candidate.getParentFile())) {
                call.reject("The directory is not an app-owned panorama session.", "INVALID_DIRECTORY");
                return;
            }
            try {
                UUID.fromString(candidate.getName());
            } catch (IllegalArgumentException exception) {
                call.reject("The panorama session directory name is invalid.", "INVALID_DIRECTORY");
                return;
            }

            boolean existed = candidate.exists();
            if (existed && !deleteSessionTree(candidate, candidate)) {
                call.reject("The panorama session could not be completely discarded.", "DISCARD_FAILED");
                return;
            }

            JSObject result = new JSObject();
            result.put("discarded", existed);
            call.resolve(result);
        } catch (IOException exception) {
            call.reject("The panorama session path could not be validated.", "INVALID_DIRECTORY", exception);
        }
    }

    /** Deletes one validated session tree without traversing symbolic links. */
    private static boolean deleteSessionTree(File sessionRoot, File entry) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Files.isSymbolicLink(entry.toPath())) {
            return entry.delete();
        }
        File canonicalEntry = entry.getCanonicalFile();
        if (!canonicalEntry.equals(entry.getAbsoluteFile())) {
            // API 24-25 fallback: a directory entry whose canonical target is a
            // different path is a link. Delete the link itself without walking it.
            return !entry.exists() || entry.delete();
        }
        String rootPrefix = sessionRoot.getCanonicalPath() + File.separator;
        if (!canonicalEntry.equals(sessionRoot) && !canonicalEntry.getCanonicalPath().startsWith(rootPrefix)) {
            // A symlink that resolves outside the session is deleted as a link,
            // never traversed into the external target.
            return !entry.exists() || entry.delete();
        }
        if (entry.isDirectory()) {
            File[] children = entry.listFiles();
            if (children == null) {
                return false;
            }
            for (File child : children) {
                if (!deleteSessionTree(sessionRoot, child)) {
                    return false;
                }
            }
        }
        return !entry.exists() || entry.delete();
    }

    /** Continues the reserved capture request only after camera permission is granted. */
    @PermissionCallback
    private void cameraPermissionResult(PluginCall call) {
        if (call == null) {
            captureInProgress = false;
            return;
        }

        if (getPermissionState("camera") != PermissionState.GRANTED) {
            captureInProgress = false;
            call.reject("Camera permission is required for panorama capture.", "PERMISSION_DENIED");
            return;
        }

        launchCapture(call);
    }

    /** Transfers validated bridge options into a single native capture Activity. */
    private void launchCapture(PluginCall call) {
        try {
            Intent captureIntent = new Intent(getContext(), PanoramaCaptureActivity.class);
            captureIntent.putExtra(
                PanoramaCaptureActivity.EXTRA_OPTIONS_JSON,
                call.getData().toString()
            );
            startActivityForResult(call, captureIntent, CALLBACK_CAPTURE);
        } catch (RuntimeException error) {
            captureInProgress = false;
            call.reject(
                "The panorama capture screen could not be opened.",
                "CAPTURE_FAILED",
                error
            );
        }
    }

    /** Resolves one native result and always releases the plugin's capture slot. */
    @ActivityCallback
    private void captureFinished(PluginCall call, ActivityResult activityResult) {
        captureInProgress = false;
        if (call == null) {
            return;
        }

        Intent data = activityResult.getData();
        if (activityResult.getResultCode() != Activity.RESULT_OK || data == null) {
            String code = data == null
                ? "CAPTURE_CANCELLED"
                : data.getStringExtra(PanoramaCaptureActivity.EXTRA_ERROR_CODE);
            String message = data == null
                ? "Panorama capture was cancelled."
                : data.getStringExtra(PanoramaCaptureActivity.EXTRA_ERROR_MESSAGE);
            call.reject(
                message == null ? "Panorama capture was cancelled." : message,
                code == null ? "CAPTURE_CANCELLED" : code
            );
            return;
        }

        String resultJson = data.getStringExtra(PanoramaCaptureActivity.EXTRA_RESULT_JSON);
        if (resultJson == null) {
            call.reject("The native capture returned no result metadata.", "CAPTURE_FAILED");
            return;
        }

        try {
            call.resolve(new JSObject(resultJson));
        } catch (JSONException exception) {
            call.reject("The native capture returned invalid result metadata.", "CAPTURE_FAILED", exception);
        }
    }
}
