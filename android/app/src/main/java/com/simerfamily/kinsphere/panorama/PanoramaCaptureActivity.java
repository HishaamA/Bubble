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

    public static final String EXTRA_OPTIONS_JSON = "panoramaCaptureOptions";
    public static final String EXTRA_RESULT_JSON = "panoramaCaptureResult";
    public static final String EXTRA_ERROR_CODE = "panoramaCaptureErrorCode";
    public static final String EXTRA_ERROR_MESSAGE = "panoramaCaptureErrorMessage";

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

    private void initializeCapture() {
        options = CaptureOptions.fromJson(getIntent().getStringExtra(EXTRA_OPTIONS_JSON));
        targets = createTargets(options.mode);
        sessionId = UUID.randomUUID().toString();
        capturesRoot = new File(getCacheDir(), "panorama_captures");
        sessionDirectory = new File(capturesRoot, sessionId);
        if ((!capturesRoot.exists() && !capturesRoot.mkdirs()) || !sessionDirectory.mkdirs()) {
            failCapture("CAPTURE_FAILED", "The panorama capture directory could not be created.");
            return;
        }

        imageExecutor = Executors.newSingleThreadExecutor();
        captureSurfaceRotation = getWindowManager().getDefaultDisplay().getRotation();
        buildCaptureInterface();
        guideView.setTargets(targets);
        updateProgressInterface();
        writeMetadataSnapshot("inProgress");

        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    cancelCapture();
                }
            }
        );
    }

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
                headerParams.leftMargin = Math.max(Math.round(14.0f * density), safeInsets.left + Math.round(14.0f * density));
                headerParams.rightMargin = Math.max(Math.round(14.0f * density), safeInsets.right + Math.round(14.0f * density));
                headerParams.topMargin = Math.max(Math.round(12.0f * density), safeInsets.top + Math.round(8.0f * density));
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

    private static FrameLayout.LayoutParams matchParentLayout() {
        return new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        );
    }

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

    @Override
    protected void onPause() {
        cameraReady = false;
        resetSteadiness();
        if (surfaceView != null) {
            surfaceView.onPause();
        }
        if (arSession != null && sessionResumed) {
            arSession.pause();
            sessionResumed = false;
        }
        super.onPause();
    }

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
        PanoramaPose pose = PanoramaPose.fromCameraTransform(cameraToWorld, frame.getTimestamp());
        currentPose = pose;
        boolean steady = updateMotion(pose, frame.getTimestamp());
        updateGuidance(frame, camera, pose, projection, steady);
    }

    @Override
    public void onFailure(Exception error) {
        runOnUiThread(() -> {
            if (!finishingCapture) {
                failCapture("CAPTURE_FAILED", "The AR capture session stopped. Reopen the camera and try again.");
            }
        });
    }

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
            instruction = PanoramaCapturePolicy.shouldShowCompletionChevron(remainingTargetCount())
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
            guideView.updatePose(rotationCopy, projectionCopy, -1, 0.0f, false, false, false);
            instructionLabel.setText(message);
        });
    }

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

    private void captureFrame(Frame frame, Camera camera, PanoramaTarget target, PanoramaPose pose) {
        if (captureInFlight || target.captured || finishingCapture) {
            return;
        }

        final ArCapturedImage capturedImage;
        try (Image image = frame.acquireCameraImage()) {
            capturedImage = ArCapturedImage.copyOf(image);
        } catch (NotYetAvailableException unavailable) {
            return;
        } catch (Exception error) {
            Log.e(TAG, "Unable to copy synchronized AR camera frame", error);
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
        imageExecutor.execute(() -> encodeCapturedFrame(snapshot));
    }

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
            runOnUiThread(() -> acceptCapturedFrame(snapshot.target, metadata));
        } catch (Exception error) {
            Log.e(TAG, "Unable to encode synchronized AR panorama frame", error);
            deleteFileQuietly(output);
            runOnUiThread(() -> recoverFromFrameFailure(
                "Couldn't save that frame. Hold the target and try again."
            ));
        }
    }

    private JSONObject buildFrameMetadata(CaptureSnapshot snapshot, ArCapturedImage.EncodedFrame encoded) throws JSONException {
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
        frame.put("horizontalFovDegrees", fieldOfViewDegrees(uprightIntrinsics[0], uprightIntrinsics[2], encoded.width));
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
        double referenceWidth = Math.max(1, intrinsicDimensions[0]);
        double referenceHeight = Math.max(1, intrinsicDimensions[1]);
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

        if (rotationDegrees == 90) {
            fx = rawFy;
            fy = rawFx;
            cx = sourceHeight - 1.0 - rawCy;
            cy = rawCx;
            uprightWidth = sourceHeight;
            uprightHeight = sourceWidth;
        } else if (rotationDegrees == 180) {
            fx = rawFx;
            fy = rawFy;
            cx = sourceWidth - 1.0 - rawCx;
            cy = sourceHeight - 1.0 - rawCy;
            uprightWidth = sourceWidth;
            uprightHeight = sourceHeight;
        } else if (rotationDegrees == 270) {
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

        double outputScaleX = outputWidth / (double) Math.max(1, uprightWidth);
        double outputScaleY = outputHeight / (double) Math.max(1, uprightHeight);
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

    private void acceptCapturedFrame(PanoramaTarget target, JSONObject metadata) {
        if (finishingCapture || isFinishing()) {
            return;
        }
        target.captured = true;
        frames.add(metadata);
        captureInFlight = false;
        lastCaptureCompletedAtMillis = SystemClock.uptimeMillis();
        alignedTargetIndex = -1;
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

    private void publishCaptureRetry(String message) {
        runOnUiThread(() -> {
            resetHoldWindow();
            instructionLabel.setText(message);
        });
    }

    private void recoverFromFrameFailure(String message) {
        if (finishingCapture || isFinishing()) {
            return;
        }
        captureInFlight = false;
        alignedTargetIndex = -1;
        resetHoldWindow();
        instructionLabel.setText(message);
    }

    private void updateProgressInterface() {
        if (progressLabel == null) {
            return;
        }
        progressLabel.setText(String.format(Locale.US, "%d / %d", frames.size(), targets.size()));
        progressBar.setMax(targets.size());
        progressBar.setProgress(frames.size(), true);
    }

    private PanoramaTarget findNearestUncapturedTarget(PanoramaPose pose) {
        PanoramaTarget nearest = null;
        float nearestDistance = Float.POSITIVE_INFINITY;
        for (PanoramaTarget target : targets) {
            if (target.captured) continue;
            float distance = pose.angularDistanceDegrees(target);
            if (distance < nearestDistance) {
                nearest = target;
                nearestDistance = distance;
            }
        }
        return nearest;
    }

    private int remainingTargetCount() {
        int remaining = 0;
        for (PanoramaTarget target : targets) {
            if (!target.captured) remaining += 1;
        }
        return remaining;
    }

    private void startHoldWindow(PanoramaPose pose, long timestampNanos) {
        holdStartPose = pose;
        alignedSinceNanos = timestampNanos;
    }

    private void resetHoldWindow() {
        holdStartPose = null;
        alignedSinceNanos = -1L;
    }

    private void resetSteadiness() {
        previousPose = null;
        previousFrameTimestampNanos = 0L;
        smoothedAngularSpeed = Float.POSITIVE_INFINITY;
        smoothedLinearSpeed = Float.POSITIVE_INFINITY;
        resetHoldWindow();
        alignedTargetIndex = -1;
    }

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

    private JSONObject buildResultJson() throws JSONException {
        JSONObject result = new JSONObject();
        result.put("sessionId", sessionId);
        result.put("mode", options.mode);
        result.put("directoryUrl", Uri.fromFile(sessionDirectory).toString());
        result.put("targetCount", targets.size());
        result.put("capturedCount", frames.size());
        result.put("requiresStitching", true);
        JSONArray frameArray = new JSONArray();
        for (JSONObject frame : frames) frameArray.put(frame);
        result.put("frames", frameArray);
        return result;
    }

    private void writeMetadataSnapshot(String state) {
        if (sessionDirectory == null || !sessionDirectory.exists()) return;
        try {
            writeMetadata(buildResultJson(), state);
        } catch (Exception error) {
            Log.w(TAG, "Unable to update panorama metadata.json", error);
        }
    }

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

    private void cancelCapture() {
        if (finishingCapture) return;
        finishingCapture = true;
        cleanupCancelledSession();
        Intent data = new Intent();
        data.putExtra(EXTRA_ERROR_CODE, "CAPTURE_CANCELLED");
        data.putExtra(EXTRA_ERROR_MESSAGE, "Panorama capture was cancelled.");
        setResult(Activity.RESULT_CANCELED, data);
        finish();
    }

    private void failCapture(String code, String message) {
        if (finishingCapture && isFinishing()) return;
        finishingCapture = true;
        cleanupCancelledSession();
        Intent data = new Intent();
        data.putExtra(EXTRA_ERROR_CODE, code);
        data.putExtra(EXTRA_ERROR_MESSAGE, message);
        setResult(Activity.RESULT_CANCELED, data);
        finish();
    }

    private void cleanupCancelledSession() {
        if (sessionDirectory != null && capturesRoot != null && capturesRoot.equals(sessionDirectory.getParentFile())) {
            deleteRecursively(sessionDirectory);
        }
    }

    @Override
    protected void onDestroy() {
        if (arSession != null) {
            arSession.close();
            arSession = null;
        }
        if (imageExecutor != null) imageExecutor.shutdown();
        super.onDestroy();
    }

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

    private static void addRing(List<PanoramaTarget> targets, double pitch, int count, double firstYaw, double yawStep) {
        for (int index = 0; index < count; index++) {
            addTarget(targets, firstYaw + index * yawStep, pitch);
        }
    }

    private static void addTarget(List<PanoramaTarget> targets, double yaw, double pitch) {
        targets.add(new PanoramaTarget(targets.size(), yaw, pitch));
    }

    private static JSONObject vectorJson(float[] vector) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("x", vector[0]);
        json.put("y", vector[1]);
        json.put("z", vector[2]);
        return json;
    }

    private static JSONObject quaternionJson(float[] quaternion) throws JSONException {
        JSONObject json = vectorJson(quaternion);
        json.put("w", quaternion[3]);
        return json;
    }

    private static JSONArray floatArrayToJson(float[] values) throws JSONException {
        JSONArray array = new JSONArray();
        for (float value : values) array.put(value);
        return array;
    }

    private static JSONArray doubleArrayToJson(double[] values) throws JSONException {
        JSONArray array = new JSONArray();
        for (double value : values) array.put(value);
        return array;
    }

    private static double fieldOfViewDegrees(double focalLength, double principalPoint, int pixelCount) {
        if (focalLength <= 0.0 || pixelCount <= 1) return 0.0;
        double negativeExtent = Math.max(0.0, principalPoint);
        double positiveExtent = Math.max(0.0, pixelCount - 1.0 - principalPoint);
        return Math.toDegrees(Math.atan(negativeExtent / focalLength) + Math.atan(positiveExtent / focalLength));
    }

    private static int surfaceRotationDegrees(int rotation) {
        if (rotation == Surface.ROTATION_90) return 90;
        if (rotation == Surface.ROTATION_180) return 180;
        if (rotation == Surface.ROTATION_270) return 270;
        return 0;
    }

    private static String modeDisplayName(String mode) {
        if ("quick".equals(mode)) return "Quick";
        if ("detailed".equals(mode)) return "Detailed";
        return "Standard";
    }

    private static String iso8601(long timestampMillis) {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date(timestampMillis));
    }

    private static void copyFile(File source, File destination) throws IOException {
        byte[] buffer = new byte[32 * 1024];
        try (FileInputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(destination)) {
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
    }

    private static void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursively(child);
            }
        }
        deleteFileQuietly(file);
    }

    private static void deleteFileQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            Log.w(TAG, "Unable to delete " + file.getAbsolutePath());
        }
    }

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

    private static final class CaptureOptions {
        final String mode;
        final int outputWidth;
        final double jpegQuality;
        final int jpegQualityPercent;
        final float alignmentDegrees;
        final long steadyDurationMillis;

        private CaptureOptions(String mode, int outputWidth, double jpegQuality, float alignmentDegrees, long steadyDurationMillis) {
            this.mode = mode;
            this.outputWidth = outputWidth;
            this.jpegQuality = jpegQuality;
            this.jpegQualityPercent = (int) Math.round(jpegQuality * 100.0);
            this.alignmentDegrees = alignmentDegrees;
            this.steadyDurationMillis = steadyDurationMillis;
        }

        static CaptureOptions fromJson(@Nullable String json) {
            JSONObject object;
            try {
                object = json == null ? new JSONObject() : new JSONObject(json);
            } catch (JSONException ignored) {
                object = new JSONObject();
            }
            String mode = object.optString("mode", "standard").toLowerCase(Locale.US);
            if (!"quick".equals(mode) && !"standard".equals(mode) && !"detailed".equals(mode)) mode = "standard";
            int requestedWidth = object.optInt("outputWidth", 0);
            int outputWidth = requestedWidth <= 0 ? 0 : clamp(requestedWidth, 640, 4096);
            double jpegQuality = clamp(object.optDouble("jpegQuality", 0.92), 0.5, 1.0);
            float alignment = (float) clamp(object.optDouble("alignmentDegrees", 4.5), 2.0, 12.0);
            long steadyDuration = Math.round(clamp(object.optDouble("steadyDurationMs", 650.0), 300.0, 2000.0));
            return new CaptureOptions(mode, outputWidth, jpegQuality, alignment, steadyDuration);
        }

        private static int clamp(int value, int minimum, int maximum) {
            return Math.max(minimum, Math.min(maximum, value));
        }

        private static double clamp(double value, double minimum, double maximum) {
            return Math.max(minimum, Math.min(maximum, value));
        }
    }
}
