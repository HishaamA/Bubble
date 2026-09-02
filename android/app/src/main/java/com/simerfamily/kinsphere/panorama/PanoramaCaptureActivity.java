package com.simerfamily.kinsphere.panorama;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.Image;
import android.net.Uri;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.AppCompatButton;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.google.ar.core.ArCoreApk;
import com.google.ar.core.Camera;
import com.google.ar.core.CameraConfig;
import com.google.ar.core.CameraConfigFilter;
import com.google.ar.core.CameraIntrinsics;
import com.google.ar.core.Config;
import com.google.ar.core.Frame;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingFailureReason;
import com.google.ar.core.TrackingState;
import com.google.ar.core.exceptions.CameraNotAvailableException;
import com.google.ar.core.exceptions.NotYetAvailableException;
import com.google.ar.core.exceptions.UnavailableApkTooOldException;
import com.google.ar.core.exceptions.UnavailableArcoreNotInstalledException;
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException;
import com.google.ar.core.exceptions.UnavailableSdkTooOldException;
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Android counterpart to {@code PanoramaCaptureViewController.swift}.
 *
 * <p>ARCore owns the preview and supplies a six-degree-of-freedom pose, image
 * intrinsics, and YUV camera image from one synchronized {@link Frame}. That is
 * the same contract used by the iOS ARKit implementation; no independent
 * rotation sensor or CameraX shutter timing is mixed into the result.</p>
 */
public final class PanoramaCaptureActivity extends AppCompatActivity implements ArCameraRenderer.Listener {

    static final String EXTRA_OPTIONS_JSON = "panoramaCaptureOptions";
    static final String EXTRA_RESULT_JSON = "panoramaCaptureResult";
    static final String EXTRA_ERROR_CODE = "panoramaCaptureErrorCode";
    static final String EXTRA_ERROR_MESSAGE = "panoramaCaptureErrorMessage";

    private static final String TAG = "PanoramaCapture";
    private static final int CAMERA_PERMISSION_REQUEST = 360;
    private static final long CAPTURE_COOLDOWN_MILLIS = 450L;
    private static final long GUIDANCE_INTERVAL_NANOS = 50_000_000L;
    private static final float[] IDENTITY_ROTATION = {
        1.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 1.0f,
    };

    private final ArrayList<JSONObject> frames = new ArrayList<>();
    private CaptureOptions options;
    private String sessionId;
    private File capturesRoot;
    private File sessionDirectory;
    private List<PanoramaTarget> targets;
    private GLSurfaceView surfaceView;
    private ArCameraRenderer renderer;
    private PanoramaGuideView guideView;
    private TextView progressLabel;
    private TextView instructionLabel;
    private ProgressBar progressBar;
    private ExecutorService imageExecutor;
    private Session arSession;
    private PanoramaPose currentPose;
    private PanoramaPose previousPose;
    private long previousFrameTimestampNanos;
    private long alignedSinceNanos = -1L;
    private PanoramaPose holdStartPose;
    private long lastCaptureCompletedAtMillis;
    private long lastGuidancePublishedAtNanos;
    private int alignedTargetIndex = -1;
    private int captureSurfaceRotation = Surface.ROTATION_0;
    private int imageRotationDegrees = 90;
    private float smoothedAngularSpeed = Float.POSITIVE_INFINITY;
    private float smoothedLinearSpeed = Float.POSITIVE_INFINITY;
    private boolean installRequested;
    private boolean sessionResumed;
    private volatile boolean cameraReady;
    private volatile boolean captureInFlight;
    private volatile boolean finishingCapture;
    private volatile int remainingTargetCount;

    /** Establishes fullscreen capture or requests the one runtime permission it requires. */
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureFullscreenWindow();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                new String[] { Manifest.permission.CAMERA },
                CAMERA_PERMISSION_REQUEST
            );
            return;
        }

        initializeCapture();
    }

    /** Creates the private capture session, deterministic targets, worker, and camera UI. */
    private void initializeCapture() {
        options = CaptureOptions.fromJson(getIntent().getStringExtra(EXTRA_OPTIONS_JSON));
        targets = createTargets(options.mode);
        remainingTargetCount = targets.size();
        sessionId = UUID.randomUUID().toString();
        capturesRoot = new File(getCacheDir(), "panorama_captures");
        sessionDirectory = new File(capturesRoot, sessionId);
        if (
            (!capturesRoot.exists() && !capturesRoot.mkdirs()) ||
            !capturesRoot.isDirectory() ||
            (!sessionDirectory.exists() && !sessionDirectory.mkdirs()) ||
            !sessionDirectory.isDirectory()
        ) {
            failCapture("CAPTURE_FAILED", "The panorama capture directory could not be created.");
            return;
        }

        imageExecutor = Executors.newSingleThreadExecutor(
            task -> new Thread(task, "bubble-panorama-image")
        );
        captureSurfaceRotation = getWindowManager().getDefaultDisplay().getRotation();
        buildCaptureInterface();
        guideView.setTargets(targets);
        updateProgressInterface();
        writeMetadataSnapshot("inProgress");

        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                /** Routes back through session cleanup instead of abandoning partial frames. */
                @Override
                public void handleOnBackPressed() {
                    cancelCapture();
                }
            }
        );
    }

    /** Continues initialization only for the Activity's own successful camera request. */
    @Override
    public void onRequestPermissionsResult(
        int requestCode,
        String[] permissions,
        int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION_REQUEST) {
            return;
        }
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            initializeCapture();
            return;
        }
        failCapture("PERMISSION_DENIED", "Camera permission is required for panorama capture.");
    }

    /** Keeps the camera edge-to-edge and awake while preserving transient system-bar access. */
    private void configureFullscreenWindow() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
            getWindow(),
            getWindow().getDecorView()
        );
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    /** Builds the camera surface, guide overlay, progress header, and safe-area layout. */
    private void buildCaptureInterface() {
        float density = getResources().getDisplayMetrics().density;
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        renderer = new ArCameraRenderer(this);
        renderer.setDisplayRotation(captureSurfaceRotation);
        surfaceView = new GLSurfaceView(this);
        surfaceView.setPreserveEGLContextOnPause(true);
        surfaceView.setEGLContextClientVersion(2);
        surfaceView.setRenderer(renderer);
        surfaceView.setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);
        root.addView(surfaceView, matchParentLayout());

        guideView = new PanoramaGuideView(this);
        root.addView(guideView, matchParentLayout());

        FrameLayout header = new FrameLayout(this);
        GradientDrawable headerBackground = new GradientDrawable();
        headerBackground.setColor(0xA6000000);
        headerBackground.setCornerRadius(18.0f * density);
        header.setBackground(headerBackground);
        FrameLayout.LayoutParams headerParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            Math.round(64.0f * density),
            Gravity.TOP
        );
        headerParams.leftMargin = Math.round(14.0f * density);
        headerParams.rightMargin = Math.round(14.0f * density);
        headerParams.topMargin = Math.round(12.0f * density);
        root.addView(header, headerParams);

        AppCompatButton cancelButton = createHeaderButton("Cancel");
        cancelButton.setContentDescription("Cancel panorama capture");
        cancelButton.setOnClickListener(view -> cancelCapture());
        FrameLayout.LayoutParams cancelParams = new FrameLayout.LayoutParams(
            Math.round(82.0f * density),
            Math.round(44.0f * density),
            Gravity.TOP | Gravity.START
        );
        cancelParams.leftMargin = Math.round(5.0f * density);
        cancelParams.topMargin = Math.round(2.0f * density);
        header.addView(cancelButton, cancelParams);

        TextView titleLabel = new TextView(this);
        titleLabel.setText(modeDisplayName(options.mode) + " Panorama");
        titleLabel.setTextColor(Color.WHITE);
        titleLabel.setTextSize(16.0f);
        titleLabel.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams titleParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Math.round(44.0f * density),
            Gravity.TOP | Gravity.CENTER_HORIZONTAL
        );
        titleParams.topMargin = Math.round(2.0f * density);
        header.addView(titleLabel, titleParams);

        progressLabel = new TextView(this);
        progressLabel.setTextColor(Color.WHITE);
        progressLabel.setTextSize(15.0f);
        progressLabel.setGravity(Gravity.CENTER_VERTICAL | Gravity.END);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
            Math.round(72.0f * density),
            Math.round(44.0f * density),
            Gravity.TOP | Gravity.END
        );
        progressParams.rightMargin = Math.round(14.0f * density);
        progressParams.topMargin = Math.round(2.0f * density);
        header.addView(progressLabel, progressParams);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(targets.size());
        progressBar.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.WHITE));
        progressBar.setProgressBackgroundTintList(
            android.content.res.ColorStateList.valueOf(0x48FFFFFF)
        );
        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            Math.round(3.0f * density),
            Gravity.BOTTOM
        );
        barParams.leftMargin = Math.round(14.0f * density);
        barParams.rightMargin = Math.round(14.0f * density);
        barParams.bottomMargin = Math.round(8.0f * density);
        header.addView(progressBar, barParams);

        instructionLabel = new TextView(this);
        instructionLabel.setTextColor(Color.WHITE);
        instructionLabel.setTextSize(17.0f);
        instructionLabel.setGravity(Gravity.CENTER);
        instructionLabel.setText("Preparing AR camera…");
        instructionLabel.setPadding(
            Math.round(20.0f * density),
            Math.round(12.0f * density),
            Math.round(20.0f * density),
            Math.round(12.0f * density)
        );
        GradientDrawable guidanceBackground = new GradientDrawable();
        guidanceBackground.setColor(0xA6000000);
        guidanceBackground.setCornerRadius(18.0f * density);
        instructionLabel.setBackground(guidanceBackground);
        FrameLayout.LayoutParams instructionParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
        );
        instructionParams.leftMargin = Math.round(24.0f * density);
        instructionParams.rightMargin = Math.round(24.0f * density);
        instructionParams.bottomMargin = Math.round(22.0f * density);
        root.addView(instructionLabel, instructionParams);

        ViewCompat.setOnApplyWindowInsetsListener(
            root,
            (view, windowInsets) -> {
                Insets safeInsets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.systemBars()
                );
                headerParams.leftMargin = Math.max(
                    Math.round(14.0f * density),
                    safeInsets.left + Math.round(14.0f * density)
                );
                headerParams.rightMargin = Math.max(
                    Math.round(14.0f * density),
                    safeInsets.right + Math.round(14.0f * density)
                );
                headerParams.topMargin = Math.max(
                    Math.round(12.0f * density),
                    safeInsets.top + Math.round(8.0f * density)
                );
                instructionParams.bottomMargin = Math.max(
                    Math.round(22.0f * density),
                    safeInsets.bottom + Math.round(20.0f * density)
                );
                header.setLayoutParams(headerParams);
                instructionLabel.setLayoutParams(instructionParams);
                return windowInsets;
            }
        );

        setContentView(root);
        ViewCompat.requestApplyInsets(root);
    }

    /** Returns full-parent layout parameters shared by the preview and guide layers. */
    private static FrameLayout.LayoutParams matchParentLayout() {
        return new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        );
    }

    /** Creates a compact text-only action for the capture header. */
    private AppCompatButton createHeaderButton(String text) {
        AppCompatButton button = new AppCompatButton(this);
        button.setText(text);
        button.setTextColor(Color.WHITE);
        button.setTextSize(16.0f);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setPadding(0, 0, 0, 0);
        button.setBackgroundColor(Color.TRANSPARENT);
        return button;
    }

    /** Resumes one ARCore session before restarting its dependent GL surface. */
    @Override
    protected void onResume() {
        super.onResume();
        if (finishingCapture || surfaceView == null || !ensureArSession()) {
            return;
        }

        captureSurfaceRotation = getWindowManager().getDefaultDisplay().getRotation();
        renderer.setDisplayRotation(captureSurfaceRotation);
        renderer.setSession(arSession);
        try {
            arSession.resume();
            sessionResumed = true;
            surfaceView.onResume();
            instructionLabel.setText("Move slowly while tracking starts");
        } catch (CameraNotAvailableException error) {
            Log.e(TAG, "ARCore camera is unavailable", error);
            failCapture("CAPTURE_FAILED", "The AR camera is unavailable. Close other camera apps and try again.");
        }
    }

    /** Stops the GL thread before pausing ARCore and resetting cross-thread motion state. */
    @Override
    protected void onPause() {
        if (surfaceView != null) {
            // GLSurfaceView.onPause waits for its renderer thread, so mutable
            // motion state is reset only after that thread has stopped using it.
            surfaceView.onPause();
        }
        cameraReady = false;
        resetSteadiness();
        if (arSession != null && sessionResumed) {
            arSession.pause();
            sessionResumed = false;
        }
        super.onPause();
    }

    /** Installs if needed, configures once, and retains the Activity-owned ARCore session. */
    private boolean ensureArSession() {
        if (arSession != null) {
            return true;
        }
        try {
            ArCoreApk.InstallStatus installStatus = ArCoreApk.getInstance().requestInstall(
                this,
                !installRequested
            );
            if (installStatus == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                installRequested = true;
                instructionLabel.setText("Preparing Google Play Services for AR…");
                return false;
            }

            arSession = new Session(this);
            selectBestCameraConfiguration(arSession);
            Config configuration = new Config(arSession);
            configuration.setFocusMode(Config.FocusMode.AUTO);
            configuration.setPlaneFindingMode(Config.PlaneFindingMode.DISABLED);
            configuration.setLightEstimationMode(Config.LightEstimationMode.DISABLED);
            configuration.setUpdateMode(Config.UpdateMode.BLOCKING);
            arSession.configure(configuration);
            updateImageRotation(arSession);
            return true;
        } catch (UnavailableArcoreNotInstalledException | UnavailableUserDeclinedInstallationException error) {
            failCapture("NOT_SUPPORTED", "Google Play Services for AR is required for guided panorama capture.");
        } catch (UnavailableApkTooOldException error) {
            failCapture("NOT_SUPPORTED", "Update Google Play Services for AR, then try again.");
        } catch (UnavailableSdkTooOldException error) {
            failCapture("NOT_SUPPORTED", "This Bubble build must be updated before AR capture can start.");
        } catch (UnavailableDeviceNotCompatibleException error) {
            failCapture("NOT_SUPPORTED", "Guided panorama capture requires an ARCore-capable Android phone.");
        } catch (Exception error) {
            Log.e(TAG, "Unable to create ARCore session", error);
            failCapture("CAPTURE_FAILED", "The AR camera session could not be started.");
        }
        return false;
    }

    /** Selects the highest-resolution supported rear CPU-image stream for stitching. */
    private void selectBestCameraConfiguration(Session session) {
        CameraConfigFilter filter = new CameraConfigFilter(session);
        filter.setFacingDirection(CameraConfig.FacingDirection.BACK);
        List<CameraConfig> configurations = session.getSupportedCameraConfigs(filter);
        CameraConfig best = null;
        long bestPixels = -1L;
        for (CameraConfig candidate : configurations) {
            Size imageSize = candidate.getImageSize();
            long pixels = (long) imageSize.getWidth() * imageSize.getHeight();
            if (pixels > bestPixels) {
                best = candidate;
                bestPixels = pixels;
            }
        }
        if (best != null) {
            session.setCameraConfig(best);
            Log.i(TAG, "Selected ARCore CPU image size " + best.getImageSize());
        }
    }

    /** Derives the rotation needed to store the sensor image upright in the current display. */
    private void updateImageRotation(Session session) {
        try {
            CameraManager manager = (CameraManager) getSystemService(CAMERA_SERVICE);
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(
                session.getCameraConfig().getCameraId()
            );
            Integer sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            if (sensorOrientation == null) {
                return;
            }
            int displayDegrees = surfaceRotationDegrees(captureSurfaceRotation);
            imageRotationDegrees = (sensorOrientation - displayDegrees + 360) % 360;
        } catch (Exception error) {
            Log.w(TAG, "Unable to read AR camera orientation; using portrait default", error);
            imageRotationDegrees = 90;
        }
    }

    /** Processes synchronized preview, pose, tracking, and capture guidance on the GL thread. */
    @Override
    public void onFrame(Frame frame, Camera camera, float[] cameraToWorld, float[] projection) {
        if (finishingCapture) {
            return;
        }
        if (camera.getTrackingState() != TrackingState.TRACKING) {
            cameraReady = false;
            resetSteadiness();
            publishTrackingState(camera, projection);
            return;
        }

        cameraReady = true;
        PanoramaPose pose = PanoramaPose.fromCameraTransform(cameraToWorld);
        currentPose = pose;
        boolean steady = updateMotion(pose, frame.getTimestamp());
        updateGuidance(frame, camera, pose, projection, steady);
    }

    /** Converts a terminal renderer failure into one Activity result on the UI thread. */
    @Override
    public void onFailure(Exception error) {
        runOnUiThread(() -> {
            if (!finishingCapture) {
                failCapture("CAPTURE_FAILED", "The AR capture session stopped. Reopen the camera and try again.");
            }
        });
    }

    /** Updates instantaneous and exponentially smoothed six-degree motion estimates. */
    private boolean updateMotion(PanoramaPose pose, long timestampNanos) {
        PanoramaPose previous = previousPose;
        long previousTimestamp = previousFrameTimestampNanos;
        previousPose = pose;
        previousFrameTimestampNanos = timestampNanos;
        if (previous == null || previousTimestamp == 0L) {
            return false;
        }

        double elapsed = (timestampNanos - previousTimestamp) / 1_000_000_000.0;
        if (elapsed <= 0.0001 || elapsed >= 0.25) {
            smoothedAngularSpeed = Float.POSITIVE_INFINITY;
            smoothedLinearSpeed = Float.POSITIVE_INFINITY;
            return false;
        }
        double quaternionDot = Math.abs(
            previous.quaternion[0] * pose.quaternion[0] +
            previous.quaternion[1] * pose.quaternion[1] +
            previous.quaternion[2] * pose.quaternion[2] +
            previous.quaternion[3] * pose.quaternion[3]
        );
        quaternionDot = Math.max(0.0, Math.min(1.0, quaternionDot));
        float angularSpeed = (float) (2.0 * Math.acos(quaternionDot) / elapsed);
        double deltaX = pose.position[0] - previous.position[0];
        double deltaY = pose.position[1] - previous.position[1];
        double deltaZ = pose.position[2] - previous.position[2];
        float linearSpeed = (float) (Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ) / elapsed);

        if (Float.isFinite(smoothedAngularSpeed)) {
            smoothedAngularSpeed = 0.78f * smoothedAngularSpeed + 0.22f * angularSpeed;
            smoothedLinearSpeed = 0.78f * smoothedLinearSpeed + 0.22f * linearSpeed;
        } else {
            smoothedAngularSpeed = angularSpeed;
            smoothedLinearSpeed = linearSpeed;
        }
        return PanoramaCapturePolicy.isMotionSteady(
            angularSpeed,
            linearSpeed,
            smoothedAngularSpeed,
            smoothedLinearSpeed
        );
    }

    /** Chooses the nearest target, advances its steady hold, and captures when eligible. */
    private void updateGuidance(Frame frame, Camera camera, PanoramaPose pose, float[] projection, boolean steady) {
        PanoramaTarget activeTarget = findNearestUncapturedTarget(pose);
        if (activeTarget == null) {
            publishGuide(pose, projection, -1, 0.0f, false, true, captureInFlight, "Capture complete");
            if (!captureInFlight && !frames.isEmpty()) {
                runOnUiThread(this::finishCaptureSuccessfully);
            }
            return;
        }

        float angularDistance = pose.angularDistanceDegrees(activeTarget);
        boolean aligned = angularDistance <= options.alignmentDegrees;
        if (activeTarget.index != alignedTargetIndex) {
            alignedTargetIndex = activeTarget.index;
            resetHoldWindow();
        }

        float holdProgress = 0.0f;
        if (cameraReady && aligned && steady && !captureInFlight) {
            if (alignedSinceNanos < 0L || holdStartPose == null) {
                startHoldWindow(pose, frame.getTimestamp());
            } else if (!PanoramaCapturePolicy.isWithinHoldDrift(
                holdStartPose.angularDistanceDegrees(pose),
                holdStartPose.linearDistanceMeters(pose)
            )) {
                startHoldWindow(pose, frame.getTimestamp());
            }
            long heldMillis = Math.max(0L, (frame.getTimestamp() - alignedSinceNanos) / 1_000_000L);
            holdProgress = Math.min(1.0f, heldMillis / (float) options.steadyDurationMillis);
            if (
                holdProgress >= 1.0f &&
                SystemClock.uptimeMillis() - lastCaptureCompletedAtMillis >= CAPTURE_COOLDOWN_MILLIS
            ) {
                captureFrame(frame, camera, activeTarget, pose);
                holdProgress = 0.0f;
            }
        } else {
            resetHoldWindow();
        }

        String instruction;
        if (captureInFlight) {
            instruction = "Capturing…";
        } else if (!aligned) {
            instruction = PanoramaCapturePolicy.shouldShowCompletionChevron(remainingTargetCount)
                ? "Follow the arrow to a remaining dot"
                : "Move a dot into the circle";
        } else if (holdProgress > 0.0f) {
            instruction = "Hold still";
        } else {
            instruction = "Steady your Android phone";
        }
        publishGuide(
            pose,
            projection,
            activeTarget.index,
            holdProgress,
            aligned,
            steady,
            captureInFlight,
            instruction
        );
    }

    /** Maps ARCore tracking loss to throttled guidance without accepting a frame. */
    private void publishTrackingState(Camera camera, float[] projection) {
        String message;
        TrackingFailureReason reason = camera.getTrackingFailureReason();
        if (reason == TrackingFailureReason.INSUFFICIENT_LIGHT) {
            message = "Move somewhere with more light";
        } else if (reason == TrackingFailureReason.EXCESSIVE_MOTION) {
            message = "Move the phone more slowly";
        } else if (reason == TrackingFailureReason.INSUFFICIENT_FEATURES) {
            message = "Point at a detailed part of the room";
        } else {
            message = "Move slowly while tracking starts";
        }
        long now = SystemClock.elapsedRealtimeNanos();
        if (now - lastGuidancePublishedAtNanos < GUIDANCE_INTERVAL_NANOS) {
            return;
        }
        lastGuidancePublishedAtNanos = now;
        PanoramaPose pose = currentPose;
        float[] rotationCopy = (pose == null ? IDENTITY_ROTATION : pose.rotation).clone();
        float[] projectionCopy = projection.clone();
        runOnUiThread(() -> {
            if (finishingCapture) {
                return;
            }
            guideView.updatePose(rotationCopy, projectionCopy, -1, 0.0f, false, false, false);
            instructionLabel.setText(message);
        });
    }

    /** Copies GL-thread pose values before publishing throttled guide state on the UI thread. */
    private void publishGuide(
        PanoramaPose pose,
        float[] projection,
        int targetIndex,
        float holdProgress,
        boolean aligned,
        boolean steady,
        boolean capturing,
        String instruction
    ) {
        long now = SystemClock.elapsedRealtimeNanos();
        if (now - lastGuidancePublishedAtNanos < GUIDANCE_INTERVAL_NANOS) {
            return;
        }
        lastGuidancePublishedAtNanos = now;
        float[] rotationCopy = pose.rotation.clone();
        float[] projectionCopy = projection.clone();
        runOnUiThread(() -> {
            if (finishingCapture) {
                return;
            }
            guideView.updatePose(
                rotationCopy,
                projectionCopy,
                targetIndex,
                holdProgress,
                aligned,
                steady,
                capturing
            );
            instructionLabel.setText(instruction);
        });
    }

    /** Detaches one synchronized CPU image and queues encoding without blocking GL. */
    private void captureFrame(Frame frame, Camera camera, PanoramaTarget target, PanoramaPose pose) {
        if (captureInFlight || target.captured || finishingCapture) {
            return;
        }

        final ArCapturedImage capturedImage;
        try (Image image = frame.acquireCameraImage()) {
            capturedImage = ArCapturedImage.copyOf(image);
        } catch (NotYetAvailableException unavailable) {
            // ARCore commonly needs another CPU-image cycle. Restarting the
            // hold avoids retrying acquisition on every rendered frame.
            resetHoldWindow();
            return;
        } catch (Exception error) {
            Log.e(TAG, "Unable to copy synchronized AR camera frame", error);
            resetHoldWindow();
            publishCaptureRetry("Couldn't read that camera frame. Keep holding still.");
            return;
        }

        CameraIntrinsics intrinsics = camera.getImageIntrinsics();
        CaptureSnapshot snapshot = new CaptureSnapshot(
            frames.size(),
            target,
            pose,
            capturedImage,
            intrinsics.getFocalLength(),
            intrinsics.getPrincipalPoint(),
            intrinsics.getImageDimensions(),
            frame.getTimestamp(),
            System.currentTimeMillis(),
            imageRotationDegrees
        );

        captureInFlight = true;
        resetHoldWindow();
        try {
            imageExecutor.execute(() -> encodeCapturedFrame(snapshot));
        } catch (RejectedExecutionException error) {
            captureInFlight = false;
            Log.w(TAG, "Image encoding was rejected during activity shutdown", error);
        }
    }

    /** Encodes one detached frame and posts either atomic acceptance or a retry to UI. */
    private void encodeCapturedFrame(CaptureSnapshot snapshot) {
        File output = new File(
            sessionDirectory,
            String.format(Locale.US, "frame_%03d.jpg", snapshot.frameIndex)
        );
        try {
            ArCapturedImage.EncodedFrame encoded = snapshot.image.encode(
                output,
                snapshot.rotationDegrees,
                options.outputWidth,
                options.jpegQualityPercent
            );
            JSONObject metadata = buildFrameMetadata(snapshot, encoded);
            runOnUiThread(() -> acceptCapturedFrame(snapshot.target, metadata, encoded.file));
        } catch (Exception | OutOfMemoryError error) {
            Log.e(TAG, "Unable to encode synchronized AR panorama frame", error);
            deleteFileQuietly(output);
            runOnUiThread(() -> recoverFromFrameFailure(
                "Couldn't save that frame. Hold the target and try again."
            ));
        }
    }

    /** Serializes one accepted frame with its pose, target, calibrated intrinsics, and provenance. */
    private JSONObject buildFrameMetadata(
        CaptureSnapshot snapshot,
        ArCapturedImage.EncodedFrame encoded
    ) throws JSONException {
        double[] uprightIntrinsics = adjustedIntrinsics(
            snapshot.focalLength,
            snapshot.principalPoint,
            snapshot.intrinsicDimensions,
            encoded.sourceWidth,
            encoded.sourceHeight,
            encoded.sourceRotationDegrees,
            encoded.width,
            encoded.height
        );
        PanoramaPose pose = snapshot.pose;
        PanoramaTarget target = snapshot.target;
        JSONObject frame = new JSONObject();
        frame.put("index", snapshot.frameIndex);
        frame.put("targetIndex", target.index);
        frame.put("uri", Uri.fromFile(encoded.file).toString());
        frame.put("path", encoded.file.getAbsolutePath());
        frame.put("width", encoded.width);
        frame.put("height", encoded.height);
        frame.put("timestamp", snapshot.capturedAtMillis);
        frame.put("capturedAt", iso8601(snapshot.capturedAtMillis));
        frame.put("frameTimestamp", snapshot.frameTimestampNanos / 1_000_000_000.0);
        frame.put("yaw", pose.yawDegrees);
        frame.put("pitch", pose.pitchDegrees);
        frame.put("roll", pose.rollDegrees);
        frame.put("yawDegrees", pose.yawDegrees);
        frame.put("pitchDegrees", pose.pitchDegrees);
        frame.put("rollDegrees", pose.rollDegrees);
        frame.put("targetYaw", target.yawDegrees);
        frame.put("targetPitch", target.pitchDegrees);
        frame.put("targetYawDegrees", target.yawDegrees);
        frame.put("targetPitchDegrees", target.pitchDegrees);
        frame.put("position", vectorJson(pose.position));
        frame.put("quaternion", quaternionJson(pose.quaternion));
        frame.put("transform", floatArrayToJson(pose.transform));
        frame.put("intrinsics", doubleArrayToJson(uprightIntrinsics));
        frame.put("intrinsicsSource", "arcoreImageIntrinsics+uprightRotation");
        frame.put(
            "horizontalFovDegrees",
            fieldOfViewDegrees(uprightIntrinsics[0], uprightIntrinsics[2], encoded.width)
        );
        frame.put("verticalFovDegrees", fieldOfViewDegrees(uprightIntrinsics[4], uprightIntrinsics[5], encoded.height));
        frame.put("imageOrientation", "up");
        frame.put("rotationDegrees", 0);
        frame.put("sourceRotationDegrees", encoded.sourceRotationDegrees);
        frame.put("sourceWidth", encoded.sourceWidth);
        frame.put("sourceHeight", encoded.sourceHeight);
        frame.put("captureInterfaceOrientation", "portrait");
        frame.put("trackingState", "normal");
        frame.put("poseSource", "arcoreDisplayOrientedPose");
        frame.put("translationAvailable", true);
        frame.put("poseTimestamp", snapshot.frameTimestampNanos / 1_000_000_000.0);
        return frame;
    }

    /** Rotates and rescales ARCore intrinsics to match the saved upright JPEG. */
    static double[] adjustedIntrinsics(
        float[] focalLength,
        float[] principalPoint,
        int[] intrinsicDimensions,
        int sourceWidth,
        int sourceHeight,
        int rotationDegrees,
        int outputWidth,
        int outputHeight
    ) {
        if (
            focalLength == null ||
            focalLength.length < 2 ||
            principalPoint == null ||
            principalPoint.length < 2 ||
            intrinsicDimensions == null ||
            intrinsicDimensions.length < 2 ||
            !Float.isFinite(focalLength[0]) ||
            !Float.isFinite(focalLength[1]) ||
            !Float.isFinite(principalPoint[0]) ||
            !Float.isFinite(principalPoint[1]) ||
            focalLength[0] <= 0.0f ||
            focalLength[1] <= 0.0f ||
            intrinsicDimensions[0] <= 0 ||
            intrinsicDimensions[1] <= 0 ||
            sourceWidth <= 0 ||
            sourceHeight <= 0 ||
            outputWidth <= 0 ||
            outputHeight <= 0
        ) {
            throw new IllegalArgumentException("Camera intrinsics and image dimensions must be valid.");
        }
        int normalizedRotation = ((rotationDegrees % 360) + 360) % 360;
        if (normalizedRotation % 90 != 0) {
            throw new IllegalArgumentException("Image rotation must be a multiple of 90 degrees.");
        }

        double referenceWidth = intrinsicDimensions[0];
        double referenceHeight = intrinsicDimensions[1];
        double rawFx = focalLength[0] * sourceWidth / referenceWidth;
        double rawFy = focalLength[1] * sourceHeight / referenceHeight;
        double rawCx = principalPoint[0] * sourceWidth / referenceWidth;
        double rawCy = principalPoint[1] * sourceHeight / referenceHeight;
        double fx;
        double fy;
        double cx;
        double cy;
        int uprightWidth;
        int uprightHeight;

        if (normalizedRotation == 90) {
            fx = rawFy;
            fy = rawFx;
            cx = sourceHeight - 1.0 - rawCy;
            cy = rawCx;
            uprightWidth = sourceHeight;
            uprightHeight = sourceWidth;
        } else if (normalizedRotation == 180) {
            fx = rawFx;
            fy = rawFy;
            cx = sourceWidth - 1.0 - rawCx;
            cy = sourceHeight - 1.0 - rawCy;
            uprightWidth = sourceWidth;
            uprightHeight = sourceHeight;
        } else if (normalizedRotation == 270) {
            fx = rawFy;
            fy = rawFx;
            cx = rawCy;
            cy = sourceWidth - 1.0 - rawCx;
            uprightWidth = sourceHeight;
            uprightHeight = sourceWidth;
        } else {
            fx = rawFx;
            fy = rawFy;
            cx = rawCx;
            cy = rawCy;
            uprightWidth = sourceWidth;
            uprightHeight = sourceHeight;
        }

        double outputScaleX = outputWidth / (double) uprightWidth;
        double outputScaleY = outputHeight / (double) uprightHeight;
        return new double[] {
            fx * outputScaleX,
            0.0,
            cx * outputScaleX,
            0.0,
            fy * outputScaleY,
            cy * outputScaleY,
            0.0,
            0.0,
            1.0,
        };
    }

    /** Commits one encoded frame on UI and releases the cross-thread capture barrier last. */
    private void acceptCapturedFrame(
        PanoramaTarget target,
        JSONObject metadata,
        File encodedImage
    ) {
        if (finishingCapture || isFinishing()) {
            // Cancellation may win the race after encoding but before the UI
            // thread accepts the result; never leave that late frame behind.
            deleteFileQuietly(encodedImage);
            return;
        }
        target.captured = true;
        frames.add(metadata);
        remainingTargetCount = targets.size() - frames.size();
        lastCaptureCompletedAtMillis = SystemClock.uptimeMillis();
        alignedTargetIndex = -1;
        // Publish completion last; the GL thread treats this volatile flag as
        // the handoff barrier for the accepted frame and its cooldown state.
        captureInFlight = false;
        guideView.pulseCapture();
        guideView.setContentDescription(
            String.format(Locale.US, "Guided panorama capture, %d of %d frames captured", frames.size(), targets.size())
        );
        updateProgressInterface();
        writeMetadataSnapshot(frames.size() == targets.size() ? "complete" : "inProgress");
        if (frames.size() == targets.size()) {
            finishCaptureSuccessfully();
        }
    }

    /** Shows a transient CPU-image retry without changing accepted frame state. */
    private void publishCaptureRetry(String message) {
        runOnUiThread(() -> {
            if (!finishingCapture) {
                instructionLabel.setText(message);
            }
        });
    }

    /** Resets target hold state after encoding fails so the same direction can be retried. */
    private void recoverFromFrameFailure(String message) {
        if (finishingCapture || isFinishing()) {
            return;
        }
        alignedTargetIndex = -1;
        resetHoldWindow();
        instructionLabel.setText(message);
        captureInFlight = false;
    }

    /** Keeps the textual and native progress indicators synchronized with accepted frames. */
    private void updateProgressInterface() {
        if (progressLabel == null) {
            return;
        }
        progressLabel.setText(String.format(Locale.US, "%d / %d", frames.size(), targets.size()));
        progressBar.setMax(targets.size());
        progressBar.setProgress(frames.size(), true);
    }

    /** Finds the uncaptured direction with the smallest camera-angle delta. */
    private PanoramaTarget findNearestUncapturedTarget(PanoramaPose pose) {
        PanoramaTarget nearest = null;
        float nearestDistance = Float.POSITIVE_INFINITY;
        for (PanoramaTarget target : targets) {
            if (target.captured) {
                continue;
            }
            float distance = pose.angularDistanceDegrees(target);
            if (distance < nearestDistance) {
                nearest = target;
                nearestDistance = distance;
            }
        }
        return nearest;
    }

    /** Begins a steady-hold window from an immutable pose and ARCore timestamp. */
    private void startHoldWindow(PanoramaPose pose, long timestampNanos) {
        holdStartPose = pose;
        alignedSinceNanos = timestampNanos;
    }

    /** Clears only the active target's hold progress. */
    private void resetHoldWindow() {
        holdStartPose = null;
        alignedSinceNanos = -1L;
    }

    /** Resets motion history whenever tracking or rendering continuity is lost. */
    private void resetSteadiness() {
        previousPose = null;
        previousFrameTimestampNanos = 0L;
        smoothedAngularSpeed = Float.POSITIVE_INFINITY;
        smoothedLinearSpeed = Float.POSITIVE_INFINITY;
        resetHoldWindow();
        alignedTargetIndex = -1;
    }

    /** Atomically writes final metadata and returns the completed session to Capacitor. */
    private void finishCaptureSuccessfully() {
        if (finishingCapture || frames.size() != targets.size() || captureInFlight) {
            return;
        }
        finishingCapture = true;
        try {
            JSONObject result = buildResultJson();
            writeMetadata(result, "complete");
            Intent data = new Intent();
            data.putExtra(EXTRA_RESULT_JSON, result.toString());
            setResult(Activity.RESULT_OK, data);
            finish();
        } catch (Exception error) {
            Log.e(TAG, "Unable to return panorama capture metadata", error);
            finishingCapture = false;
            failCapture("CAPTURE_FAILED", "The panorama metadata could not be saved.");
        }
    }

    /** Builds the bridge result from accepted frames without reading in-flight work. */
    private JSONObject buildResultJson() throws JSONException {
        JSONObject result = new JSONObject();
        result.put("sessionId", sessionId);
        result.put("mode", options.mode);
        result.put("directoryUrl", Uri.fromFile(sessionDirectory).toString());
        result.put("targetCount", targets.size());
        result.put("capturedCount", frames.size());
        result.put("requiresStitching", true);
        JSONArray frameArray = new JSONArray();
        for (JSONObject frame : frames) {
            frameArray.put(frame);
        }
        result.put("frames", frameArray);
        return result;
    }

    /** Persists a best-effort recovery manifest after each session state change. */
    private void writeMetadataSnapshot(String state) {
        if (sessionDirectory == null || !sessionDirectory.exists()) {
            return;
        }
        try {
            writeMetadata(buildResultJson(), state);
        } catch (Exception error) {
            Log.w(TAG, "Unable to update panorama metadata.json", error);
        }
    }

    /** Writes a complete manifest through a temporary file before replacing metadata.json. */
    private void writeMetadata(JSONObject result, String state) throws IOException, JSONException {
        JSONObject manifest = new JSONObject(result.toString());
        manifest.put("state", state);
        manifest.put("captureType", "sourceFrames");
        manifest.put("stitchingPerformed", false);
        manifest.put("poseSource", "arcoreDisplayOrientedPose");
        manifest.put("translationAvailable", true);
        manifest.put("outputWidth", options.outputWidth);
        manifest.put("jpegQuality", options.jpegQuality);
        manifest.put("alignmentDegrees", options.alignmentDegrees);
        manifest.put("steadyDurationMs", options.steadyDurationMillis);

        JSONArray targetArray = new JSONArray();
        for (PanoramaTarget target : targets) {
            JSONObject targetJson = new JSONObject();
            targetJson.put("index", target.index);
            targetJson.put("yaw", target.yawDegrees);
            targetJson.put("pitch", target.pitchDegrees);
            targetJson.put("captured", target.captured);
            targetArray.put(targetJson);
        }
        manifest.put("targets", targetArray);

        File temporary = new File(sessionDirectory, ".metadata.json.tmp");
        File destination = new File(sessionDirectory, "metadata.json");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(manifest.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        if (destination.exists() && !destination.delete()) {
            throw new IOException("The previous panorama metadata file could not be replaced.");
        }
        if (!temporary.renameTo(destination)) {
            copyFile(temporary, destination);
            deleteFileQuietly(temporary);
        }
    }

    /** Returns an explicit cancellation result after deleting the partial private session. */
    private void cancelCapture() {
        if (finishingCapture) {
            return;
        }
        finishingCapture = true;
        cleanupCancelledSession();
        Intent data = new Intent();
        data.putExtra(EXTRA_ERROR_CODE, "CAPTURE_CANCELLED");
        data.putExtra(EXTRA_ERROR_MESSAGE, "Panorama capture was cancelled.");
        setResult(Activity.RESULT_CANCELED, data);
        finish();
    }

    /** Returns one terminal native error after deleting the unusable partial session. */
    private void failCapture(String code, String message) {
        if (finishingCapture && isFinishing()) {
            return;
        }
        finishingCapture = true;
        cleanupCancelledSession();
        Intent data = new Intent();
        data.putExtra(EXTRA_ERROR_CODE, code);
        data.putExtra(EXTRA_ERROR_MESSAGE, message);
        setResult(Activity.RESULT_CANCELED, data);
        finish();
    }

    /** Deletes only the session directory directly owned by this Activity's cache root. */
    private void cleanupCancelledSession() {
        if (sessionDirectory != null && capturesRoot != null && capturesRoot.equals(sessionDirectory.getParentFile())) {
            deleteRecursively(sessionDirectory);
        }
    }

    /** Closes ARCore and interrupts queued encodes after result state is settled. */
    @Override
    protected void onDestroy() {
        if (!finishingCapture) {
            // An external finish cannot return a usable result, so retain no
            // partial frames that JavaScript would have no URI to discard.
            cleanupCancelledSession();
        }
        if (arSession != null) {
            arSession.close();
            arSession = null;
        }
        if (imageExecutor != null) {
            imageExecutor.shutdownNow();
        }
        super.onDestroy();
    }

    /** Builds the ordered quick, standard, or detailed spherical capture grid. */
    static List<PanoramaTarget> createTargets(String mode) {
        ArrayList<PanoramaTarget> targets = new ArrayList<>();
        if ("quick".equals(mode)) {
            addTarget(targets, 0.0, 82.0);
            addRing(targets, 45.0, 4, 45.0, 90.0);
            addRing(targets, 0.0, 8, 0.0, 45.0);
            addRing(targets, -45.0, 4, 45.0, 90.0);
            addTarget(targets, 0.0, -82.0);
        } else if ("detailed".equals(mode)) {
            addTarget(targets, 0.0, 82.0);
            addRing(targets, 60.0, 6, 30.0, 60.0);
            addRing(targets, 30.0, 10, 0.0, 36.0);
            addRing(targets, 0.0, 12, 15.0, 30.0);
            addRing(targets, -30.0, 10, 0.0, 36.0);
            addRing(targets, -60.0, 6, 30.0, 60.0);
            addTarget(targets, 0.0, -82.0);
        } else {
            addTarget(targets, 0.0, 82.0);
            addRing(targets, 55.0, 5, 36.0, 72.0);
            addRing(targets, 27.0, 7, 0.0, 360.0 / 7.0);
            addRing(targets, 0.0, 8, 22.5, 45.0);
            addRing(targets, -27.0, 7, 360.0 / 14.0, 360.0 / 7.0);
            addRing(targets, -55.0, 5, 0.0, 72.0);
            addTarget(targets, 0.0, -82.0);
        }
        return targets;
    }

    /** Appends one evenly spaced ring while preserving global target order. */
    private static void addRing(
        List<PanoramaTarget> targets,
        double pitch,
        int count,
        double firstYaw,
        double yawStep
    ) {
        for (int index = 0; index < count; index++) {
            addTarget(targets, firstYaw + index * yawStep, pitch);
        }
    }

    /** Appends one normalized target with the next stable metadata index. */
    private static void addTarget(List<PanoramaTarget> targets, double yaw, double pitch) {
        targets.add(new PanoramaTarget(targets.size(), yaw, pitch));
    }

    /** Serializes a three-component vector with named axes for the web stitcher. */
    private static JSONObject vectorJson(float[] vector) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("x", vector[0]);
        json.put("y", vector[1]);
        json.put("z", vector[2]);
        return json;
    }

    /** Serializes a normalized quaternion as named vector components plus {@code w}. */
    private static JSONObject quaternionJson(float[] quaternion) throws JSONException {
        JSONObject json = vectorJson(quaternion);
        json.put("w", quaternion[3]);
        return json;
    }

    /** Serializes one float matrix without changing element order. */
    private static JSONArray floatArrayToJson(float[] values) throws JSONException {
        JSONArray array = new JSONArray();
        for (float value : values) {
            array.put(value);
        }
        return array;
    }

    /** Serializes one double matrix without changing element order. */
    private static JSONArray doubleArrayToJson(double[] values) throws JSONException {
        JSONArray array = new JSONArray();
        for (double value : values) {
            array.put(value);
        }
        return array;
    }

    /** Computes asymmetric camera field of view from focal length and principal point. */
    private static double fieldOfViewDegrees(double focalLength, double principalPoint, int pixelCount) {
        if (focalLength <= 0.0 || pixelCount <= 1) {
            return 0.0;
        }
        double negativeExtent = Math.max(0.0, principalPoint);
        double positiveExtent = Math.max(0.0, pixelCount - 1.0 - principalPoint);
        return Math.toDegrees(Math.atan(negativeExtent / focalLength) + Math.atan(positiveExtent / focalLength));
    }

    /** Maps Android display rotation constants to clockwise image degrees. */
    private static int surfaceRotationDegrees(int rotation) {
        return switch (rotation) {
            case Surface.ROTATION_90 -> 90;
            case Surface.ROTATION_180 -> 180;
            case Surface.ROTATION_270 -> 270;
            default -> 0;
        };
    }

    /** Returns the user-facing label for a validated capture density. */
    private static String modeDisplayName(String mode) {
        return switch (mode) {
            case "quick" -> "Quick";
            case "detailed" -> "Detailed";
            default -> "Standard";
        };
    }

    /** Formats capture metadata in stable UTC ISO-8601 form. */
    private static String iso8601(long timestampMillis) {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date(timestampMillis));
    }

    /** Copies a metadata file in bounded chunks when atomic rename is unavailable. */
    private static void copyFile(File source, File destination) throws IOException {
        byte[] buffer = new byte[32 * 1024];
        try (
            FileInputStream input = new FileInputStream(source);
            FileOutputStream output = new FileOutputStream(destination)
        ) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
    }

    /** Removes a private session tree after its root has already been validated. */
    private static void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        deleteFileQuietly(file);
    }

    /** Logs but does not replace the terminal result when cache cleanup fails. */
    private static void deleteFileQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            Log.w(TAG, "Unable to delete " + file.getAbsolutePath());
        }
    }

    /** Immutable handoff from the GL thread to the single image-encoding worker. */
    private static final class CaptureSnapshot {
        final int frameIndex;
        final PanoramaTarget target;
        final PanoramaPose pose;
        final ArCapturedImage image;
        final float[] focalLength;
        final float[] principalPoint;
        final int[] intrinsicDimensions;
        final long frameTimestampNanos;
        final long capturedAtMillis;
        final int rotationDegrees;

        /** Defensively copies mutable ARCore calibration arrays before leaving the GL frame. */
        CaptureSnapshot(
            int frameIndex,
            PanoramaTarget target,
            PanoramaPose pose,
            ArCapturedImage image,
            float[] focalLength,
            float[] principalPoint,
            int[] intrinsicDimensions,
            long frameTimestampNanos,
            long capturedAtMillis,
            int rotationDegrees
        ) {
            this.frameIndex = frameIndex;
            this.target = target;
            this.pose = pose;
            this.image = image;
            this.focalLength = focalLength.clone();
            this.principalPoint = principalPoint.clone();
            this.intrinsicDimensions = intrinsicDimensions.clone();
            this.frameTimestampNanos = frameTimestampNanos;
            this.capturedAtMillis = capturedAtMillis;
            this.rotationDegrees = rotationDegrees;
        }
    }

    /** Validated options accepted from the JavaScript bridge. */
    static final class CaptureOptions {
        final String mode;
        final int outputWidth;
        final double jpegQuality;
        final int jpegQualityPercent;
        final float alignmentDegrees;
        final long steadyDurationMillis;

        /** Stores the normalized values used throughout one native capture session. */
        private CaptureOptions(
            String mode,
            int outputWidth,
            double jpegQuality,
            float alignmentDegrees,
            long steadyDurationMillis
        ) {
            this.mode = mode;
            this.outputWidth = outputWidth;
            this.jpegQuality = jpegQuality;
            this.jpegQualityPercent = (int) Math.round(jpegQuality * 100.0);
            this.alignmentDegrees = alignmentDegrees;
            this.steadyDurationMillis = steadyDurationMillis;
        }

        /** Parses untrusted bridge options and clamps every numeric value to native limits. */
        static CaptureOptions fromJson(@Nullable String json) {
            JSONObject object;
            try {
                object = json == null ? new JSONObject() : new JSONObject(json);
            } catch (JSONException ignored) {
                object = new JSONObject();
            }
            String mode = object.optString("mode", "standard").toLowerCase(Locale.ROOT);
            if (!"quick".equals(mode) && !"standard".equals(mode) && !"detailed".equals(mode)) {
                mode = "standard";
            }
            int requestedWidth = object.optInt("outputWidth", 0);
            int outputWidth = requestedWidth <= 0 ? 0 : clamp(requestedWidth, 640, 4096);
            double jpegQuality = finiteClamp(
                object.optDouble("jpegQuality", 0.92),
                0.92,
                0.5,
                1.0
            );
            float alignment = (float) finiteClamp(
                object.optDouble("alignmentDegrees", 4.5),
                4.5,
                2.0,
                12.0
            );
            long steadyDuration = Math.round(finiteClamp(
                object.optDouble("steadyDurationMs", 650.0),
                650.0,
                300.0,
                2000.0
            ));
            return new CaptureOptions(mode, outputWidth, jpegQuality, alignment, steadyDuration);
        }

        /** Clamps a requested integer option to its inclusive native range. */
        private static int clamp(int value, int minimum, int maximum) {
            return Math.max(minimum, Math.min(maximum, value));
        }

        /** Replaces non-finite bridge numbers before applying an inclusive range. */
        static double finiteClamp(
            double value,
            double fallback,
            double minimum,
            double maximum
        ) {
            if (!Double.isFinite(value)) {
                return fallback;
            }
            return Math.max(minimum, Math.min(maximum, value));
        }
    }
}
