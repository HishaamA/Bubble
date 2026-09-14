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
import com.google.ar.core.Anchor;
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
import com.google.ar.core.exceptions.NotTrackingException;
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
import java.util.ArrayDeque;
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
 * the same camera contract used by the iOS ARKit implementation. A calibrated,
 * timestamp-matched rotation sensor bridges short low-texture interruptions;
 * those frames explicitly declare estimated orientation and no translation.</p>
 */
public final class PanoramaCaptureActivity extends AppCompatActivity implements ArCameraRenderer.Listener {

    static final String EXTRA_OPTIONS_JSON = "panoramaCaptureOptions";
    static final String EXTRA_RESULT_JSON = "panoramaCaptureResult";
    static final String EXTRA_ERROR_CODE = "panoramaCaptureErrorCode";
    static final String EXTRA_ERROR_MESSAGE = "panoramaCaptureErrorMessage";

    private static final String TAG = "PanoramaCapture";
    private static final int CAMERA_PERMISSION_REQUEST = 360;
    private static final long CAPTURE_COOLDOWN_MILLIS = 450L;
    private static final long IMAGE_RETRY_INTERVAL_MILLIS = 120L;
    private static final long BEST_FRAME_SETTLE_NANOS = 220_000_000L;
    private static final long SAVED_ACKNOWLEDGEMENT_MILLIS = 450L;
    private static final long GUIDANCE_INTERVAL_NANOS = 50_000_000L;
    private static final float[] IDENTITY_ROTATION = {
        1.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 1.0f,
    };

    private final ArrayList<JSONObject> frames = new ArrayList<>();
    private final ArrayDeque<JSONObject> captureDiagnostics = new ArrayDeque<>();
    private long lastDiagnosticAtMillis;
    private CaptureOptions options;
    private String sessionId;
    private File capturesRoot;
    private File sessionDirectory;
    private String captureOwnerKey = "legacy-local";
    private long captureCreatedAt;
    private volatile List<PanoramaTarget> targets;
    private int initialTargetCount;
    private volatile boolean coverageCheckInProgress;
    private volatile boolean coverageComplete;
    private double observedCoverage;
    private GLSurfaceView surfaceView;
    private ArCameraRenderer renderer;
    private PanoramaGuideView guideView;
    private TextView progressLabel;
    private TextView instructionLabel;
    private ProgressBar progressBar;
    private ExecutorService imageExecutor;
    private Session arSession;
    // Owned by GL while rendering, then detached only after GLSurfaceView.onPause.
    private Anchor captureAnchor;
    private final float[] anchorToWorld = new float[16];
    private boolean anchorStoppedReported;
    private boolean unsupportedColorReported;
    private PanoramaRotationSensor rotationSensor;
    private final PanoramaRotationBridge rotationBridge = new PanoramaRotationBridge();
    private PanoramaPose anchorToCapture = PanoramaPoseMapping.identity();
    private boolean cameraTimestampIsRealtime;
    private long sensorGeneration = -1;
    private long lastBridgeCalibrationTimestamp;
    private long currentAndroidCameraTimestamp;
    private long currentCalibrationAgeNanos;
    private boolean currentPoseEstimated;
    private boolean trackingInterrupted;
    private long visualRecoveryStartedAt;
    private String inertialMessage;
    private boolean usedInertialFrames;
    private volatile boolean referenceNeedsVerification;
    private PanoramaPose currentPose;
    private final PanoramaCaptureGate captureGate = new PanoramaCaptureGate();
    private final PanoramaCameraClock cameraImageClock = new PanoramaCameraClock();
    // GL-thread only: retain one detached synchronized frame, never an open ARCore Image.
    private final BestFrameSelector<CaptureSnapshot> bestFrameSelector = new BestFrameSelector<>(500_000_000L);
    private int bestFrameTargetIndex = -1;
    private long bestFrameWindowStartNanos;
    private float bestFramePreviousProgress;
    private volatile boolean gateResetRequested;
    private boolean waitingForCameraImage;
    private long lastImageAttemptAtMillis;
    private String lastImageResult = "not_requested";
    private int imageAttempts;
    private int imagesAcquired;
    private int imagesAccepted;
    private long lastCpuImageTimestamp;
    private long lastImageArTimestamp;
    private long lastImageAndroidTimestamp;
    private long lastFreshCameraFrameAtMillis;
    private long lastCaptureCompletedAtMillis;
    private long lastGuidancePublishedAtNanos;
    private long savedAcknowledgementUntilMillis;
    private long retryMessageUntilMillis;
    private String retryMessage;
    private int alignedTargetIndex = -1;
    private int captureSurfaceRotation = Surface.ROTATION_0;
    private int imageRotationDegrees = 90;
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
        try {
            JSONObject captureOptions = new JSONObject(getIntent().getStringExtra(EXTRA_OPTIONS_JSON) == null
                ? "{}" : getIntent().getStringExtra(EXTRA_OPTIONS_JSON));
            captureOwnerKey = PanoramaCaptureStore.owner(captureOptions.optString("ownerKey", "legacy-local"));
        } catch (JSONException | IllegalArgumentException error) {
            failCapture("INVALID_PROFILE", "The local capture profile is unavailable.");
            return;
        }
        captureCreatedAt = System.currentTimeMillis();
        targets = createTargets(options.mode);
        initialTargetCount = targets.size();
        remainingTargetCount = targets.size();
        sessionId = UUID.randomUUID().toString();
        capturesRoot = new File(getFilesDir(), "panorama_captures");
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
        rotationSensor = new PanoramaRotationSensor(this);
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
            if (rotationSensor != null) rotationSensor.start();
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
        cameraImageClock.reset();
        if (rotationSensor != null) rotationSensor.stop();
        rotationBridge.reset();
        lastBridgeCalibrationTimestamp = 0;
        currentPoseEstimated = false;
        trackingInterrupted = referenceNeedsVerification;
        visualRecoveryStartedAt = 0;
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
            Integer timestampSource = characteristics.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE);
            cameraTimestampIsRealtime = timestampSource != null &&
                timestampSource == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME;
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
        if (finishingCapture || unsupportedColorReported) {
            return;
        }
        if (gateResetRequested) {
            gateResetRequested = false;
            resetSteadiness();
        }
        PanoramaSensorHistory.Sample sensorSample = sensorForFrame(frame);
        if (camera.getTrackingState() == TrackingState.STOPPED) {
            pauseForCaptureAnchor(projection, "Tracking reference lost — your photos are kept");
            if (!anchorStoppedReported) {
                anchorStoppedReported = true;
                runOnUiThread(() -> {
                    if (!finishingCapture) failCapture("CAPTURE_REFERENCE_LOST",
                        "The scan's tracking reference was lost. Your photos are kept; start a new scan.");
                });
            }
            return;
        }
        if (camera.getTrackingState() != TrackingState.TRACKING) {
            trackingInterrupted = true;
            visualRecoveryStartedAt = 0;
            TrackingFailureReason reason = camera.getTrackingFailureReason();
            boolean lowTexture = reason == TrackingFailureReason.INSUFFICIENT_FEATURES ||
                reason == TrackingFailureReason.NONE;
            if (publishInertialGuidance(frame, camera, projection, sensorSample, lowTexture,
                reason == TrackingFailureReason.INSUFFICIENT_LIGHT
                    ? "More light is needed — your photos are saved"
                    : "Slow down and keep the lens in one spot")) return;
            cameraReady = false;
            captureGate.pauseTracking();
            resetBestFrameWindow();
            waitingForCameraImage = false;
            recordCaptureDiagnostic("trackingPaused", null, -1, Float.NaN,
                camera.getTrackingFailureReason().name());
            publishTrackingState(camera, projection);
            return;
        }

        if (captureAnchor == null) {
            try {
                // Initial identity rotation keeps the existing gravity/yaw target layout.
                captureAnchor = arSession.createAnchor(camera.getPose().extractTranslation());
            } catch (NotTrackingException notReady) {
                pauseForCaptureAnchor(projection, "Starting the scan — aim at an edge or detail");
                return;
            }
        }
        TrackingState anchorState = captureAnchor.getTrackingState();
        if (anchorState != TrackingState.TRACKING) {
            trackingInterrupted = true;
            visualRecoveryStartedAt = 0;
            PanoramaPose estimate = sensorSample == null ? null :
                rotationBridge.estimate(sensorSample.pose, currentAndroidCameraTimestamp);
            // AR's camera can recover before an old anchor. Replace only that
            // anchor, using a recent calibrated estimate to preserve our original
            // capture coordinates. Never reset the targets or accepted photos.
            if (estimate != null && sensorSample.motionQuiet &&
                reanchorInCaptureCoordinates(cameraToWorld, estimate)) {
                anchorState = captureAnchor.getTrackingState();
            }
            if (anchorState != TrackingState.TRACKING) {
                if (publishInertialGuidance(frame, camera, projection, sensorSample, true, "")) return;
                pauseForCaptureAnchor(projection,
                    "Face a detailed area to recover tracking — your photos are saved");
                return;
            }
        }
        captureAnchor.getPose().toMatrix(anchorToWorld, 0);
        PanoramaPose pose = PanoramaPoseMapping.compose(anchorToCapture,
            PanoramaPose.relativeToAnchor(cameraToWorld, anchorToWorld));
        if (trackingInterrupted && (referenceNeedsVerification || rotationBridge.referenceCameraPose() != null)) {
            PanoramaPose comparison = sensorSample == null ? null :
                rotationBridge.guidance(sensorSample.pose, currentAndroidCameraTimestamp);
            if (comparison == null) {
                // A sensor restart or expired reference cannot silently establish
                // new coordinates after gyro-assisted photos were accepted.
                if (referenceNeedsVerification) {
                    cameraReady = false;
                    runOnUiThread(() -> {
                        if (!finishingCapture) failCapture("CAPTURE_REFERENCE_LOST",
                            "Motion tracking was interrupted for too long. Your original photos are kept; start a fresh scan.");
                    });
                    return;
                }
            } else {
                PanoramaPose estimate = rotationBridge.estimate(sensorSample.pose, currentAndroidCameraTimestamp);
                if (visualRecoveryStartedAt == 0) visualRecoveryStartedAt = frame.getTimestamp();
                // Avoid switching sources on every flicker of visual tracking.
                if (frame.getTimestamp() - visualRecoveryStartedAt < 750_000_000L) {
                    publishInertialGuidance(frame, camera, projection, sensorSample, true, "");
                    return;
                }
                // A large disagreement is not a valid continuation of this sphere.
                // Do not silently snap previously saved directions to a new world.
                if (pose.angularDistanceDegrees(comparison) > (estimate == null ? 3.0f : 8.0f)) {
                    publishInertialGuidance(frame, camera, projection, sensorSample, false,
                        "Tracking shifted — return to the last detailed area to realign");
                    return;
                }
                // Retain the gyro's continuous rotation through a small AR
                // relocalization correction; the same mapping applies thereafter.
                if (estimate != null) {
                    float[] continuous = estimate.transform.clone();
                    System.arraycopy(pose.position, 0, continuous, 12, 3);
                    PanoramaPose desired = PanoramaPose.fromCameraTransform(continuous);
                    anchorToCapture = PanoramaPoseMapping.compose(
                        PanoramaPoseMapping.between(pose, desired), anchorToCapture);
                    pose = desired;
                }
                // Past 30s only a stable, genuinely tracked AR pose agreeing with
                // guidance may resume; expired gyro poses never become photographs.
            }
        }
        trackingInterrupted = false;
        referenceNeedsVerification = false;
        visualRecoveryStartedAt = 0;
        setEstimatedPose(false);
        if (sensorSample != null && currentAndroidCameraTimestamp > lastBridgeCalibrationTimestamp) {
            float[] sensorToWorld = new float[16];
            frame.getAndroidSensorPose().toMatrix(sensorToWorld, 0);
            PanoramaPose sensorInCapture = PanoramaPoseMapping.compose(anchorToCapture,
                PanoramaPose.relativeToAnchor(sensorToWorld, anchorToWorld));
            rotationBridge.calibrate(pose, sensorInCapture, sensorSample.pose, currentAndroidCameraTimestamp);
            lastBridgeCalibrationTimestamp = currentAndroidCameraTimestamp;
        }
        currentCalibrationAgeNanos = 0;
        cameraReady = true;
        currentPose = pose;
        updateGuidance(frame, camera, pose, projection);
    }

    /** Match only a documented real-time camera clock to timestamped sensor history. */
    private PanoramaSensorHistory.Sample sensorForFrame(Frame frame) {
        currentAndroidCameraTimestamp = 0;
        if (!cameraTimestampIsRealtime || rotationSensor == null) return null;
        long generation = rotationSensor.generation();
        if (generation != sensorGeneration) {
            sensorGeneration = generation;
            rotationBridge.reset();
            lastBridgeCalibrationTimestamp = 0;
            resetSteadiness();
        }
        currentAndroidCameraTimestamp = frame.getAndroidCameraTimestamp();
        long age = SystemClock.elapsedRealtimeNanos() - currentAndroidCameraTimestamp;
        if (currentAndroidCameraTimestamp <= 0 || age < 0 || age > 500_000_000L) return null;
        PanoramaSensorHistory.Sample sample = rotationSensor.at(currentAndroidCameraTimestamp);
        if (sample != null && sample.generation != sensorGeneration) {
            sensorGeneration = sample.generation;
            rotationBridge.reset();
            lastBridgeCalibrationTimestamp = 0;
            resetSteadiness();
            return null;
        }
        return sample;
    }

    /** Never let changing pose sources reuse a hold or a pre-transition camera candidate. */
    private void setEstimatedPose(boolean estimated) {
        if (currentPoseEstimated != estimated) resetSteadiness();
        currentPoseEstimated = estimated;
    }

    /** Keeps dots live through blank surfaces, while capture remains bounded and explicit. */
    private boolean publishInertialGuidance(Frame frame, Camera camera, float[] projection,
        PanoramaSensorHistory.Sample sensor, boolean permitCapture, String blockedMessage) {
        if (sensor == null) return false;
        PanoramaPose estimate = rotationBridge.estimate(sensor.pose, currentAndroidCameraTimestamp);
        PanoramaPose guidance = estimate != null ? estimate :
            rotationBridge.guidance(sensor.pose, currentAndroidCameraTimestamp);
        if (guidance == null) return false;
        setEstimatedPose(true);
        currentPose = guidance;
        currentCalibrationAgeNanos = rotationBridge.ageNanos(currentAndroidCameraTimestamp);
        cameraReady = estimate != null && permitCapture && sensor.motionQuiet;
        inertialMessage = estimate == null
            ? "Face a detailed area to refresh gyro guidance — your photos are saved"
            : !permitCapture ? blockedMessage
            : !sensor.motionQuiet ? "Keep the lens in one spot — steady the phone"
            : "Plain surface — gyro assist";
        updateGuidance(frame, camera, guidance, projection);
        return true;
    }

    /** Replaces an unrecoverable/paused AR anchor without changing our sphere's coordinates. */
    private boolean reanchorInCaptureCoordinates(float[] cameraToWorld, PanoramaPose desiredPose) {
        try {
            Anchor replacement = arSession.createAnchor(new com.google.ar.core.Pose(
                new float[] { cameraToWorld[12], cameraToWorld[13], cameraToWorld[14] },
                new float[] { 0, 0, 0, 1 }));
            if (replacement.getTrackingState() != TrackingState.TRACKING) {
                replacement.detach();
                return false;
            }
            float[] replacementToWorld = new float[16];
            replacement.getPose().toMatrix(replacementToWorld, 0);
            PanoramaPose raw = PanoramaPose.relativeToAnchor(cameraToWorld, replacementToWorld);
            PanoramaPose mapping = PanoramaPoseMapping.between(raw, desiredPose);
            if (captureAnchor != null) captureAnchor.detach();
            captureAnchor = replacement;
            anchorToCapture = mapping;
            resetSteadiness();
            Log.i(TAG, "Recovered AR anchor in the existing capture coordinates");
            return true;
        } catch (NotTrackingException notReady) {
            return false;
        }
    }

    private void pauseForCaptureAnchor(float[] projection, String message) {
        cameraReady = false;
        captureGate.pauseTracking();
        resetBestFrameWindow();
        waitingForCameraImage = false;
        recordCaptureDiagnostic("anchorPaused", null, -1, Float.NaN,
            captureAnchor == null ? "INITIALIZING" : captureAnchor.getTrackingState().name());
        publishTrackingMessage(projection, message);
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

    /** Chooses the nearest target, advances its steady hold, and captures when eligible. */
    private void updateGuidance(Frame frame, Camera camera, PanoramaPose pose, float[] projection) {
        PanoramaTarget activeTarget = findNearestUncapturedTarget(pose);
        if (activeTarget == null) {
            resetBestFrameWindow();
            publishGuide(pose, projection, -1, 0.0f, false, true, captureInFlight,
                coverageComplete ? "Capture complete" : "Checking for small gaps…");
            if (!captureInFlight && remainingTargetCount == 0) {
                runOnUiThread(this::finishCaptureSuccessfully);
            }
            return;
        }

        float angularDistance = pose.angularDistanceDegrees(activeTarget);
        alignedTargetIndex = activeTarget.index;
        boolean captureAllowed = cameraReady && !captureInFlight &&
            SystemClock.uptimeMillis() - lastCaptureCompletedAtMillis >= CAPTURE_COOLDOWN_MILLIS;
        PanoramaCaptureGate.Sample sample = captureGate.update(
            pose, frame.getTimestamp(), activeTarget.index, angularDistance,
            options.alignmentDegrees, options.steadyDurationMillis, captureAllowed
        );
        // Hysteresis keeps earned hold at the edge, but that is not capture eligibility.
        // Showing "Hold still" there could wait forever at 100% without taking a photo.
        boolean aligned = sample.withinCaptureZone;
        boolean steady = sample.steady;
        float holdProgress = sample.progress;
        recordCaptureDiagnostic("tracking", sample, activeTarget.index, angularDistance, "");
        long nowMillis = SystemClock.uptimeMillis();
        if (sample.freshFrame || lastFreshCameraFrameAtMillis == 0L) {
            lastFreshCameraFrameAtMillis = nowMillis;
        }
        if (sample.freshFrame && (!aligned || !steady)) {
            waitingForCameraImage = false;
        }
        // A brief motion grace can retain UI progress, but must not retain an image
        // from before that movement. Ranking starts only after this steady segment settles.
        if (bestFrameTargetIndex != activeTarget.index || !captureAllowed ||
            (sample.freshFrame && (!aligned || !steady || holdProgress < bestFramePreviousProgress))) {
            resetBestFrameWindow();
        }
        if (sample.freshFrame && captureAllowed && aligned && steady) {
            if (bestFrameTargetIndex < 0) {
                bestFrameTargetIndex = activeTarget.index;
                bestFrameWindowStartNanos = frame.getTimestamp();
            }
            bestFramePreviousProgress = holdProgress;
            if (sample.readyToCapture || frame.getTimestamp() - bestFrameWindowStartNanos >= BEST_FRAME_SETTLE_NANOS) {
                captureFrame(frame, camera, activeTarget, pose, sample.readyToCapture);
            }
            if (captureInFlight) holdProgress = 0.0f;
        }

        String instruction;
        if (captureInFlight) {
            instruction = "Saving photo…";
        } else if (currentPoseEstimated && !cameraReady) {
            instruction = inertialMessage;
        } else if (!sample.freshFrame && nowMillis - lastFreshCameraFrameAtMillis >= 700L) {
            instruction = "Camera paused — keep the dot centered while it catches up";
        } else if (waitingForCameraImage) {
            instruction = "Waiting for the camera — keep the dot centered";
        } else if (!aligned) {
            instruction = sample.aligned && holdProgress > 0
                ? "Center the dot — your hold is kept"
                : PanoramaCapturePolicy.shouldShowCompletionChevron(remainingTargetCount)
                ? "Follow the arrow to a remaining dot"
                : "Move a dot into the circle";
        } else if (holdProgress > 0.0f && steady) {
            instruction = currentPoseEstimated ? "Plain surface — hold still" : "Hold still";
        } else if (holdProgress > 0.0f) {
            instruction = "Nearly there — steady the phone";
        } else {
            instruction = currentPoseEstimated ? "Gyro assist — steady the phone" : "Steady your Android phone";
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
            message = "Tracking paused — more light will help. Your dots are saved.";
        } else if (reason == TrackingFailureReason.EXCESSIVE_MOTION) {
            message = "Move the phone more slowly";
        } else if (reason == TrackingFailureReason.INSUFFICIENT_FEATURES) {
            message = "Tracking paused — briefly aim at an edge or detail, then return to this dot";
        } else {
            message = currentPose == null ? "Move slowly while tracking starts" :
                "Tracking paused — move slowly. Your dots are saved.";
        }
        publishTrackingMessage(projection, message);
    }

    private void publishTrackingMessage(float[] projection, String message) {
        long now = SystemClock.elapsedRealtimeNanos();
        if (now - lastGuidancePublishedAtNanos < GUIDANCE_INTERVAL_NANOS) {
            return;
        }
        lastGuidancePublishedAtNanos = now;
        PanoramaPose pose = currentPose;
        float[] rotationCopy = (pose == null ? IDENTITY_ROTATION : pose.rotation).clone();
        float[] projectionCopy = projection.clone();
        int pausedTargetIndex = alignedTargetIndex;
        float pausedProgress = PanoramaCapturePolicy.displayedHoldProgress(captureGate.getProgress());
        runOnUiThread(() -> {
            if (finishingCapture) {
                return;
            }
            guideView.updatePose(rotationCopy, projectionCopy, pausedTargetIndex, pausedProgress,
                false, false, captureInFlight, false);
            instructionLabel.setText(coverageCheckInProgress ? "Checking for small gaps…" : message);
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
                PanoramaCapturePolicy.displayedHoldProgress(holdProgress),
                aligned,
                steady,
                capturing,
                true
            );
            instructionLabel.setText(coverageCheckInProgress ? "Checking for small gaps…"
                : SystemClock.uptimeMillis() < retryMessageUntilMillis ? retryMessage
                : SystemClock.uptimeMillis() < savedAcknowledgementUntilMillis
                ? "Photo saved — " + frames.size() + " of " + targets.size()
                : instruction);
        });
    }

    /** Samples one synchronized image; only the unchanged capture gate may trigger saving. */
    private void captureFrame(Frame frame, Camera camera, PanoramaTarget target, PanoramaPose pose, boolean captureNow) {
        if (captureInFlight || target.captured || finishingCapture) {
            return;
        }
        long now = SystemClock.uptimeMillis();
        if (now - lastImageAttemptAtMillis >= IMAGE_RETRY_INTERVAL_MILLIS) {
            lastImageAttemptAtMillis = now;
            imageAttempts++;
            try (Image image = frame.acquireCameraImage()) {
                imagesAcquired++;
                lastCpuImageTimestamp = image.getTimestamp();
                lastImageArTimestamp = frame.getTimestamp();
                lastImageAndroidTimestamp = frame.getAndroidCameraTimestamp();
                boolean clockReady = cameraImageClock.acceptFrame(lastCpuImageTimestamp,
                    lastImageArTimestamp, lastImageAndroidTimestamp,
                    SystemClock.elapsedRealtimeNanos(), cameraTimestampIsRealtime);
                lastImageResult = cameraImageClock.lastDecision();
                if (clockReady) {
                    // acquireCameraImage pairs the pixels with this Frame. ARCore's pose
                    // clock is refined during tracking and need not equal the image clock.
                    ArCapturedImage capturedImage = ArCapturedImage.copyOf(image);
                    CameraIntrinsics intrinsics = camera.getImageIntrinsics();
                    double sharpness = capturedImage.lumaSharpnessScore();
                    CaptureSnapshot candidate = new CaptureSnapshot(
                        frames.size(), target, pose, capturedImage,
                        intrinsics.getFocalLength(), intrinsics.getPrincipalPoint(), intrinsics.getImageDimensions(),
                        frame.getTimestamp(), System.currentTimeMillis(), imageRotationDegrees, sharpness,
                        currentPoseEstimated, lastImageAndroidTimestamp, currentCalibrationAgeNanos,
                        lastCpuImageTimestamp
                    );
                    bestFrameSelector.consider(candidate, sharpness, frame.getTimestamp());
                    imagesAccepted++;
                }
                // Even while a new image warms up, an earlier trusted, fresh candidate
                // may be saved. Never return here before evaluating that candidate.
            } catch (NotYetAvailableException unavailable) {
                lastImageResult = "not_yet_available";
                // An earlier fresh candidate may still be saved at a valid shutter;
                // otherwise preserve hold progress and retry only on a fresh steady frame.
                if (captureNow) waitingForCameraImage = true;
            } catch (PanoramaYuv.UnsupportedColorSpaceException unsupported) {
                lastImageResult = "unsupported_color_space";
                // A permanent format mismatch must not become an endless hold/retry loop.
                unsupportedColorReported = true;
                cameraReady = false;
                captureGate.reset();
                resetBestFrameWindow();
                waitingForCameraImage = false;
                Log.e(TAG, "Unsupported AR camera data space: " + unsupported.dataSpace);
                runOnUiThread(() -> {
                    if (!finishingCapture) failCapture("CAMERA_COLOR_UNSUPPORTED",
                        "360 capture cannot use this phone's camera color format. Your original photos are kept.");
                });
                return;
            } catch (Exception error) {
                lastImageResult = "pixel_copy_failed";
                Log.e(TAG, "Unable to copy synchronized AR camera frame", error);
                captureGate.reset();
                resetBestFrameWindow();
                waitingForCameraImage = false;
                publishCaptureRetry("Couldn't read that camera frame. Keep holding still.");
                return;
            }
        }
        CaptureSnapshot snapshot = bestFrameSelector.best(frame.getTimestamp());
        waitingForCameraImage = captureNow && snapshot == null;
        if (!captureNow || snapshot == null || snapshot.target != target) return;
        captureInFlight = true;
        captureGate.reset();
        resetBestFrameWindow();
        waitingForCameraImage = false;
        try {
            imageExecutor.execute(() -> encodeCapturedFrame(snapshot));
        } catch (RejectedExecutionException error) {
            captureInFlight = false;
            Log.w(TAG, "Image encoding was rejected during activity shutdown", error);
            publishCaptureRetry("The camera couldn't save yet. Keep this dot centered to retry.");
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
            encoded.sourceImageWidth,
            encoded.sourceImageHeight,
            encoded.sourceCropLeft,
            encoded.sourceCropTop,
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
        frame.put("sharpnessScore", snapshot.sharpnessScore);
        frame.put("frameSelection", "sharpestSynchronizedSteadyFrame");
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
        frame.put("intrinsicsSource", "arcoreImageIntrinsics+crop+uprightRotation");
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
        frame.put("sourceImageWidth", encoded.sourceImageWidth);
        frame.put("sourceImageHeight", encoded.sourceImageHeight);
        frame.put("sourceCropLeft", encoded.sourceCropLeft);
        frame.put("sourceCropTop", encoded.sourceCropTop);
        frame.put("sourceDataSpace", encoded.sourceDataSpace);
        frame.put("yuvColorConversion", encoded.yuvColorConversion);
        frame.put("jpegEncodingPasses", 1);
        frame.put("captureInterfaceOrientation", "portrait");
        frame.put("trackingState", snapshot.inertialPose ? "inertialEstimated" : "normal");
        frame.put("poseSource", snapshot.inertialPose
            ? "gameRotationVector+calibratedCaptureAnchor" : "arcoreDisplayOrientedPose+captureAnchor");
        frame.put("coordinateFrameId", sessionId);
        frame.put("translationAvailable", !snapshot.inertialPose);
        frame.put("androidCameraTimestampNanos", snapshot.androidCameraTimestampNanos);
        frame.put("cpuImageTimestampNanos", snapshot.cpuImageTimestampNanos);
        frame.put("imageToAndroidClockOffsetNanos", snapshot.cpuImageTimestampNanos - snapshot.androidCameraTimestampNanos);
        frame.put("imageFrameAssociation", "arcoreFrame.acquireCameraImage+coherentExposureClocks");
        if (snapshot.inertialPose) frame.put("inertialCalibrationAgeMs", snapshot.calibrationAgeNanos / 1_000_000L);
        frame.put("poseTimestamp", (snapshot.inertialPose
            ? snapshot.androidCameraTimestampNanos : snapshot.frameTimestampNanos) / 1_000_000_000.0);
        frame.put("poseTimestampClock", snapshot.inertialPose ? "androidCameraRealtime" : "arcoreFrame");
        return frame;
    }

    /** Backward-compatible whole-image calibration used by existing callers/tests. */
    static double[] adjustedIntrinsics(
        float[] focalLength, float[] principalPoint, int[] intrinsicDimensions,
        int sourceWidth, int sourceHeight, int rotationDegrees, int outputWidth, int outputHeight
    ) {
        return adjustedIntrinsics(focalLength, principalPoint, intrinsicDimensions,
            sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight,
            rotationDegrees, outputWidth, outputHeight);
    }

    /** Crop origin is removed before rotating/scaling into the upright JPEG. */
    static double[] adjustedIntrinsics(
        float[] focalLength, float[] principalPoint, int[] intrinsicDimensions,
        int imageWidth, int imageHeight, int cropLeft, int cropTop, int cropWidth, int cropHeight,
        int rotationDegrees, int outputWidth, int outputHeight
    ) {
        return PanoramaImageCalibration.adjustedIntrinsics(focalLength, principalPoint, intrinsicDimensions,
            imageWidth, imageHeight, cropLeft, cropTop, cropWidth, cropHeight,
            rotationDegrees, outputWidth, outputHeight);
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
        if (!encodedImage.isFile() || encodedImage.length() == 0L) {
            recoverFromFrameFailure("The photo wasn't saved. Keep this dot centered to retry.");
            return;
        }
        target.captured = true;
        frames.add(metadata);
        boolean previouslyUsedInertialFrames = usedInertialFrames;
        usedInertialFrames |= !metadata.optBoolean("translationAvailable", true);
        try {
            writeMetadata(buildResultJson(), "inProgress");
        } catch (IOException | JSONException error) {
            // A dot is not completed until both its JPEG and recovery metadata are durable.
            frames.remove(frames.size() - 1);
            target.captured = false;
            usedInertialFrames = previouslyUsedInertialFrames;
            Log.e(TAG, "Cannot persist accepted frame metadata", error);
            recoverFromFrameFailure("Storage couldn't save this dot. Free some space, then try again.");
            return;
        }
        remainingTargetCount = targets.size() - frames.size();
        if (!metadata.optBoolean("translationAvailable", true)) referenceNeedsVerification = true;
        lastCaptureCompletedAtMillis = SystemClock.uptimeMillis();
        // Publish completion last; the GL thread treats this volatile flag as
        // the handoff barrier for the accepted frame and its cooldown state.
        captureInFlight = false;
        guideView.pulseCapture();
        savedAcknowledgementUntilMillis = SystemClock.uptimeMillis() + SAVED_ACKNOWLEDGEMENT_MILLIS;
        retryMessageUntilMillis = 0L;
        guideView.setContentDescription(
            String.format(Locale.US, "Guided panorama capture, %d of %d frames captured", frames.size(), targets.size())
        );
        updateProgressInterface();
        instructionLabel.setText("Photo saved — " + frames.size() + " of " + targets.size());
        if (frames.size() == targets.size()) {
            finishCaptureSuccessfully();
        }
    }

    /** Shows a transient CPU-image retry without changing accepted frame state. */
    private void publishCaptureRetry(String message) {
        runOnUiThread(() -> {
            if (!finishingCapture) {
                showCaptureRetry(message);
            }
        });
    }

    /** Bounded, local-only telemetry makes a stuck hold diagnosable without recording video. */
    private void recordCaptureDiagnostic(String state, PanoramaCaptureGate.Sample sample,
                                         int target, float angle, String reason) {
        long now = SystemClock.uptimeMillis();
        if (now - lastDiagnosticAtMillis < 500) return;
        lastDiagnosticAtMillis = now;
        try {
            JSONObject entry = new JSONObject().put("elapsedMs", now).put("state", state)
                .put("target", target).put("trackingReason", reason)
                .put("waitingForImage", waitingForCameraImage).put("captureInFlight", captureInFlight)
                .put("inertialPose", currentPoseEstimated).put("captureAllowed", cameraReady)
                .put("inertialCalibrationAgeMs", currentCalibrationAgeNanos / 1_000_000L)
                .put("cameraTimestampIsRealtime", cameraTimestampIsRealtime)
                .put("imageResult", lastImageResult).put("imageClockDecision", cameraImageClock.lastDecision())
                .put("imageAttempts", imageAttempts).put("imagesAcquired", imagesAcquired)
                .put("imagesAccepted", imagesAccepted)
                .put("cpuImageTimestampNanos", lastCpuImageTimestamp)
                .put("imageArTimestampNanos", lastImageArTimestamp)
                .put("imageAndroidTimestampNanos", lastImageAndroidTimestamp);
            if (Float.isFinite(angle)) entry.put("angleDegrees", angle);
            if (sample != null) {
                entry.put("freshFrame", sample.freshFrame).put("withinCaptureZone", sample.withinCaptureZone)
                    .put("latchedAligned", sample.aligned).put("steady", sample.steady)
                    .put("ready", sample.readyToCapture).put("progress", sample.progress);
                if (Float.isFinite(sample.angularSpeed)) entry.put("angularSpeedRadians", sample.angularSpeed);
                if (Float.isFinite(sample.linearSpeed)) entry.put("linearSpeedMeters", sample.linearSpeed);
                if (Float.isFinite(sample.smoothedAngularSpeed)) entry.put("smoothedAngularSpeed", sample.smoothedAngularSpeed);
                if (Float.isFinite(sample.smoothedLinearSpeed)) entry.put("smoothedLinearSpeed", sample.smoothedLinearSpeed);
            }
            synchronized (captureDiagnostics) {
                if (captureDiagnostics.size() >= 120) captureDiagnostics.removeFirst();
                captureDiagnostics.addLast(entry);
            }
        } catch (JSONException ignored) { /* Diagnostics must never prevent a photograph. */ }
    }

    /** Keeps camera errors readable instead of replacing them on the next preview frame. */
    private void showCaptureRetry(String message) {
        retryMessage = message;
        retryMessageUntilMillis = SystemClock.uptimeMillis() + 1500L;
        instructionLabel.setText(message);
    }

    /** Resets target hold state after encoding fails so the same direction can be retried. */
    private void recoverFromFrameFailure(String message) {
        if (finishingCapture || isFinishing()) {
            return;
        }
        // The gate belongs to GL; request its reset before releasing the worker barrier.
        gateResetRequested = true;
        showCaptureRetry(message);
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
            // Latch the dot the user is working on through a small edge tremor.
            if (target.index == alignedTargetIndex && distance <= options.alignmentDegrees + 1.5f) {
                return target;
            }
            if (distance < nearestDistance) {
                nearest = target;
                nearestDistance = distance;
            }
        }
        return nearest;
    }

    /** Resets motion history whenever tracking or rendering continuity is lost. */
    private void resetSteadiness() {
        captureGate.reset();
        resetBestFrameWindow();
        waitingForCameraImage = false;
        lastImageAttemptAtMillis = 0L;
        lastFreshCameraFrameAtMillis = 0L;
        alignedTargetIndex = -1;
    }

    private void resetBestFrameWindow() {
        bestFrameSelector.reset();
        bestFrameTargetIndex = -1;
        bestFrameWindowStartNanos = 0L;
        bestFramePreviousProgress = 0.0f;
    }

    /** Atomically writes final metadata and returns the completed session to Capacitor. */
    private void finishCaptureSuccessfully() {
        if (finishingCapture || frames.size() != targets.size() || captureInFlight) {
            return;
        }
        if (!coverageComplete) {
            checkCapturedCoverage();
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

    /** Checks accepted camera footprints, not intended dot positions, without blocking preview. */
    private void checkCapturedCoverage() {
        if (coverageCheckInProgress || finishingCapture) return;
        final ArrayList<PanoramaCoveragePlanner.Frame> accepted = new ArrayList<>();
        try {
            for (JSONObject frame : frames) {
                JSONArray calibration = frame.getJSONArray("intrinsics");
                JSONArray pose = frame.getJSONArray("transform");
                double[] intrinsics = new double[9];
                float[] transform = new float[16];
                for (int i = 0; i < intrinsics.length; i++) intrinsics[i] = calibration.getDouble(i);
                for (int i = 0; i < transform.length; i++) transform[i] = (float) pose.getDouble(i);
                accepted.add(new PanoramaCoveragePlanner.Frame(frame.getInt("width"), frame.getInt("height"),
                    intrinsics, transform));
            }
        } catch (Exception error) {
            Log.e(TAG, "Cannot inspect accepted camera coverage", error);
            failCapture("COVERAGE_CHECK_FAILED", "Your original photos are kept, but camera coverage could not be checked. Please start a new scan.");
            return;
        }
        coverageCheckInProgress = true;
        captureInFlight = true;
        instructionLabel.setText("Checking for small gaps…");
        try {
            imageExecutor.execute(() -> {
                try {
                    PanoramaCoveragePlanner.Plan plan = PanoramaCoveragePlanner.plan(accepted,
                        PanoramaCoveragePlanner.MAX_EXTRA_TARGETS,
                        () -> finishingCapture || Thread.currentThread().isInterrupted());
                    runOnUiThread(() -> acceptCoveragePlan(plan));
                } catch (Exception | OutOfMemoryError error) {
                    Log.e(TAG, "Cannot plan remaining camera coverage", error);
                    runOnUiThread(() -> {
                        if (!finishingCapture) failCapture("COVERAGE_CHECK_FAILED",
                            "Your original photos are kept. The phone could not finish checking this scan; please try again.");
                    });
                }
            });
        } catch (RejectedExecutionException error) {
            coverageCheckInProgress = false;
            captureInFlight = false;
            failCapture("COVERAGE_CHECK_FAILED", "Your original photos are kept. Reopen the camera to try again.");
        }
    }

    /** Publishes fill targets atomically so GL never iterates a mutating target list. */
    private void acceptCoveragePlan(PanoramaCoveragePlanner.Plan plan) {
        if (finishingCapture || isFinishing()) return;
        coverageCheckInProgress = false;
        if (plan.cancelled) {
            failCapture("COVERAGE_CHECK_FAILED", "The coverage check was interrupted. Your original photos are kept.");
            return;
        }
        observedCoverage = plan.initialCoverage;
        if (plan.extraTargets.isEmpty()) {
            coverageComplete = plan.pixelGapFraction == 0;
            captureInFlight = false;
            if (coverageComplete) finishCaptureSuccessfully();
            else failCapture("COVERAGE_INCOMPLETE", "Some directions are still missing. Your originals are kept. Start a new scan, keeping the camera in one spot as you turn.");
            return;
        }
        ArrayList<PanoramaTarget> expanded = new ArrayList<>(targets);
        for (PanoramaCoveragePlanner.Target target : plan.extraTargets) {
            addTarget(expanded, target.yawDegrees, target.pitchDegrees);
        }
        targets = expanded;
        remainingTargetCount = targets.size() - frames.size();
        try {
            writeMetadata(buildResultJson(), "inProgress");
        } catch (IOException | JSONException error) {
            failCapture("CAPTURE_FAILED", "The extra capture directions could not be saved. Your original photos are kept.");
            return;
        }
        guideView.setTargets(targets);
        updateProgressInterface();
        savedAcknowledgementUntilMillis = 0;
        retryMessage = "Fill " + remainingTargetCount + " small gaps — follow the arrows, keeping the phone upright";
        retryMessageUntilMillis = SystemClock.uptimeMillis() + 4500;
        instructionLabel.setText(retryMessage);
        gateResetRequested = true;
        captureInFlight = false;
    }

    /** Builds the bridge result from accepted frames without reading in-flight work. */
    private JSONObject buildResultJson() throws JSONException {
        JSONObject result = new JSONObject();
        result.put("sessionId", sessionId);
        result.put("ownerKey", captureOwnerKey);
        result.put("createdAt", captureCreatedAt);
        result.put("mode", options.mode);
        result.put("directoryUrl", Uri.fromFile(sessionDirectory).toString());
        result.put("targetCount", targets.size());
        result.put("initialTargetCount", initialTargetCount);
        result.put("coverageComplete", coverageComplete);
        result.put("observedCoverage", observedCoverage);
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
        manifest.put("poseSource", usedInertialFrames
            ? "arcore+calibratedInertialFallback" : "arcoreDisplayOrientedPose+captureAnchor");
        manifest.put("coordinateFrameId", sessionId);
        manifest.put("translationAvailable", !usedInertialFrames);
        manifest.put("outputWidth", options.outputWidth);
        manifest.put("jpegQuality", options.jpegQuality);
        manifest.put("alignmentDegrees", options.alignmentDegrees);
        manifest.put("steadyDurationMs", options.steadyDurationMillis);
        JSONArray diagnostics = new JSONArray();
        synchronized (captureDiagnostics) {
            for (JSONObject entry : captureDiagnostics) diagnostics.put(entry);
        }
        manifest.put("recentCaptureDiagnostics", diagnostics);

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

        PanoramaCaptureStore.writeJson(new File(sessionDirectory, "metadata.json"), manifest);
    }

    /** Returns cancellation without discarding photographs already accepted by the camera. */
    private void cancelCapture() {
        if (finishingCapture) {
            return;
        }
        finishingCapture = true;
        writeMetadataSnapshot("interrupted");
        Intent data = new Intent();
        data.putExtra(EXTRA_ERROR_CODE, "CAPTURE_CANCELLED");
        data.putExtra(EXTRA_ERROR_MESSAGE, "Panorama capture was cancelled.");
        setResult(Activity.RESULT_CANCELED, data);
        finish();
    }

    /** Returns a terminal camera error while retaining all accepted original photos. */
    private void failCapture(String code, String message) {
        if (finishingCapture && isFinishing()) {
            return;
        }
        finishingCapture = true;
        writeMetadataSnapshot("interrupted");
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
            // The recovery list can find this manifest after activity/process restart.
            writeMetadataSnapshot("interrupted");
        }
        // Destruction without finish() (for example OS recreation) must also invalidate
        // queued encode/coverage callbacks before they can publish into this old Activity.
        finishingCapture = true;
        if (captureAnchor != null) {
            captureAnchor.detach();
            captureAnchor = null;
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
        final double sharpnessScore;
        final boolean inertialPose;
        final long androidCameraTimestampNanos;
        final long calibrationAgeNanos;
        final long cpuImageTimestampNanos;

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
            int rotationDegrees,
            double sharpnessScore,
            boolean inertialPose,
            long androidCameraTimestampNanos,
            long calibrationAgeNanos,
            long cpuImageTimestampNanos
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
            this.sharpnessScore = sharpnessScore;
            this.inertialPose = inertialPose;
            this.androidCameraTimestampNanos = androidCameraTimestampNanos;
            this.calibrationAgeNanos = calibrationAgeNanos;
            this.cpuImageTimestampNanos = cpuImageTimestampNanos;
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
