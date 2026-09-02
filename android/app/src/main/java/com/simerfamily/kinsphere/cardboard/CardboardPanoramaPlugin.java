package com.simerfamily.kinsphere.cardboard;

import android.app.Activity;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Stages a WebView panorama and launches the optically calibrated native viewer. */
@CapacitorPlugin(name = "CardboardPanorama")
public final class CardboardPanoramaPlugin extends Plugin {

    // 48 MiB of base64 represents at most 36 MiB of compressed image data.
    // This keeps malformed calls from exhausting the process before decoding.
    static final int MAX_BASE64_CHARACTERS = 48 * 1024 * 1024;

    private final ExecutorService stagingExecutor = Executors.newSingleThreadExecutor(
        task -> new Thread(task, "bubble-cardboard-panorama")
    );

    /** Stages one validated panorama and opens it in the native Cardboard viewer. */
    @PluginMethod
    public void open(PluginCall call) {
        String encodedImage = call.getString("dataBase64");
        if (encodedImage == null || encodedImage.isEmpty()) {
            call.reject("The panorama image is missing.", "PANORAMA_MISSING");
            return;
        }
        if (encodedImage.length() > MAX_BASE64_CHARACTERS) {
            call.reject(
                "This panorama is too large for the native VR handoff.",
                "PANORAMA_TOO_LARGE"
            );
            return;
        }

        String mimeType = call.getString("mimeType", "image/jpeg");
        double initialYaw = finiteOrDefault(call.getDouble("initialYaw"), 0.0);
        double initialPitch = finiteOrDefault(call.getDouble("initialPitch"), 0.0);

        try {
            stagingExecutor.execute(
                () -> stageAndLaunch(call, encodedImage, mimeType, initialYaw, initialPitch)
            );
        } catch (RejectedExecutionException error) {
            call.reject(
                "The panorama could not be prepared for VR.",
                "PANORAMA_STAGE_FAILED",
                error
            );
        }
    }

    /** Interrupts staging work when Capacitor destroys this plugin instance. */
    @Override
    protected void handleOnDestroy() {
        stagingExecutor.shutdownNow();
    }

    /** Performs bounded image validation off the UI thread, then schedules the viewer launch. */
    private void stageAndLaunch(
        PluginCall call,
        String encodedImage,
        String mimeType,
        double initialYaw,
        double initialPitch
    ) {
        File stagedFile = null;
        try {
            stagedFile = writePanorama(encodedImage, mimeType);
            Activity activity = getActivity();
            if (!activityAvailable(activity)) {
                deleteQuietly(stagedFile);
                call.reject(
                    "The Bubble app view is not available.",
                    "CARDBOARD_ACTIVITY_UNAVAILABLE"
                );
                return;
            }

            File panoramaFile = stagedFile;
            activity.runOnUiThread(
                () -> launchViewer(call, activity, panoramaFile, initialYaw, initialPitch)
            );
        } catch (IllegalArgumentException decodeError) {
            deleteQuietly(stagedFile);
            call.reject(
                "The panorama data is not a valid image.",
                "PANORAMA_INVALID",
                decodeError
            );
        } catch (OutOfMemoryError memoryError) {
            deleteQuietly(stagedFile);
            call.reject(
                "This panorama is too large for the native VR handoff.",
                "PANORAMA_TOO_LARGE",
                new RuntimeException(memoryError)
            );
        } catch (IOException writeError) {
            deleteQuietly(stagedFile);
            call.reject(
                "The panorama could not be prepared for VR.",
                "PANORAMA_STAGE_FAILED",
                writeError
            );
        } catch (RuntimeException stagingError) {
            deleteQuietly(stagedFile);
            call.reject(
                "The panorama could not be prepared for VR.",
                "PANORAMA_STAGE_FAILED",
                stagingError
            );
        }
    }

    /** Starts the viewer only while the original host Activity can still present UI. */
    private static void launchViewer(
        PluginCall call,
        Activity activity,
        File panoramaFile,
        double initialYaw,
        double initialPitch
    ) {
        if (!activityAvailable(activity)) {
            deleteQuietly(panoramaFile);
            call.reject(
                "The Bubble app view is not available.",
                "CARDBOARD_ACTIVITY_UNAVAILABLE"
            );
            return;
        }

        try {
            Intent intent = CardboardPanoramaActivity.createIntent(
                activity,
                panoramaFile,
                (float) initialYaw,
                (float) initialPitch
            );
            activity.startActivity(intent);
            JSObject result = new JSObject();
            result.put("launched", true);
            call.resolve(result);
        } catch (RuntimeException launchError) {
            deleteQuietly(panoramaFile);
            call.reject(
                "The native Cardboard viewer could not be opened.",
                "CARDBOARD_LAUNCH_FAILED",
                launchError
            );
        }
    }

    /** Decodes, verifies, and writes one short-lived panorama into the private cache. */
    private File writePanorama(String encodedImage, String mimeType) throws IOException {
        byte[] bytes = Base64.decode(encodedImage, Base64.DEFAULT);
        if (bytes.length == 0) {
            throw new IllegalArgumentException("Decoded panorama is empty");
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IllegalArgumentException("Decoded panorama is not an image");
        }
        if (Thread.currentThread().isInterrupted()) {
            throw new IOException("Panorama staging was cancelled");
        }

        File directory = new File(getContext().getCacheDir(), "cardboard-panoramas");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Unable to create Cardboard cache directory");
        }

        File destination = new File(
            directory,
            "panorama-" + UUID.randomUUID() + extensionForMimeType(mimeType)
        );
        try (FileOutputStream output = new FileOutputStream(destination)) {
            output.write(bytes);
            output.flush();
        } catch (IOException error) {
            deleteQuietly(destination);
            throw error;
        }
        return destination;
    }

    /** Chooses a cache-file suffix from the validated MIME hint, defaulting to JPEG. */
    static String extensionForMimeType(String mimeType) {
        String normalized = mimeType == null ? "" : mimeType.toLowerCase(Locale.ROOT);
        if (normalized.contains("png")) {
            return ".png";
        }
        if (normalized.contains("webp")) {
            return ".webp";
        }
        return ".jpg";
    }

    /** Substitutes a stable bridge default for missing, NaN, or infinite numbers. */
    static double finiteOrDefault(Double value, double fallback) {
        return value != null && Double.isFinite(value) ? value : fallback;
    }

    /** Rejects an Activity whose window can no longer launch the viewer. */
    private static boolean activityAvailable(Activity activity) {
        return activity != null &&
            !activity.isFinishing() &&
            !activity.isDestroyed();
    }

    /** Removes an abandoned cache file without masking the primary bridge error. */
    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            // A failed deletion is harmless; Android will eventually clear its cache directory.
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }
}
