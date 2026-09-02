package com.simerfamily.kinsphere.capsule;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/** Android implementation of the constrained native Capsule recap bridge. */
@CapacitorPlugin(name = "CapsuleRecap")
public final class CapsuleRecapPlugin extends Plugin {

    private static final String SHARE_CALLBACK = "shareFinished";

    private final ExecutorService workQueue = Executors.newSingleThreadExecutor(
        task -> new Thread(task, "bubble-capsule-recap")
    );
    private final AtomicBoolean renderInProgress = new AtomicBoolean();
    private final AtomicBoolean shareInProgress = new AtomicBoolean();
    private PendingIntent shareResultCallback;
    private String activeShareToken;

    /** Decodes and normalizes one bridge image into the private staging cache. */
    @PluginMethod
    public void stageImage(PluginCall call) {
        String dataUrl = call.getString("dataUrl");
        if (dataUrl == null) {
            call.reject(
                "Choose a valid image for the capsule recap.",
                "INVALID_IMAGE_DATA"
            );
            return;
        }
        if (dataUrl.length() > CapsuleRecapContract.MAXIMUM_DATA_URL_CHARACTERS) {
            call.reject(
                "This image is too large to prepare safely on this device.",
                "IMAGE_STAGING_FAILED"
            );
            return;
        }

        try {
            workQueue.execute(() -> {
                try {
                    CapsuleRecapFiles recapFiles = recapFiles();
                    File stagedImage = new CapsuleRecapImageStager(recapFiles).stage(dataUrl);
                    JSObject result = new JSObject();
                    result.put("path", recapFiles.bridgeUri(stagedImage));
                    call.resolve(result);
                } catch (IOException | RuntimeException exception) {
                    call.reject(
                        messageOrFallback(exception, "The capsule image could not be prepared."),
                        "IMAGE_STAGING_FAILED",
                        exception
                    );
                }
            });
        } catch (RejectedExecutionException exception) {
            call.reject("The capsule image could not be prepared.", "IMAGE_STAGING_FAILED", exception);
        }
    }

    /** Encodes ordered staged images into the fixed cross-platform recap format. */
    @PluginMethod
    public void renderRecap(PluginCall call) {
        final List<String> imagePaths;
        try {
            imagePaths = stringArray(call.getArray("imagePaths"));
        } catch (IllegalArgumentException exception) {
            call.reject(
                "Add between one and 150 staged images to create a recap.",
                "INVALID_IMAGE_PATHS",
                exception
            );
            return;
        }
        if (
            imagePaths.isEmpty() ||
            imagePaths.size() > CapsuleRecapContract.MAXIMUM_IMAGE_COUNT
        ) {
            call.reject(
                "Add between one and 150 staged images to create a recap.",
                "INVALID_IMAGE_PATHS"
            );
            return;
        }
        if (!renderInProgress.compareAndSet(false, true)) {
            call.reject(
                "A capsule recap is already being created.",
                "RENDER_IN_PROGRESS"
            );
            return;
        }

        try {
            workQueue.execute(() -> {
                List<File> stagedImages = new ArrayList<>();
                try {
                    CapsuleRecapFiles recapFiles = recapFiles();
                    for (String imagePath : imagePaths) {
                        stagedImages.add(recapFiles.validateStagedImage(imagePath));
                    }
                    File recapVideo = recapFiles.createRecapFile();
                    new CapsuleRecapVideoRenderer().render(stagedImages, recapVideo);

                    JSObject result = new JSObject();
                    result.put("fileUri", recapFiles.bridgeUri(recapVideo));
                    result.put("width", CapsuleRecapContract.WIDTH);
                    result.put("height", CapsuleRecapContract.HEIGHT);
                    result.put("frameRate", CapsuleRecapContract.FRAME_RATE);
                    result.put("framesPerImage", CapsuleRecapContract.FRAMES_PER_IMAGE);
                    result.put(
                        "durationMs",
                        CapsuleRecapContract.durationMilliseconds(stagedImages.size())
                    );
                    result.put("imageCount", stagedImages.size());
                    call.resolve(result);
                } catch (IOException | RuntimeException exception) {
                    call.reject(
                        messageOrFallback(
                            exception,
                            "The capsule recap video could not be created."
                        ),
                        "RECAP_RENDER_FAILED",
                        exception
                    );
                } finally {
                    // Like iOS, rendering consumes every successfully validated staged input.
                    for (File stagedImage : new HashSet<>(stagedImages)) {
                        //noinspection ResultOfMethodCallIgnored -- best-effort private cache cleanup.
                        stagedImage.delete();
                    }
                    renderInProgress.set(false);
                }
            });
        } catch (RejectedExecutionException exception) {
            renderInProgress.set(false);
            call.reject(
                "The capsule recap video could not be created.",
                "RECAP_RENDER_FAILED",
                exception
            );
        }
    }

    /** Opens Android's chooser with read access to one validated recap video. */
    @PluginMethod
    public void shareRecap(PluginCall call) {
        String fileUri = call.getString("fileUri");
        if (fileUri == null || fileUri.trim().isEmpty()) {
            call.reject(
                "The capsule recap video is no longer available.",
                "INVALID_RECAP_FILE"
            );
            return;
        }
        if (!shareInProgress.compareAndSet(false, true)) {
            call.reject("The share sheet is already open.", "SHARE_IN_PROGRESS");
            return;
        }

        Activity activity = getActivity();
        if (!activityAvailable(activity)) {
            shareInProgress.set(false);
            call.reject("The share sheet could not be presented.", "PRESENTATION_FAILED");
            return;
        }

        activity.runOnUiThread(() -> {
            if (!activityAvailable(activity)) {
                shareInProgress.set(false);
                call.reject("The share sheet could not be presented.", "PRESENTATION_FAILED");
                return;
            }
            Uri grantedUri = null;
            try {
                abandonShareSelection();
                CapsuleRecapFiles recapFiles = recapFiles();
                File recapVideo = recapFiles.validateRecap(fileUri);
                Context context = getContext();
                Uri contentUri = FileProvider.getUriForFile(
                    context,
                    context.getPackageName() + ".fileprovider",
                    recapVideo
                );
                grantedUri = contentUri;
                Intent sendIntent = new Intent(Intent.ACTION_SEND);
                sendIntent.setType("video/mp4");
                sendIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
                sendIntent.setClipData(ClipData.newUri(
                    context.getContentResolver(),
                    "Bubble Capsule recap",
                    contentUri
                ));
                sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                String shareToken = UUID.randomUUID().toString();
                Intent shareResultIntent = new Intent(
                    context,
                    CapsuleShareTargetReceiver.class
                ).putExtra(CapsuleShareTargetReceiver.EXTRA_SHARE_TOKEN, shareToken);
                int pendingIntentFlags = PendingIntent.FLAG_CANCEL_CURRENT |
                    PendingIntent.FLAG_ONE_SHOT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // The chooser must append its result, so mutability is
                    // required; the explicit non-exported receiver limits scope.
                    pendingIntentFlags |= PendingIntent.FLAG_MUTABLE;
                }
                CapsuleShareTargetReceiver.prepareSelection(shareToken);
                activeShareToken = shareToken;
                shareResultCallback = PendingIntent.getBroadcast(
                    context,
                    shareToken.hashCode(),
                    shareResultIntent,
                    pendingIntentFlags
                );
                Intent chooserIntent = Intent.createChooser(
                    sendIntent,
                    "Save or share family recap",
                    shareResultCallback.getIntentSender()
                );
                chooserIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivityForResult(call, chooserIntent, SHARE_CALLBACK);
            } catch (ActivityNotFoundException exception) {
                abandonShareSelection();
                revokeSharePermission(grantedUri);
                shareInProgress.set(false);
                call.reject(
                    "No app is available to save or share this capsule recap.",
                    "PRESENTATION_FAILED",
                    exception
                );
            } catch (IOException | IllegalArgumentException exception) {
                abandonShareSelection();
                revokeSharePermission(grantedUri);
                shareInProgress.set(false);
                call.reject(
                    messageOrFallback(
                        exception,
                        "The capsule recap video is no longer available."
                    ),
                    "INVALID_RECAP_FILE",
                    exception
                );
            } catch (RuntimeException exception) {
                abandonShareSelection();
                revokeSharePermission(grantedUri);
                shareInProgress.set(false);
                call.reject(
                    "The share sheet could not be presented.",
                    "PRESENTATION_FAILED",
                    exception
                );
            }
        });
    }

    /** Resolves one chooser result, revokes access, and consumes its temporary file. */
    @ActivityCallback
    private void shareFinished(PluginCall call, ActivityResult ignoredResult) {
        shareInProgress.set(false);
        // Chooser Activity result codes describe dismissal, not selection; the
        // system's IntentSender callback is the authoritative completion signal.
        CapsuleShareTargetReceiver.Selection selection = consumeShareSelection();
        if (call == null) {
            return;
        }

        String fileUri = call.getString("fileUri");
        try {
            CapsuleRecapFiles recapFiles = recapFiles();
            File recapVideo = recapFiles.validateRecap(fileUri);
            Uri contentUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                recapVideo
            );
            getContext().revokeUriPermission(
                contentUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
            //noinspection ResultOfMethodCallIgnored -- sharing consumes the temporary recap.
            recapVideo.delete();
        } catch (IOException | RuntimeException ignored) {
            // The TypeScript finally path also retries constrained cleanup.
        }

        JSObject result = new JSObject();
        result.put("completed", selection != null);
        if (selection != null && selection.activityType != null) {
            result.put("activityType", selection.activityType);
        }
        call.resolve(result);
    }

    /** Removes only UUID-named artifacts from the two private recap caches. */
    @PluginMethod
    public void discardArtifacts(PluginCall call) {
        final List<String> fileUris;
        try {
            fileUris = stringArray(call.getArray("fileUris"));
        } catch (IllegalArgumentException exception) {
            call.reject(
                "The capsule recap cleanup request is invalid.",
                "INVALID_ARTIFACTS",
                exception
            );
            return;
        }
        if (fileUris.size() > CapsuleRecapContract.MAXIMUM_IMAGE_COUNT + 1) {
            call.reject(
                "The capsule recap cleanup request is invalid.",
                "INVALID_ARTIFACTS"
            );
            return;
        }

        try {
            workQueue.execute(() -> {
                int removedCount = 0;
                try {
                    CapsuleRecapFiles recapFiles = recapFiles();
                    Set<String> uniqueUris = new HashSet<>(fileUris);
                    for (String fileUri : uniqueUris) {
                        File artifact = recapFiles.removableArtifact(fileUri);
                        if (artifact != null && artifact.isFile() && artifact.delete()) {
                            removedCount += 1;
                        }
                    }
                } catch (IOException | RuntimeException ignored) {
                    // Cleanup is best effort and can be retried safely.
                }
                JSObject result = new JSObject();
                result.put("removedCount", removedCount);
                call.resolve(result);
            });
        } catch (RejectedExecutionException exception) {
            JSObject result = new JSObject();
            result.put("removedCount", 0);
            call.resolve(result);
        }
    }

    /** Cancels background work and releases chooser state when Capacitor tears down. */
    @Override
    protected void handleOnDestroy() {
        abandonShareSelection();
        workQueue.shutdownNow();
        renderInProgress.set(false);
        shareInProgress.set(false);
    }

    /** Creates a path validator rooted at this app's private cache directory. */
    private CapsuleRecapFiles recapFiles() throws IOException {
        return new CapsuleRecapFiles(getContext().getCacheDir());
    }

    /** Revokes a temporary URI grant without turning cleanup into a user failure. */
    private void revokeSharePermission(Uri contentUri) {
        if (contentUri == null) {
            return;
        }
        try {
            getContext().revokeUriPermission(
                contentUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (RuntimeException ignored) {
            // Grants also expire with the receiving task or app process.
        }
    }

    /** Consumes the active chooser token and cancels its one-shot PendingIntent. */
    private CapsuleShareTargetReceiver.Selection consumeShareSelection() {
        String shareToken = activeShareToken;
        activeShareToken = null;
        if (shareResultCallback != null) {
            shareResultCallback.cancel();
            shareResultCallback = null;
        }
        return CapsuleShareTargetReceiver.consumeSelection(shareToken);
    }

    /** Clears chooser state after cancellation, failure, or plugin teardown. */
    private void abandonShareSelection() {
        String shareToken = activeShareToken;
        activeShareToken = null;
        if (shareResultCallback != null) {
            shareResultCallback.cancel();
            shareResultCallback = null;
        }
        CapsuleShareTargetReceiver.clearSelection(shareToken);
    }

    /** Rejects Activities that can no longer present Android UI safely. */
    private static boolean activityAvailable(Activity activity) {
        return activity != null && !activity.isFinishing() && !activity.isDestroyed();
    }

    /** Converts an untrusted bridge array only when every member is a string. */
    private static List<String> stringArray(JSArray values) {
        if (values == null) {
            throw new IllegalArgumentException("A string array is required.");
        }
        List<String> result = new ArrayList<>(values.length());
        for (int index = 0; index < values.length(); index++) {
            Object value = values.opt(index);
            if (!(value instanceof String)) {
                throw new IllegalArgumentException("Every array item must be a string.");
            }
            result.add((String) value);
        }
        return result;
    }

    /** Returns a non-empty operation detail, falling back when the exception has none. */
    private static String messageOrFallback(Exception exception, String fallback) {
        String message = exception.getMessage();
        return message == null || message.trim().isEmpty() ? fallback : message;
    }
}
