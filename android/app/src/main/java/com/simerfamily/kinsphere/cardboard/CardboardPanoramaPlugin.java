package com.simerfamily.kinsphere.cardboard;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
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

/** Stages a WebView panorama and launches the optically calibrated native viewer. */
@CapacitorPlugin(name = "CardboardPanorama")
public final class CardboardPanoramaPlugin extends Plugin {

    // 48 MiB of base64 represents at most 36 MiB of compressed image data.
    // This keeps malformed calls from exhausting the process before decoding.
    static final int MAX_BASE64_CHARACTERS = 48 * 1024 * 1024;

    private final ExecutorService stagingExecutor = Executors.newSingleThreadExecutor();

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
        String title = call.getString("title", "Family moment");
        double initialYaw = finiteOrDefault(call.getDouble("initialYaw"), 0.0);
        double initialPitch = finiteOrDefault(call.getDouble("initialPitch"), 0.0);

        stagingExecutor.execute(() -> {
            File stagedFile = null;
            try {
                stagedFile = writePanorama(encodedImage, mimeType);
                File finalStagedFile = stagedFile;
                Activity activity = getActivity();
                if (!activityAvailable(activity)) {
                    deleteQuietly(finalStagedFile);
                    call.reject(
                        "The KinSphere app view is not available.",
                        "CARDBOARD_ACTIVITY_UNAVAILABLE"
                    );
                    return;
                }

                activity.runOnUiThread(() -> {
                    if (!activityAvailable(activity)) {
                        deleteQuietly(finalStagedFile);
                        call.reject(
                            "The KinSphere app view is not available.",
                            "CARDBOARD_ACTIVITY_UNAVAILABLE"
                        );
                        return;
                    }

                    try {
                        Intent intent = CardboardPanoramaActivity.createIntent(
                            activity,
                            finalStagedFile,
                            title,
                            (float) initialYaw,
                            (float) initialPitch
                        );
                        activity.startActivity(intent);
                        JSObject result = new JSObject();
                        result.put("launched", true);
                        call.resolve(result);
                    } catch (RuntimeException launchError) {
                        deleteQuietly(finalStagedFile);
                        call.reject(
                            "The native Cardboard viewer could not be opened.",
                            "CARDBOARD_LAUNCH_FAILED",
                            launchError
                        );
                    }
                });
            } catch (IllegalArgumentException decodeError) {
                deleteQuietly(stagedFile);
                call.reject(
                    "The panorama data is not valid base64.",
                    "PANORAMA_INVALID",
                    decodeError
                );
            } catch (IOException writeError) {
                deleteQuietly(stagedFile);
                call.reject(
                    "The panorama could not be prepared for VR.",
                    "PANORAMA_STAGE_FAILED",
                    writeError
                );
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        stagingExecutor.shutdownNow();
    }

    private File writePanorama(String encodedImage, String mimeType) throws IOException {
        byte[] bytes = Base64.decode(encodedImage, Base64.DEFAULT);
        if (bytes.length == 0) {
            throw new IllegalArgumentException("Decoded panorama is empty");
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

    static String extensionForMimeType(String mimeType) {
        String normalized = mimeType == null ? "" : mimeType.toLowerCase(Locale.ROOT);
        if (normalized.contains("png")) return ".png";
        if (normalized.contains("webp")) return ".webp";
        return ".jpg";
    }

    static double finiteOrDefault(Double value, double fallback) {
        return value != null && Double.isFinite(value) ? value : fallback;
    }

    private static boolean activityAvailable(Activity activity) {
        return activity != null &&
            !activity.isFinishing() &&
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.JELLY_BEAN_MR1 || !activity.isDestroyed());
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            // A failed deletion is harmless; Android will eventually clear its cache directory.
            file.delete();
        }
    }
}
