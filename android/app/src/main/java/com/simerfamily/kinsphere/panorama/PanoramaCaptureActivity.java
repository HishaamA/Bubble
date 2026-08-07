package com.simerfamily.kinsphere.panorama;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.drawable.GradientDrawable;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraCharacteristics;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.AppCompatButton;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.exifinterface.media.ExifInterface;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
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
 * Full-screen CameraX capture surface with rotation-vector target guidance.
 *
 * <p>The tracker supplies orientation only. Translation is intentionally emitted
 * as zero with {@code trackingState: "orientationOnly"}; downstream stitching
 * code must not mistake this for ARCore six-degree-of-freedom tracking.</p>
 */
public final class PanoramaCaptureActivity extends AppCompatActivity implements SensorEventListener {

    public static final String EXTRA_OPTIONS_JSON = "panoramaCaptureOptions";
    public static final String EXTRA_RESULT_JSON = "panoramaCaptureResult";
    public static final String EXTRA_ERROR_CODE = "panoramaCaptureErrorCode";
    public static final String EXTRA_ERROR_MESSAGE = "panoramaCaptureErrorMessage";

    private static final String TAG = "PanoramaCapture";
    private static final float MAX_STEADY_ANGULAR_SPEED_DEGREES = 5.5f;
    private static final long MIN_CAPTURE_GAP_MILLIS = 350L;
    private static final float[] IDENTITY_ROTATION = {
        1.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 1.0f,
    };

    private final ArrayList<JSONObject> frames = new ArrayList<>();
    private final float[] rawSensorRotation = new float[9];
    private final float[] absoluteRotation = new float[9];
    private final float[] previousAbsoluteRotation = new float[9];

    private CaptureOptions options;
    private String sessionId;
    private File capturesRoot;
    private File sessionDirectory;
    private List<PanoramaTarget> targets;
    private PreviewView previewView;
    private PanoramaGuideView guideView;
    private TextView progressLabel;
    private TextView instructionLabel;
    private AppCompatButton doneButton;
    private ImageCapture imageCapture;
    private ProcessCameraProvider cameraProvider;
    private ExecutorService cameraExecutor;
    private SensorManager sensorManager;
    private Sensor rotationSensor;
    private Sensor gyroscopeSensor;
    private float[] baselineRotation;
    private PanoramaPose currentPose;
    private CameraCalibration cameraCalibration = CameraCalibration.unavailable();
    private long previousRotationTimestampNanos;
    private long alignedSinceNanos = -1L;
    private long lastCaptureCompletedAtMillis;
    private int alignedTargetIndex = -1;
    private int captureSurfaceRotation = Surface.ROTATION_0;
    private float angularSpeedDegrees = Float.POSITIVE_INFINITY;
    private boolean sensorListenersRegistered;
    private boolean cameraReady;
    private boolean captureInFlight;
    private boolean finishingCapture;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureFullscreenWindow();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            failCapture("PERMISSION_DENIED", "Camera permission is required for panorama capture.");
            return;
        }

        options = CaptureOptions.fromJson(getIntent().getStringExtra(EXTRA_OPTIONS_JSON));
        targets = createTargets(options.mode);
        sessionId = UUID.randomUUID().toString();
        capturesRoot = new File(getCacheDir(), "panorama_captures");
        sessionDirectory = new File(capturesRoot, sessionId);
        if ((!capturesRoot.exists() && !capturesRoot.mkdirs()) || !sessionDirectory.mkdirs()) {
            failCapture("CAPTURE_FAILED", "The panorama capture directory could not be created.");
            return;
        }

        sensorManager = (SensorManager) getSystemService(SENSOR_SERVICE);
        rotationSensor = findRotationSensor(sensorManager);
        gyroscopeSensor = sensorManager == null ? null : sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (rotationSensor == null) {
            failCapture("NOT_SUPPORTED", "This device does not provide a usable rotation-vector sensor.");
            return;
        }

        cameraExecutor = Executors.newSingleThreadExecutor();
        // The Activity is portrait-locked in AndroidManifest. Freeze the actual
        // display transform too (important on natural-landscape tablets) so the
        // CameraX output basis and rotation-vector basis cannot drift apart.
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

        previewView.post(this::startCamera);
    }

    private void configureFullscreenWindow() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    private void buildCaptureInterface() {
        float density = getResources().getDisplayMetrics().density;
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setImplementationMode(PreviewView.ImplementationMode.PERFORMANCE);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        root.addView(
            previewView,
            new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        );

        guideView = new PanoramaGuideView(this);
        root.addView(
            guideView,
            new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        );

        AppCompatButton cancelButton = createPillButton("Cancel", 0xA6000000, Color.WHITE);
        cancelButton.setContentDescription("Cancel panorama capture");
        cancelButton.setOnClickListener(view -> cancelCapture());
        FrameLayout.LayoutParams cancelParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Math.round(44.0f * density),
            Gravity.TOP | Gravity.START
        );
        cancelParams.leftMargin = Math.round(16.0f * density);
        cancelParams.topMargin = Math.round(16.0f * density);
        root.addView(cancelButton, cancelParams);

        doneButton = createPillButton("Done", Color.WHITE, Color.BLACK);
        doneButton.setContentDescription("Finish panorama capture");
        doneButton.setEnabled(false);
        doneButton.setAlpha(0.42f);
        doneButton.setOnClickListener(view -> finishCaptureSuccessfully());
        FrameLayout.LayoutParams doneParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Math.round(44.0f * density),
            Gravity.TOP | Gravity.END
        );
        doneParams.rightMargin = Math.round(16.0f * density);
        doneParams.topMargin = Math.round(16.0f * density);
        root.addView(doneButton, doneParams);

        progressLabel = new TextView(this);
        progressLabel.setTextColor(Color.WHITE);
        progressLabel.setTextSize(13.0f);
        progressLabel.setGravity(Gravity.CENTER);
        progressLabel.setLetterSpacing(0.08f);
        progressLabel.setShadowLayer(5.0f, 0.0f, 1.0f, Color.BLACK);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Math.round(44.0f * density),
            Gravity.TOP | Gravity.CENTER_HORIZONTAL
        );
        progressParams.topMargin = Math.round(16.0f * density);
        root.addView(progressLabel, progressParams);

        instructionLabel = new TextView(this);
        instructionLabel.setTextColor(Color.WHITE);
        instructionLabel.setTextSize(17.0f);
        instructionLabel.setGravity(Gravity.CENTER);
        instructionLabel.setShadowLayer(6.0f, 0.0f, 1.0f, Color.BLACK);
        instructionLabel.setText("Starting camera…");
        FrameLayout.LayoutParams instructionParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            Math.round(64.0f * density),
            Gravity.BOTTOM
        );
        instructionParams.leftMargin = Math.round(28.0f * density);
        instructionParams.rightMargin = Math.round(28.0f * density);
        instructionParams.bottomMargin = Math.round(28.0f * density);
        root.addView(instructionLabel, instructionParams);

        ViewCompat.setOnApplyWindowInsetsListener(
            root,
            (view, windowInsets) -> {
                Insets safeInsets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.systemBars()
                );
                int edge = Math.round(16.0f * density);
                cancelParams.leftMargin = Math.max(edge, safeInsets.left + edge);
                cancelParams.topMargin = Math.max(edge, safeInsets.top + Math.round(8.0f * density));
                doneParams.rightMargin = Math.max(edge, safeInsets.right + edge);
                doneParams.topMargin = cancelParams.topMargin;
                progressParams.topMargin = cancelParams.topMargin;
                instructionParams.bottomMargin = Math.max(
                    Math.round(28.0f * density),
                    safeInsets.bottom + Math.round(20.0f * density)
                );
                cancelButton.setLayoutParams(cancelParams);
                doneButton.setLayoutParams(doneParams);
                progressLabel.setLayoutParams(progressParams);
                instructionLabel.setLayoutParams(instructionParams);
                return windowInsets;
            }
        );

        setContentView(root);
        ViewCompat.requestApplyInsets(root);
    }

    private AppCompatButton createPillButton(String text, int backgroundColor, int textColor) {
        float density = getResources().getDisplayMetrics().density;
        AppCompatButton button = new AppCompatButton(this);
        button.setText(text);
        button.setTextColor(textColor);
        button.setTextSize(15.0f);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setMinWidth(Math.round(76.0f * density));
        button.setMinimumWidth(Math.round(76.0f * density));
        button.setPadding(Math.round(17.0f * density), 0, Math.round(17.0f * density), 0);
        GradientDrawable background = new GradientDrawable();
        background.setColor(backgroundColor);
        background.setCornerRadius(24.0f * density);
        button.setBackground(background);
        return button;
    }

    private void startCamera() {
        if (finishingCapture || isFinishing()) {
            return;
        }

        ListenableFuture<ProcessCameraProvider> providerFuture = ProcessCameraProvider.getInstance(this);
        providerFuture.addListener(
            () -> {
                try {
                    cameraProvider = providerFuture.get();
                    if (!cameraProvider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
                        failCapture("NOT_SUPPORTED", "This device has no back camera available for panorama capture.");
                        return;
                    }

                    int targetRotation = captureSurfaceRotation;
                    Preview preview = new Preview.Builder().setTargetRotation(targetRotation).build();
                    ImageCapture.Builder captureBuilder = new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .setJpegQuality(options.jpegQualityPercent)
                        .setTargetRotation(targetRotation);
                    imageCapture = captureBuilder.build();

                    cameraProvider.unbindAll();
                    Camera camera = cameraProvider.bindToLifecycle(
                        this,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        imageCapture
                    );
                    preview.setSurfaceProvider(previewView.getSurfaceProvider());
                    cameraCalibration = readCameraCalibration(camera);
                    cameraReady = true;
                    updateGuidance(SystemClock.elapsedRealtimeNanos());
                } catch (Exception exception) {
                    Log.e(TAG, "Unable to start CameraX", exception);
                    failCapture("PRESENTATION_FAILED", "The native camera preview could not be started.");
                }
            },
            ContextCompat.getMainExecutor(this)
        );
    }

    @ExperimentalCamera2Interop
    private CameraCalibration readCameraCalibration(Camera camera) {
        try {
            Camera2CameraInfo cameraInfo = Camera2CameraInfo.from(camera.getCameraInfo());
            Size pixelArray = cameraInfo.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
            if (pixelArray == null || pixelArray.getWidth() <= 0 || pixelArray.getHeight() <= 0) {
                return CameraCalibration.unavailable();
            }

            float[] intrinsic = cameraInfo.getCameraCharacteristic(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION);
            if (intrinsic != null && intrinsic.length >= 5) {
                return new CameraCalibration(
                    intrinsic[0],
                    intrinsic[1],
                    intrinsic[2],
                    intrinsic[3],
                    intrinsic[4],
                    pixelArray.getWidth(),
                    pixelArray.getHeight(),
                    "cameraCharacteristics"
                );
            }

            float[] focalLengths = cameraInfo.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
            android.util.SizeF physicalSize = cameraInfo.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
            if (
                focalLengths != null &&
                focalLengths.length > 0 &&
                physicalSize != null &&
                physicalSize.getWidth() > 0.0f &&
                physicalSize.getHeight() > 0.0f
            ) {
                float fx = focalLengths[0] / physicalSize.getWidth() * pixelArray.getWidth();
                float fy = focalLengths[0] / physicalSize.getHeight() * pixelArray.getHeight();
                return new CameraCalibration(
                    fx,
                    fy,
                    pixelArray.getWidth() * 0.5f,
                    pixelArray.getHeight() * 0.5f,
                    0.0f,
                    pixelArray.getWidth(),
                    pixelArray.getHeight(),
                    "derivedFromSensorGeometry"
                );
            }
        } catch (Exception exception) {
            Log.w(TAG, "Camera intrinsics are unavailable", exception);
        }
        return CameraCalibration.unavailable();
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerSensorListeners();
    }

    @Override
    protected void onPause() {
        unregisterSensorListeners();
        resetAlignmentHold();
        super.onPause();
    }

    private void registerSensorListeners() {
        if (sensorManager == null || rotationSensor == null || sensorListenersRegistered) {
            return;
        }
        sensorManager.registerListener(this, rotationSensor, SensorManager.SENSOR_DELAY_GAME);
        if (gyroscopeSensor != null) {
            sensorManager.registerListener(this, gyroscopeSensor, SensorManager.SENSOR_DELAY_GAME);
        }
        sensorListenersRegistered = true;
    }

    private void unregisterSensorListeners() {
        if (sensorManager != null && sensorListenersRegistered) {
            sensorManager.unregisterListener(this);
        }
        sensorListenersRegistered = false;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (finishingCapture) {
            return;
        }

        if (event.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
            float magnitudeRadians = (float) Math.sqrt(
                event.values[0] * event.values[0] +
                event.values[1] * event.values[1] +
                event.values[2] * event.values[2]
            );
            float measuredDegrees = (float) Math.toDegrees(magnitudeRadians);
            angularSpeedDegrees = Float.isFinite(angularSpeedDegrees)
                ? angularSpeedDegrees * 0.72f + measuredDegrees * 0.28f
                : measuredDegrees;
            return;
        }

        if (!isRotationSensor(event.sensor)) {
            return;
        }

        SensorManager.getRotationMatrixFromVector(rawSensorRotation, event.values);
        remapRotationToLockedDisplay(rawSensorRotation, absoluteRotation);
        if (baselineRotation == null) {
            baselineRotation = Arrays.copyOf(absoluteRotation, absoluteRotation.length);
            System.arraycopy(absoluteRotation, 0, previousAbsoluteRotation, 0, 9);
            previousRotationTimestampNanos = event.timestamp;
            angularSpeedDegrees = gyroscopeSensor == null ? Float.POSITIVE_INFINITY : angularSpeedDegrees;
            currentPose = PanoramaPose.fromRelativeRotation(IDENTITY_ROTATION, event.timestamp);
            updateGuidance(event.timestamp);
            return;
        }

        if (gyroscopeSensor == null) {
            updateFallbackAngularSpeed(event.timestamp);
        }

        float[] relativeRotation = transposeMultiply(baselineRotation, absoluteRotation);
        currentPose = PanoramaPose.fromRelativeRotation(relativeRotation, event.timestamp);
        System.arraycopy(absoluteRotation, 0, previousAbsoluteRotation, 0, 9);
        previousRotationTimestampNanos = event.timestamp;
        updateGuidance(event.timestamp);
    }

    private void updateFallbackAngularSpeed(long timestampNanos) {
        long elapsedNanos = timestampNanos - previousRotationTimestampNanos;
        if (elapsedNanos <= 0L) {
            return;
        }
        float[] delta = transposeMultiply(previousAbsoluteRotation, absoluteRotation);
        double cosine = (delta[0] + delta[4] + delta[8] - 1.0) * 0.5;
        cosine = Math.max(-1.0, Math.min(1.0, cosine));
        float measured = (float) (Math.toDegrees(Math.acos(cosine)) / (elapsedNanos / 1_000_000_000.0));
        angularSpeedDegrees = Float.isFinite(angularSpeedDegrees)
            ? angularSpeedDegrees * 0.65f + measured * 0.35f
            : measured;
    }

    private void updateGuidance(long timestampNanos) {
        if (guideView == null || currentPose == null) {
            return;
        }

        PanoramaTarget activeTarget = findNearestUncapturedTarget(currentPose);
        if (activeTarget == null) {
            guideView.updatePose(currentPose.rotation, -1, 0.0f, false, true, captureInFlight);
            if (!captureInFlight && !frames.isEmpty()) {
                finishCaptureSuccessfully();
            }
            return;
        }

        float angularDistance = currentPose.angularDistanceDegrees(activeTarget);
        boolean aligned = angularDistance <= options.alignmentDegrees;
        boolean steady = Float.isFinite(angularSpeedDegrees) && angularSpeedDegrees <= MAX_STEADY_ANGULAR_SPEED_DEGREES;
        if (activeTarget.index != alignedTargetIndex) {
            alignedTargetIndex = activeTarget.index;
            alignedSinceNanos = -1L;
        }

        float holdProgress = 0.0f;
        if (cameraReady && aligned && steady && !captureInFlight) {
            if (alignedSinceNanos < 0L) {
                alignedSinceNanos = timestampNanos;
            }
            long heldMillis = Math.max(0L, (timestampNanos - alignedSinceNanos) / 1_000_000L);
            holdProgress = Math.min(1.0f, heldMillis / (float) options.steadyDurationMillis);
            if (
                holdProgress >= 1.0f &&
                SystemClock.uptimeMillis() - lastCaptureCompletedAtMillis >= MIN_CAPTURE_GAP_MILLIS
            ) {
                captureFrame(activeTarget, currentPose);
                holdProgress = 1.0f;
            }
        } else {
            alignedSinceNanos = -1L;
        }

        guideView.updatePose(
            currentPose.rotation,
            activeTarget.index,
            holdProgress,
            aligned,
            steady,
            captureInFlight
        );
        updateInstruction(aligned, steady);
    }

    private void updateInstruction(boolean aligned, boolean steady) {
        if (instructionLabel == null) {
            return;
        }
        if (!cameraReady) {
            instructionLabel.setText("Starting camera…");
        } else if (captureInFlight) {
            instructionLabel.setText("Capturing…");
        } else if (aligned && !steady) {
            instructionLabel.setText("Hold still");
        } else if (aligned) {
            instructionLabel.setText("Keep holding…");
        } else {
            instructionLabel.setText("Move a dot to the center");
        }
    }

    private void captureFrame(PanoramaTarget target, PanoramaPose pose) {
        if (imageCapture == null || captureInFlight || target.captured || finishingCapture) {
            return;
        }

        captureInFlight = true;
        alignedSinceNanos = -1L;
        final int frameIndex = frames.size();
        final long capturedAtMillis = System.currentTimeMillis();
        final PanoramaPose capturedPose = pose;
        final File pendingFile = new File(sessionDirectory, String.format(Locale.US, ".frame_%03d_pending.jpg", frameIndex));
        final File finalFile = new File(sessionDirectory, String.format(Locale.US, "frame_%03d.jpg", frameIndex));

        ImageCapture.OutputFileOptions outputOptions = new ImageCapture.OutputFileOptions.Builder(pendingFile).build();
        imageCapture.takePicture(
            outputOptions,
            cameraExecutor,
            new ImageCapture.OnImageSavedCallback() {
                @Override
                public void onImageSaved(@NonNull ImageCapture.OutputFileResults outputFileResults) {
                    try {
                        ProcessedFrame processed = finalizeCapturedImage(pendingFile, finalFile);
                        JSONObject metadata = buildFrameMetadata(
                            frameIndex,
                            target,
                            capturedPose,
                            capturedAtMillis,
                            processed
                        );
                        runOnUiThread(() -> acceptCapturedFrame(target, metadata));
                    } catch (Exception exception) {
                        Log.e(TAG, "Unable to finalize captured panorama frame", exception);
                        deleteFileQuietly(pendingFile);
                        deleteFileQuietly(finalFile);
                        runOnUiThread(() -> recoverFromFrameFailure("Couldn't save that frame. Hold the target and try again."));
                    }
                }

                @Override
                public void onError(@NonNull ImageCaptureException exception) {
                    Log.e(TAG, "CameraX image capture failed", exception);
                    deleteFileQuietly(pendingFile);
                    runOnUiThread(() -> recoverFromFrameFailure("Couldn't capture that frame. Hold the target and try again."));
                }
            }
        );
        updateInstruction(true, true);
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
            String.format(
                Locale.US,
                "Guided panorama capture, %d of %d frames captured",
                frames.size(),
                targets.size()
            )
        );
        updateProgressInterface();
        writeMetadataSnapshot(frames.size() == targets.size() ? "complete" : "inProgress");

        if (frames.size() == targets.size()) {
            finishCaptureSuccessfully();
        } else {
            updateGuidance(SystemClock.elapsedRealtimeNanos());
        }
    }

    private void recoverFromFrameFailure(String message) {
        if (finishingCapture || isFinishing()) {
            return;
        }
        captureInFlight = false;
        alignedTargetIndex = -1;
        alignedSinceNanos = -1L;
        instructionLabel.setText(message);
        guideView.updatePose(
            currentPose == null ? IDENTITY_ROTATION : currentPose.rotation,
            -1,
            0.0f,
            false,
            false,
            false
        );
    }

    private ProcessedFrame finalizeCapturedImage(File pendingFile, File finalFile) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(pendingFile.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IOException("CameraX produced an unreadable JPEG.");
        }

        ExifInterface pendingExif = new ExifInterface(pendingFile);
        int exifOrientation = pendingExif.getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL
        );
        int sourceRotationDegrees = pendingExif.getRotationDegrees();
        boolean sourceFlipped = pendingExif.isFlipped();
        boolean swapsDimensions = sourceRotationDegrees == 90 || sourceRotationDegrees == 270;
        int uprightSourceWidth = swapsDimensions ? bounds.outHeight : bounds.outWidth;
        int uprightSourceHeight = swapsDimensions ? bounds.outWidth : bounds.outHeight;
        int width = options.outputWidth > 0
            ? Math.min(options.outputWidth, uprightSourceWidth)
            : uprightSourceWidth;
        int height = Math.max(1, Math.round(uprightSourceHeight * (width / (float) uprightSourceWidth)));

        normalizeJpeg(
            pendingFile,
            finalFile,
            uprightSourceWidth,
            width,
            height,
            sourceRotationDegrees,
            sourceFlipped
        );
        deleteFileQuietly(pendingFile);

        return new ProcessedFrame(
            finalFile,
            width,
            height,
            ExifInterface.ORIENTATION_NORMAL,
            0,
            "up",
            bounds.outWidth,
            bounds.outHeight,
            exifOrientation,
            sourceRotationDegrees,
            sourceFlipped
        );
    }

    private void normalizeJpeg(
        File source,
        File destination,
        int uprightSourceWidth,
        int targetWidth,
        int targetHeight,
        int sourceRotationDegrees,
        boolean sourceFlipped
    ) throws IOException {
        BitmapFactory.Options decodeOptions = new BitmapFactory.Options();
        decodeOptions.inPreferredConfig = Bitmap.Config.ARGB_8888;
        int sampleSize = 1;
        while (uprightSourceWidth / (sampleSize * 2) >= targetWidth) {
            sampleSize *= 2;
        }
        decodeOptions.inSampleSize = sampleSize;
        int sampledUprightWidth = Math.max(1, uprightSourceWidth / sampleSize);
        if (sampledUprightWidth > targetWidth) {
            // Ask BitmapFactory to perform the non-power-of-two portion of the
            // downscale while decoding, which avoids holding two full-size
            // camera bitmaps in the heap for the common outputWidth=2048 path.
            decodeOptions.inScaled = true;
            decodeOptions.inDensity = sampledUprightWidth;
            decodeOptions.inTargetDensity = targetWidth;
        }
        Bitmap decoded = BitmapFactory.decodeFile(source.getAbsolutePath(), decodeOptions);
        if (decoded == null) {
            throw new IOException("The captured JPEG could not be decoded for orientation normalization.");
        }

        Bitmap upright = decoded;
        Bitmap scaled = decoded;
        try {
            if (sourceFlipped || sourceRotationDegrees != 0) {
                Matrix orientation = new Matrix();
                if (sourceFlipped) {
                    // ExifInterface defines the rotation as occurring after a
                    // horizontal flip, so apply transforms in that order.
                    orientation.postScale(-1.0f, 1.0f);
                }
                if (sourceRotationDegrees != 0) {
                    orientation.postRotate(sourceRotationDegrees);
                }
                upright = Bitmap.createBitmap(
                    decoded,
                    0,
                    0,
                    decoded.getWidth(),
                    decoded.getHeight(),
                    orientation,
                    true
                );
            }
            scaled = upright;
            if (upright.getWidth() != targetWidth || upright.getHeight() != targetHeight) {
                scaled = Bitmap.createScaledBitmap(upright, targetWidth, targetHeight, true);
            }
            try (FileOutputStream output = new FileOutputStream(destination)) {
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, options.jpegQualityPercent, output)) {
                    throw new IOException("The normalized JPEG could not be encoded.");
                }
            }
            ExifInterface destinationExif = new ExifInterface(destination);
            destinationExif.setAttribute(
                ExifInterface.TAG_ORIENTATION,
                Integer.toString(ExifInterface.ORIENTATION_NORMAL)
            );
            destinationExif.saveAttributes();
        } finally {
            if (scaled != upright && scaled != decoded) {
                scaled.recycle();
            }
            if (upright != decoded) {
                upright.recycle();
            }
            decoded.recycle();
        }
    }

    private JSONObject buildFrameMetadata(
        int frameIndex,
        PanoramaTarget target,
        PanoramaPose pose,
        long capturedAtMillis,
        ProcessedFrame processed
    ) throws JSONException {
        JSONObject frame = new JSONObject();
        frame.put("index", frameIndex);
        frame.put("targetIndex", target.index);
        frame.put("uri", Uri.fromFile(processed.file).toString());
        frame.put("path", processed.file.getAbsolutePath());
        frame.put("width", processed.width);
        frame.put("height", processed.height);
        frame.put("timestamp", capturedAtMillis);
        frame.put("capturedAt", iso8601(capturedAtMillis));
        frame.put("yaw", pose.yawDegrees);
        frame.put("pitch", pose.pitchDegrees);
        frame.put("roll", pose.rollDegrees);
        frame.put("targetYaw", target.yawDegrees);
        frame.put("targetPitch", target.pitchDegrees);
        frame.put("yawDegrees", pose.yawDegrees);
        frame.put("pitchDegrees", pose.pitchDegrees);
        frame.put("rollDegrees", pose.rollDegrees);
        frame.put("targetYawDegrees", target.yawDegrees);
        frame.put("targetPitchDegrees", target.pitchDegrees);

        JSONObject position = new JSONObject();
        position.put("x", 0.0);
        position.put("y", 0.0);
        position.put("z", 0.0);
        frame.put("position", position);

        JSONObject quaternion = new JSONObject();
        quaternion.put("x", pose.quaternion[0]);
        quaternion.put("y", pose.quaternion[1]);
        quaternion.put("z", pose.quaternion[2]);
        quaternion.put("w", pose.quaternion[3]);
        frame.put("quaternion", quaternion);
        frame.put("transform", floatArrayToJson(pose.transform));
        double[] uprightIntrinsics = cameraCalibration.uprightIntrinsics(processed);
        if (uprightIntrinsics != null) {
            frame.put("intrinsics", doubleArrayToJson(uprightIntrinsics));
            frame.put("intrinsicsSource", cameraCalibration.source + "+uprightExifTransform");
            if (uprightIntrinsics[0] > 0.0 && uprightIntrinsics[4] > 0.0) {
                frame.put(
                    "horizontalFovDegrees",
                    Math.toDegrees(2.0 * Math.atan(processed.width / (2.0 * uprightIntrinsics[0])))
                );
                frame.put(
                    "verticalFovDegrees",
                    Math.toDegrees(2.0 * Math.atan(processed.height / (2.0 * uprightIntrinsics[4])))
                );
            }
        } else {
            frame.put("intrinsicsSource", "unavailable");
        }
        frame.put("imageOrientation", processed.imageOrientation);
        frame.put("rotationDegrees", processed.rotationDegrees);
        frame.put("exifOrientation", processed.exifOrientation);
        frame.put("sourceExifOrientation", processed.sourceExifOrientation);
        frame.put("sourceRotationDegrees", processed.sourceRotationDegrees);
        frame.put("trackingState", "orientationOnly");
        frame.put("poseSource", "androidRotationVector");
        frame.put("translationAvailable", false);
        frame.put("poseTimestamp", pose.sensorTimestampNanos / 1_000_000_000.0);
        return frame;
    }

    private void updateProgressInterface() {
        if (progressLabel == null) {
            return;
        }
        progressLabel.setText(
            String.format(
                Locale.US,
                "%d / %d  ·  %s",
                frames.size(),
                targets.size(),
                options.mode.toUpperCase(Locale.US)
            )
        );
        boolean complete = frames.size() == targets.size() && !captureInFlight;
        doneButton.setEnabled(complete);
        doneButton.setAlpha(complete ? 1.0f : 0.42f);
    }

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

    private void resetAlignmentHold() {
        alignedSinceNanos = -1L;
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
        } catch (Exception exception) {
            Log.e(TAG, "Unable to return panorama capture metadata", exception);
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
        JSONArray frameArray = new JSONArray();
        for (JSONObject frame : frames) {
            frameArray.put(frame);
        }
        result.put("frames", frameArray);
        return result;
    }

    private void writeMetadataSnapshot(String state) {
        if (sessionDirectory == null || !sessionDirectory.exists()) {
            return;
        }
        try {
            writeMetadata(buildResultJson(), state);
        } catch (Exception exception) {
            Log.w(TAG, "Unable to update panorama metadata.json", exception);
        }
    }

    private void writeMetadata(JSONObject result, String state) throws IOException, JSONException {
        JSONObject manifest = new JSONObject(result.toString());
        manifest.put("state", state);
        manifest.put("captureType", "sourceFrames");
        manifest.put("stitchingPerformed", false);
        manifest.put("poseSource", "androidRotationVector");
        manifest.put("translationAvailable", false);
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

    private void cleanupCancelledSession() {
        if (
            sessionDirectory != null &&
            capturesRoot != null &&
            capturesRoot.equals(sessionDirectory.getParentFile())
        ) {
            deleteRecursively(sessionDirectory);
        }
    }

    @Override
    protected void onDestroy() {
        unregisterSensorListeners();
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
        if (cameraExecutor != null) {
            cameraExecutor.shutdown();
        }
        super.onDestroy();
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // Sensor-fusion accuracy changes do not require resetting the relative session origin.
    }

    private static Sensor findRotationSensor(@Nullable SensorManager manager) {
        if (manager == null) {
            return null;
        }
        Sensor sensor = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (sensor == null) {
            sensor = manager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        }
        if (sensor == null) {
            sensor = manager.getDefaultSensor(Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR);
        }
        return sensor;
    }

    private static boolean isRotationSensor(Sensor sensor) {
        int type = sensor.getType();
        return (
            type == Sensor.TYPE_ROTATION_VECTOR ||
            type == Sensor.TYPE_GAME_ROTATION_VECTOR ||
            type == Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR
        );
    }

    private static float[] transposeMultiply(float[] left, float[] right) {
        float[] result = new float[9];
        for (int row = 0; row < 3; row++) {
            for (int column = 0; column < 3; column++) {
                float value = 0.0f;
                for (int index = 0; index < 3; index++) {
                    value += left[index * 3 + row] * right[index * 3 + column];
                }
                result[row * 3 + column] = value;
            }
        }
        return result;
    }

    private void remapRotationToLockedDisplay(float[] sensorRotation, float[] displayRotation) {
        int surfaceRotation = captureSurfaceRotation;
        int displayXAxis = SensorManager.AXIS_X;
        int displayYAxis = SensorManager.AXIS_Y;
        if (surfaceRotation == Surface.ROTATION_90) {
            displayXAxis = SensorManager.AXIS_Y;
            displayYAxis = SensorManager.AXIS_MINUS_X;
        } else if (surfaceRotation == Surface.ROTATION_180) {
            displayXAxis = SensorManager.AXIS_MINUS_X;
            displayYAxis = SensorManager.AXIS_MINUS_Y;
        } else if (surfaceRotation == Surface.ROTATION_270) {
            displayXAxis = SensorManager.AXIS_MINUS_Y;
            displayYAxis = SensorManager.AXIS_X;
        }
        if (!SensorManager.remapCoordinateSystem(sensorRotation, displayXAxis, displayYAxis, displayRotation)) {
            System.arraycopy(sensorRotation, 0, displayRotation, 0, 9);
        }
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

    private static void addTarget(List<PanoramaTarget> targets, double yaw, double pitch) {
        targets.add(new PanoramaTarget(targets.size(), yaw, pitch));
    }

    private static JSONArray floatArrayToJson(float[] values) throws JSONException {
        JSONArray array = new JSONArray();
        for (float value : values) {
            array.put(value);
        }
        return array;
    }

    private static JSONArray doubleArrayToJson(double[] values) throws JSONException {
        JSONArray array = new JSONArray();
        for (double value : values) {
            array.put(value);
        }
        return array;
    }

    private static String iso8601(long timestampMillis) {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date(timestampMillis));
    }

    private static int rotationDegreesForExif(int exifOrientation) {
        if (exifOrientation == ExifInterface.ORIENTATION_ROTATE_90) {
            return 90;
        }
        if (exifOrientation == ExifInterface.ORIENTATION_ROTATE_180) {
            return 180;
        }
        if (exifOrientation == ExifInterface.ORIENTATION_ROTATE_270) {
            return 270;
        }
        return 0;
    }

    private static String imageOrientationForExif(int exifOrientation) {
        if (exifOrientation == ExifInterface.ORIENTATION_ROTATE_90) {
            return "sensorLandscapeRight";
        }
        if (exifOrientation == ExifInterface.ORIENTATION_ROTATE_180) {
            return "down";
        }
        if (exifOrientation == ExifInterface.ORIENTATION_ROTATE_270) {
            return "sensorLandscapeLeft";
        }
        return "up";
    }

    private static void copyFile(File source, File destination) throws IOException {
        byte[] buffer = new byte[32 * 1024];
        try (FileInputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(destination)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
    }

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

    private static void deleteFileQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            Log.w(TAG, "Unable to delete " + file.getAbsolutePath());
        }
    }

    private static final class CaptureOptions {

        final String mode;
        final int outputWidth;
        final double jpegQuality;
        final int jpegQualityPercent;
        final float alignmentDegrees;
        final long steadyDurationMillis;

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

        static CaptureOptions fromJson(@Nullable String json) {
            JSONObject object;
            try {
                object = json == null ? new JSONObject() : new JSONObject(json);
            } catch (JSONException ignored) {
                object = new JSONObject();
            }

            String mode = object.optString("mode", "standard").toLowerCase(Locale.US);
            if (!"quick".equals(mode) && !"standard".equals(mode) && !"detailed".equals(mode)) {
                mode = "standard";
            }

            int requestedWidth = object.optInt("outputWidth", 0);
            int outputWidth = requestedWidth <= 0 ? 0 : clamp(requestedWidth, 640, 4096);
            double jpegQuality = clamp(object.optDouble("jpegQuality", 0.92), 0.10, 1.0);
            float alignment = (float) clamp(object.optDouble("alignmentDegrees", 4.5), 2.0, 12.0);
            long steadyDuration = Math.round(clamp(object.optDouble("steadyDurationMs", 650.0), 250.0, 2000.0));
            return new CaptureOptions(mode, outputWidth, jpegQuality, alignment, steadyDuration);
        }

        private static int clamp(int value, int minimum, int maximum) {
            return Math.max(minimum, Math.min(maximum, value));
        }

        private static double clamp(double value, double minimum, double maximum) {
            return Math.max(minimum, Math.min(maximum, value));
        }
    }

    private static final class ProcessedFrame {

        final File file;
        final int width;
        final int height;
        final int exifOrientation;
        final int rotationDegrees;
        final String imageOrientation;
        final int sourceWidth;
        final int sourceHeight;
        final int sourceExifOrientation;
        final int sourceRotationDegrees;
        final boolean sourceFlipped;

        ProcessedFrame(
            File file,
            int width,
            int height,
            int exifOrientation,
            int rotationDegrees,
            String imageOrientation,
            int sourceWidth,
            int sourceHeight,
            int sourceExifOrientation,
            int sourceRotationDegrees,
            boolean sourceFlipped
        ) {
            this.file = file;
            this.width = width;
            this.height = height;
            this.exifOrientation = exifOrientation;
            this.rotationDegrees = rotationDegrees;
            this.imageOrientation = imageOrientation;
            this.sourceWidth = sourceWidth;
            this.sourceHeight = sourceHeight;
            this.sourceExifOrientation = sourceExifOrientation;
            this.sourceRotationDegrees = sourceRotationDegrees;
            this.sourceFlipped = sourceFlipped;
        }
    }

    private static final class CameraCalibration {

        final float fx;
        final float fy;
        final float cx;
        final float cy;
        final float skew;
        final int referenceWidth;
        final int referenceHeight;
        final String source;

        CameraCalibration(
            float fx,
            float fy,
            float cx,
            float cy,
            float skew,
            int referenceWidth,
            int referenceHeight,
            String source
        ) {
            this.fx = fx;
            this.fy = fy;
            this.cx = cx;
            this.cy = cy;
            this.skew = skew;
            this.referenceWidth = referenceWidth;
            this.referenceHeight = referenceHeight;
            this.source = source;
        }

        static CameraCalibration unavailable() {
            return new CameraCalibration(0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0, 0, "unavailable");
        }

        @Nullable
        double[] uprightIntrinsics(ProcessedFrame frame) {
            if (
                referenceWidth <= 0 ||
                referenceHeight <= 0 ||
                fx <= 0.0f ||
                fy <= 0.0f ||
                frame.sourceWidth <= 0 ||
                frame.sourceHeight <= 0 ||
                frame.sourceFlipped
            ) {
                return null;
            }

            double rawScaleX = frame.sourceWidth / (double) referenceWidth;
            double rawScaleY = frame.sourceHeight / (double) referenceHeight;
            double rawFx = fx * rawScaleX;
            double rawFy = fy * rawScaleY;
            double rawCx = cx * rawScaleX;
            double rawCy = cy * rawScaleY;
            double uprightFx;
            double uprightFy;
            double uprightCx;
            double uprightCy;
            int uprightSourceWidth;
            int uprightSourceHeight;

            if (frame.sourceRotationDegrees == 90) {
                uprightFx = rawFy;
                uprightFy = rawFx;
                uprightCx = frame.sourceHeight - 1.0 - rawCy;
                uprightCy = rawCx;
                uprightSourceWidth = frame.sourceHeight;
                uprightSourceHeight = frame.sourceWidth;
            } else if (frame.sourceRotationDegrees == 180) {
                uprightFx = rawFx;
                uprightFy = rawFy;
                uprightCx = frame.sourceWidth - 1.0 - rawCx;
                uprightCy = frame.sourceHeight - 1.0 - rawCy;
                uprightSourceWidth = frame.sourceWidth;
                uprightSourceHeight = frame.sourceHeight;
            } else if (frame.sourceRotationDegrees == 270) {
                uprightFx = rawFy;
                uprightFy = rawFx;
                uprightCx = rawCy;
                uprightCy = frame.sourceWidth - 1.0 - rawCx;
                uprightSourceWidth = frame.sourceHeight;
                uprightSourceHeight = frame.sourceWidth;
            } else {
                uprightFx = rawFx;
                uprightFy = rawFy;
                uprightCx = rawCx;
                uprightCy = rawCy;
                uprightSourceWidth = frame.sourceWidth;
                uprightSourceHeight = frame.sourceHeight;
            }

            double outputScaleX = frame.width / (double) uprightSourceWidth;
            double outputScaleY = frame.height / (double) uprightSourceHeight;
            return new double[] {
                uprightFx * outputScaleX,
                0.0,
                uprightCx * outputScaleX,
                0.0,
                uprightFy * outputScaleY,
                uprightCy * outputScaleY,
                0.0,
                0.0,
                1.0,
            };
        }
    }
}
