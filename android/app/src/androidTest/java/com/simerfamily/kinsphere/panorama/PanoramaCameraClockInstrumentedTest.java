package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.Image;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.os.SystemClock;
import android.util.Log;
import android.util.Size;
import android.view.Surface;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.google.ar.core.CameraConfig;
import com.google.ar.core.CameraConfigFilter;
import com.google.ar.core.Config;
import com.google.ar.core.Frame;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingState;
import com.google.ar.core.TrackingFailureReason;
import com.google.ar.core.exceptions.NotYetAvailableException;
import java.io.File;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Live clock/pixel integration test; transient cache JPEGs are deleted and no scan is created. */
@RunWith(AndroidJUnit4.class)
public final class PanoramaCameraClockInstrumentedTest {
    private static final String TAG = "BubbleCameraClock";

    @Test public void arCoreCpuImagesShareTheRealtimeMotionSensorClock() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        assertEquals("Camera permission must already be granted; this check does not change permissions",
            PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.CAMERA));
        PanoramaRotationSensor sensors = new PanoramaRotationSensor(context);
        Session session = null;
        boolean resumed = false;
        Options options = new Options();
        Stats stats = new Stats(options);
        try (OffscreenContext egl = new OffscreenContext()) {
            try {
                // No requestInstall(): this test must never initiate an ARCore download or UI flow.
                session = new Session(context);
                selectHighestResolutionRearCamera(session, options.selectFps30);
                checkCameraClockSource(context, session.getCameraConfig());
                configureSession(session);
                assertTrue("Motion sensors must start", sensors.start());
                session.resume();
                resumed = true;
                session.setCameraTextureName(egl.textureId);

                long deadline = SystemClock.elapsedRealtimeNanos() + options.durationMillis * 1_000_000L;
                while (SystemClock.elapsedRealtimeNanos() < deadline) {
                    stats.readFrame(session.update(), sensors);
                }
                stats.assertResults();
            } finally {
                sensors.stop();
                if (session != null) {
                    if (resumed) {
                        try { session.pause(); }
                        catch (RuntimeException error) { Log.w(TAG, "ARCore pause cleanup failed", error); }
                    }
                    try { session.close(); }
                    catch (RuntimeException error) { Log.w(TAG, "ARCore close cleanup failed", error); }
                }
            }
        }
        assertNull(sensors.at(SystemClock.elapsedRealtimeNanos() - 50_000_000L));
    }

    private static void checkCameraClockSource(Context context, CameraConfig selected) throws Exception {
        CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        assertNotNull(manager);
        CameraCharacteristics characteristics = manager.getCameraCharacteristics(selected.getCameraId());
        Integer source = characteristics.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE);
        Log.i(TAG, "selectedCamera=" + selected.getCameraId() + ", imageSize=" + selected.getImageSize() +
            ", timestampSource=" + source + ", preview=offscreen, photosSaved=0");
        Log.i(TAG, "selectedFpsRange=" + selected.getFpsRange() + ", textureSize=" + selected.getTextureSize());
        assertEquals("The selected AR camera must share the SensorEvent realtime clock",
            Integer.valueOf(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME), source);
    }

    private static void configureSession(Session session) {
        Config configuration = new Config(session);
        configuration.setFocusMode(Config.FocusMode.AUTO);
        configuration.setPlaneFindingMode(Config.PlaneFindingMode.DISABLED);
        configuration.setLightEstimationMode(Config.LightEstimationMode.DISABLED);
        configuration.setUpdateMode(Config.UpdateMode.BLOCKING);
        session.configure(configuration);
        session.setDisplayGeometry(Surface.ROTATION_0, 640, 480);
    }

    /** Field-based counters keep ART's wide-register allocation small in each test method. */
    private static final class Stats {
        int frames, images, sensorMatches, quietMatches, mismatchedImages, invalidExposures, trustedImages;
        boolean pixelsVerified, trackingPixelsVerified;
        long maximumCameraAge, maximumImageArOffset, maximumImageAndroidOffset, maximumArAndroidOffset;
        long lastArTimestamp, lastImageAttemptMillis;
        final Options options;
        final PanoramaCameraClock cameraClock = new PanoramaCameraClock();
        final EnumMap<TrackingState, StateStats> trackingStates = new EnumMap<>(TrackingState.class);

        Stats(Options options) {
            this.options = options;
            for (TrackingState state : TrackingState.values()) trackingStates.put(state, new StateStats());
            Log.i(TAG, "testDurationMs=" + options.durationMillis + ", attemptIntervalMs=" +
                options.attemptIntervalMillis + ", selectFps30=" + options.selectFps30 + ", freshFramesOnly=true");
            Log.i(TAG, "requireTracking=" + options.requireTracking + ", verifyTransientJpeg=true");
        }

        void readFrame(Frame frame, PanoramaRotationSensor sensors) throws Exception {
            TrackingState state = frame.getCamera().getTrackingState();
            StateStats stateStats = trackingStates.get(state);
            stateStats.frames++;
            stateStats.recordFailure(frame.getCamera().getTrackingFailureReason());
            if (frame.getAndroidCameraTimestamp() <= 0 || frame.getTimestamp() <= 0) return;
            if (frame.getTimestamp() <= lastArTimestamp) {
                stateStats.duplicateFrames++;
                if (frame.getTimestamp() < lastArTimestamp) stateStats.outOfOrderFrames++;
                return;
            }
            lastArTimestamp = frame.getTimestamp();
            stateStats.freshFrames++;
            frames++;
            checkExposure(frame.getAndroidCameraTimestamp());
            maximumArAndroidOffset = Math.max(maximumArAndroidOffset,
                Math.abs(frame.getTimestamp() - frame.getAndroidCameraTimestamp()));
            stateStats.arAndroidOffset.add(frame.getTimestamp() - frame.getAndroidCameraTimestamp());
            checkMotionSample(sensors.at(frame.getAndroidCameraTimestamp()), frame.getAndroidCameraTimestamp(), stateStats);
            attemptImage(frame, state, stateStats);
        }

        void attemptImage(Frame frame, TrackingState state, StateStats stateStats) throws Exception {
            long now = SystemClock.uptimeMillis();
            if (now - lastImageAttemptMillis < options.attemptIntervalMillis) {
                stateStats.throttledFrames++;
                return;
            }
            lastImageAttemptMillis = now;
            stateStats.imageAttempts++;
            checkImage(frame, state, stateStats);
        }

        void checkExposure(long androidTimestamp) {
            long age = SystemClock.elapsedRealtimeNanos() - androidTimestamp;
            if (age < 0 || age > 500_000_000L) {
                invalidExposures++;
                if (invalidExposures <= 3) Log.w(TAG, "Invalid camera realtime ageNanos=" + age);
            }
            maximumCameraAge = Math.max(maximumCameraAge, age);
        }

        void checkImage(Frame frame, TrackingState state, StateStats stateStats) throws Exception {
            ArCapturedImage detached = null;
            try (Image image = frame.acquireCameraImage()) {
                checkRawImageClocks(image.getTimestamp(), frame, state, stateStats);
                boolean trusted = cameraClock.acceptFrame(image.getTimestamp(), frame.getTimestamp(),
                    frame.getAndroidCameraTimestamp(), SystemClock.elapsedRealtimeNanos(), true);
                stateStats.recordDecision(cameraClock.lastDecision(), trusted);
                if (trusted) trustedImages++;
                if (trusted && needsPixelProbe(state)) detached = ArCapturedImage.copyOf(image);
                images++;
            } catch (NotYetAvailableException imageNotReady) {
                // A CPU image is not guaranteed on every update.
                stateStats.imagesNotAvailable++;
            }
            // Exercise detached ownership: release the live AR Image before scoring and JPEG encoding.
            if (detached != null) verifyDetachedPixels(detached, state);
        }

        void checkRawImageClocks(long imageTimestamp, Frame frame, TrackingState state, StateStats stateStats) {
            boolean matches = PanoramaCameraClock.matchesArFrame(imageTimestamp, frame.getTimestamp());
            stateStats.images++;
            if (matches) stateStats.arMatches++;
            else { stateStats.arMismatches++; mismatchedImages++; }
            if (Math.abs(imageTimestamp - frame.getAndroidCameraTimestamp()) <= 1_000_000L) stateStats.androidMatches++;
            stateStats.imageArOffset.add(imageTimestamp - frame.getTimestamp());
            stateStats.imageAndroidOffset.add(imageTimestamp - frame.getAndroidCameraTimestamp());
            maximumImageArOffset = Math.max(maximumImageArOffset, Math.abs(imageTimestamp - frame.getTimestamp()));
            maximumImageAndroidOffset = Math.max(maximumImageAndroidOffset,
                Math.abs(imageTimestamp - frame.getAndroidCameraTimestamp()));
            if (images < 3 || (!matches && stateStats.arMismatches <= 6)) {
                logImageClocks(imageTimestamp, frame, state, matches);
            }
        }

        boolean needsPixelProbe(TrackingState state) {
            if (state == TrackingState.TRACKING) return !trackingPixelsVerified;
            return state == TrackingState.PAUSED && !options.requireTracking && !pixelsVerified;
        }

        void verifyDetachedPixels(ArCapturedImage captured, TrackingState state) throws Exception {
            double sharpness = captured.lumaSharpnessScore();
            assertTrue("Live-frame sharpness must be finite and nonnegative, including plain walls",
                Double.isFinite(sharpness) && sharpness >= 0);
            Context context = ApplicationProvider.getApplicationContext();
            File output = File.createTempFile("bubble-clock-pixel-probe-", ".jpg", context.getCacheDir());
            try {
                verifyEncodedDimensions(captured, output, state, sharpness);
            } finally {
                assertTrue("Temporary camera JPEG must be removed", output.delete());
            }
            pixelsVerified = true;
            if (state == TrackingState.TRACKING) trackingPixelsVerified = true;
            Log.i(TAG, "livePixelProbe tracking=" + state + ", copied=true, encoded=true, temporaryJpegDeleted=true");
        }

        void verifyEncodedDimensions(ArCapturedImage captured, File output, TrackingState state, double sharpness)
            throws Exception {
            ArCapturedImage.EncodedFrame encoded = captured.encode(output, 90, 0, 92);
            assertTrue("Encoded live image must contain bytes", output.length() > 0);
            assertEquals(captured.height, encoded.width);
            assertEquals(captured.width, encoded.height);
            Bitmap decoded = BitmapFactory.decodeFile(output.getAbsolutePath());
            assertNotNull("Encoded live image must decode", decoded);
            try {
                assertEquals(encoded.width, decoded.getWidth());
                assertEquals(encoded.height, decoded.getHeight());
                Log.i(TAG, "livePixelProbe tracking=" + state + ", source=" + captured.width + "x" + captured.height +
                    ", jpeg=" + decoded.getWidth() + "x" + decoded.getHeight());
                Log.i(TAG, "livePixelProbe sharpness=" + sharpness + ", jpegBytes=" + output.length());
            } finally { decoded.recycle(); }
        }

        void logImageClocks(long imageTimestamp, Frame frame, TrackingState state, boolean matches) {
            Log.i(TAG, "clockSample=" + images + ", tracking=" + state + ", rawOneMsArMatch=" + matches);
            Log.i(TAG, "imageTimestamp=" + imageTimestamp +
                ", arFrameTimestamp=" + frame.getTimestamp() +
                ", androidCameraTimestamp=" + frame.getAndroidCameraTimestamp());
            Log.i(TAG, "imageMinusArNs=" + (imageTimestamp - frame.getTimestamp()) +
                ", imageMinusAndroidNs=" + (imageTimestamp - frame.getAndroidCameraTimestamp()));
        }

        void checkMotionSample(PanoramaSensorHistory.Sample sample, long androidTimestamp, StateStats stateStats) {
            if (sample == null) return;
            assertEquals(androidTimestamp, sample.timestampNanos);
            assertNotNull(sample.pose);
            sensorMatches++;
            stateStats.sensorMatches++;
            if (sample.motionQuiet) { quietMatches++; stateStats.quietMatches++; }
        }

        void assertResults() {
            Log.i(TAG, "frames=" + frames + ", acquiredImages=" + images + ", sensorMatches=" + sensorMatches +
                ", motionQuietMatches=" + quietMatches + ", rawOneMsArMismatches=" + mismatchedImages);
            Log.i(TAG, "maxImageArOffsetNs=" + maximumImageArOffset + ", maxImageAndroidOffsetNs=" +
                maximumImageAndroidOffset + ", maxArAndroidOffsetNs=" + maximumArAndroidOffset +
                ", maxCameraAgeNs=" + maximumCameraAge + ", retainedPhotos=0");
            for (TrackingState state : TrackingState.values()) trackingStates.get(state).log(state);
            if (trackingStates.get(TrackingState.TRACKING).frames == 0) {
                Log.w(TAG, "TRACKING coverage=0: this run cannot validate capture while visually tracking");
            }
            assertTrue("ARCore produced no fresh camera frames within the configured duration", frames > 0);
            assertTrue("No CPU camera images available to verify exposure timestamps", images > 0);
            assertTrue("No motion samples matched real ARCore exposure timestamps", sensorMatches > 0);
            assertEquals("Camera exposures must remain within 0..500ms of realtime", 0, invalidExposures);
            assertTrue("Stateful image clock validation accepted no images", trustedImages > 0);
            assertTrue("A trusted live frame must successfully copy, score, encode and decode", pixelsVerified);
            if (options.requireTracking) {
                assertTrue("No trusted TRACKING images: see tracking-state diagnostics",
                    trackingStates.get(TrackingState.TRACKING).trustedImages > 0);
                assertTrue("A trusted TRACKING frame must pass the full live pixel pipeline", trackingPixelsVerified);
            }
            // Raw AR timestamp mismatches are diagnostic only; VIO legitimately refines that clock.
        }
    }

    private static final class StateStats {
        int frames, images, arMatches, arMismatches, androidMatches, imagesNotAvailable, sensorMatches, quietMatches;
        int freshFrames, duplicateFrames, outOfOrderFrames, imageAttempts, throttledFrames;
        int trustedImages, rejectedImages;
        final OffsetRange imageArOffset = new OffsetRange();
        final OffsetRange imageAndroidOffset = new OffsetRange();
        final OffsetRange arAndroidOffset = new OffsetRange();
        final EnumMap<TrackingFailureReason, Integer> failures = new EnumMap<>(TrackingFailureReason.class);
        final Map<String, Integer> clockDecisions = new TreeMap<>();

        void recordDecision(String reason, boolean accepted) {
            Integer previous = clockDecisions.get(reason);
            clockDecisions.put(reason, previous == null ? 1 : previous + 1);
            if (accepted) trustedImages++;
            else rejectedImages++;
        }

        void recordFailure(TrackingFailureReason reason) {
            Integer previous = failures.get(reason);
            failures.put(reason, previous == null ? 1 : previous + 1);
        }

        void log(TrackingState state) {
            Log.i(TAG, "tracking=" + state + ", frames=" + frames + ", acquiredImages=" + images +
                ", rawArMatches=" + arMatches + ", rawArMismatches=" + arMismatches + ", androidMatches=" + androidMatches);
            Log.i(TAG, "tracking=" + state + ", trustedImages=" + trustedImages + ", rejectedImages=" + rejectedImages +
                ", clockDecisions=" + clockDecisions);
            Log.i(TAG, "tracking=" + state + ", imagesNotAvailable=" + imagesNotAvailable +
                ", sensorMatches=" + sensorMatches + ", motionQuietMatches=" + quietMatches);
            Log.i(TAG, "tracking=" + state + ", freshFrames=" + freshFrames + ", duplicates=" + duplicateFrames +
                ", outOfOrder=" + outOfOrderFrames + ", imageAttempts=" + imageAttempts + ", throttledFrames=" + throttledFrames);
            Log.i(TAG, "tracking=" + state + ", failureReasons=" + failures);
            Log.i(TAG, "tracking=" + state + ", imageMinusArRangeNs=" + imageArOffset +
                ", imageMinusAndroidRangeNs=" + imageAndroidOffset + ", arMinusAndroidRangeNs=" + arAndroidOffset);
        }
    }

    private static final class Options {
        final long attemptIntervalMillis = readLong("attemptIntervalMs", 0, 0, 1_000);
        final long durationMillis = readLong("testDurationMs", 15_000, 1_000, 60_000);
        final boolean selectFps30 = Boolean.parseBoolean(
            InstrumentationRegistry.getArguments().getString("selectFps30", "false"));
        final boolean requireTracking = Boolean.parseBoolean(
            InstrumentationRegistry.getArguments().getString("requireTracking", "false"));

        private static long readLong(String name, long fallback, long minimum, long maximum) {
            String supplied = InstrumentationRegistry.getArguments().getString(name);
            long value = supplied == null ? fallback : Long.parseLong(supplied);
            assertTrue("Invalid " + name + ": " + value, value >= minimum && value <= maximum);
            return value;
        }
    }

    private static final class OffsetRange {
        long minimum = Long.MAX_VALUE;
        long maximum = Long.MIN_VALUE;

        void add(long offset) {
            minimum = Math.min(minimum, offset);
            maximum = Math.max(maximum, offset);
        }

        @Override public String toString() {
            return minimum == Long.MAX_VALUE ? "none" : "[" + minimum + "," + maximum + "]";
        }
    }

    private static void selectHighestResolutionRearCamera(Session session, boolean selectFps30) {
        CameraConfigFilter filter = new CameraConfigFilter(session);
        filter.setFacingDirection(CameraConfig.FacingDirection.BACK);
        if (selectFps30) filter.setTargetFps(EnumSet.of(CameraConfig.TargetFps.TARGET_FPS_30));
        List<CameraConfig> configurations = session.getSupportedCameraConfigs(filter);
        CameraConfig best = null;
        long bestPixels = -1;
        for (CameraConfig candidate : configurations) {
            Size size = candidate.getImageSize();
            long pixels = (long) size.getWidth() * size.getHeight();
            if (pixels > bestPixels) { best = candidate; bestPixels = pixels; }
        }
        assertNotNull("No rear ARCore camera configuration", best);
        session.setCameraConfig(best);
    }

    private static final class OffscreenContext implements AutoCloseable {
        EGLDisplay display = EGL14.EGL_NO_DISPLAY;
        EGLContext context = EGL14.EGL_NO_CONTEXT;
        EGLSurface surface = EGL14.EGL_NO_SURFACE;
        int textureId;

        OffscreenContext() {
            boolean ready = false;
            try {
                display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
                assertNotEquals(EGL14.EGL_NO_DISPLAY, display);
                int[] version = new int[2];
                assertTrue("EGL initialization", EGL14.eglInitialize(display, version, 0, version, 1));
                EGLConfig[] configurations = new EGLConfig[1];
                int[] count = new int[1];
                int[] attributes = {
                    EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                    EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
                    EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8,
                    EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8, EGL14.EGL_NONE,
                };
                assertTrue(EGL14.eglChooseConfig(display, attributes, 0, configurations, 0, 1, count, 0));
                assertTrue("No EGL pbuffer configuration", count[0] > 0);
                context = EGL14.eglCreateContext(display, configurations[0], EGL14.EGL_NO_CONTEXT,
                    new int[] {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE}, 0);
                assertNotEquals(EGL14.EGL_NO_CONTEXT, context);
                surface = EGL14.eglCreatePbufferSurface(display, configurations[0],
                    new int[] {EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE}, 0);
                assertNotEquals(EGL14.EGL_NO_SURFACE, surface);
                assertTrue(EGL14.eglMakeCurrent(display, surface, surface, context));
                int[] textures = new int[1];
                GLES20.glGenTextures(1, textures, 0);
                textureId = textures[0];
                assertTrue("No external camera texture", textureId > 0);
                GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
                GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
                GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
                GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
                GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
                assertEquals("Camera texture setup", GLES20.GL_NO_ERROR, GLES20.glGetError());
                ready = true;
            } finally { if (!ready) close(); }
        }

        @Override public void close() {
            if (display == EGL14.EGL_NO_DISPLAY) return;
            if (textureId != 0 && context != EGL14.EGL_NO_CONTEXT) {
                GLES20.glDeleteTextures(1, new int[] {textureId}, 0);
                textureId = 0;
            }
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface);
            if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context);
            EGL14.eglTerminate(display);
            EGL14.eglReleaseThread();
            display = EGL14.EGL_NO_DISPLAY;
            surface = EGL14.EGL_NO_SURFACE;
            context = EGL14.EGL_NO_CONTEXT;
        }
    }
}
