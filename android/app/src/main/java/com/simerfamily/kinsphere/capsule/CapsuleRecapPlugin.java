package com.simerfamily.kinsphere.capsule;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/** Android implementation of the constrained native Capsule recap bridge. */
@CapacitorPlugin(name = "CapsuleRecap")
public final class CapsuleRecapPlugin extends Plugin {

    private static final String SHARE_CALLBACK = "shareFinished";

    private final ExecutorService workQueue = Executors.newSingleThreadExecutor((task) -> {
        Thread thread = new Thread(task, "kinsphere-capsule-recap");
        thread.setPriority(Thread.NORM_PRIORITY + 1);
        return thread;
    });
    private final AtomicBoolean renderInProgress = new AtomicBoolean(false);
    private final AtomicBoolean shareInProgress = new AtomicBoolean(false);

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

        try {
            workQueue.submit(() -> {
                try {
                    CapsuleRecapFiles files = files();
                    File staged = new CapsuleRecapImageStager(files).stage(dataUrl);
                    JSObject result = new JSObject();
                    result.put("path", files.bridgeUri(staged));
                    call.resolve(result);
                } catch (IOException exception) {
                    call.reject(exception.getMessage(), "IMAGE_STAGING_FAILED", exception);
                }
            });
        } catch (RejectedExecutionException exception) {
            call.reject("The capsule image could not be prepared.", "IMAGE_STAGING_FAILED", exception);
        }
    }

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
            workQueue.submit(() -> {
                List<File> stagedImages = new ArrayList<>();
                try {
                    CapsuleRecapFiles files = files();
                    for (String imagePath : imagePaths) {
                        stagedImages.add(files.validateStagedImage(imagePath));
                    }
                    File output = files.createRecapFile();
                    new CapsuleRecapVideoRenderer().render(stagedImages, output);

                    JSObject result = new JSObject();
                    result.put("fileUri", files.bridgeUri(output));
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
        if (activity == null) {
            shareInProgress.set(false);
            call.reject("The share sheet could not be presented.", "PRESENTATION_FAILED");
            return;
        }

        activity.runOnUiThread(() -> {
            Uri grantedUri = null;
            try {
                CapsuleRecapFiles files = files();
                File recap = files.validateRecap(fileUri);
                Context context = getContext();
                Uri contentUri = FileProvider.getUriForFile(
                    context,
                    context.getPackageName() + ".fileprovider",
                    recap
                );
                grantedUri = contentUri;
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("video/mp4");
                send.putExtra(Intent.EXTRA_STREAM, contentUri);
                send.setClipData(ClipData.newUri(
                    context.getContentResolver(),
                    "Bubble Capsule recap",
                    contentUri
                ));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                Intent chooser = Intent.createChooser(send, "Save or share family recap");
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivityForResult(call, chooser, SHARE_CALLBACK);
            } catch (ActivityNotFoundException exception) {
                revokeSharePermission(grantedUri);
                shareInProgress.set(false);
                call.reject(
                    "No app is available to save or share this capsule recap.",
                    "PRESENTATION_FAILED",
                    exception
                );
            } catch (IOException | IllegalArgumentException exception) {
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

    @ActivityCallback
    private void shareFinished(PluginCall call, ActivityResult activityResult) {
        shareInProgress.set(false);
        if (call == null) {
            return;
        }

        String fileUri = call.getString("fileUri");
        try {
            CapsuleRecapFiles files = files();
            File recap = files.validateRecap(fileUri);
            Uri contentUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                recap
            );
            getContext().revokeUriPermission(
                contentUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
            //noinspection ResultOfMethodCallIgnored -- sharing consumes the temporary recap.
            recap.delete();
        } catch (IOException | IllegalArgumentException ignored) {
            // The TypeScript finally path also retries constrained cleanup.
        }

        JSObject result = new JSObject();
        result.put("completed", activityResult.getResultCode() == Activity.RESULT_OK);
        Intent data = activityResult.getData();
        if (data != null) {
            ComponentName chosen = data.getParcelableExtra(Intent.EXTRA_CHOSEN_COMPONENT);
            if (chosen != null) {
                result.put("activityType", chosen.flattenToShortString());
            }
        }
        call.resolve(result);
    }

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
            workQueue.submit(() -> {
                int removedCount = 0;
                try {
                    CapsuleRecapFiles files = files();
                    Set<String> uniqueUris = new HashSet<>(fileUris);
                    for (String fileUri : uniqueUris) {
                        File artifact = files.removableArtifact(fileUri);
                        if (artifact != null && artifact.isFile() && artifact.delete()) {
                            removedCount += 1;
                        }
                    }
                } catch (IOException ignored) {
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

    @Override
    protected void handleOnDestroy() {
        workQueue.shutdownNow();
        renderInProgress.set(false);
        shareInProgress.set(false);
    }

    private CapsuleRecapFiles files() throws IOException {
        return new CapsuleRecapFiles(getContext().getCacheDir());
    }

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

    private static String messageOrFallback(Exception exception, String fallback) {
        String message = exception.getMessage();
        return message == null || message.trim().isEmpty() ? fallback : message;
    }
}
