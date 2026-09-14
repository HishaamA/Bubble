package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Read-only device IMU smoke tests. Never opens a camera, creates a photo, or touches saved scans. */
@RunWith(AndroidJUnit4.class)
public final class PanoramaRotationSensorInstrumentedTest {
    private static final String TAG = "BubbleMotionSensors";

    @Test public void deviceMotionSensorsProvideCameraClockSamplesAndStopCleanly() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        SensorManager manager = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
        assertNotNull("Sensor service is required for blank-surface guidance", manager);
        Sensor rotation = manager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        Sensor acceleration = manager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
        assertNotNull("Game rotation vector unavailable on this phone", rotation);
        assertNotNull("Linear acceleration unavailable on this phone", acceleration);
        logSensor(rotation);
        logSensor(acceleration);

        StatusObserver observer = new StatusObserver();
        HandlerThread statusThread = new HandlerThread("BubbleMotionSensorTestStatus");
        statusThread.start();
        PanoramaRotationSensor collector = new PanoramaRotationSensor(context);
        int samples = 0;
        int motionQuietSamples = 0;
        try {
            Handler handler = new Handler(statusThread.getLooper());
            assertTrue(manager.registerListener(observer, rotation, 10_000, 0, handler));
            assertTrue(manager.registerListener(observer, acceleration, 10_000, 0, handler));
            assertTrue("Both motion sensors must register successfully", collector.start());
            long deadline = SystemClock.elapsedRealtimeNanos() + 3_000_000_000L;
            while (SystemClock.elapsedRealtimeNanos() < deadline) {
                long requestedTimestamp = SystemClock.elapsedRealtimeNanos() - 50_000_000L;
                PanoramaSensorHistory.Sample sample = collector.at(requestedTimestamp);
                if (sample != null) {
                    assertEquals("Never substitute the latest IMU timestamp for the camera time",
                        requestedTimestamp, sample.timestampNanos);
                    assertNotNull(sample.pose);
                    samples++;
                    if (sample.motionQuiet) motionQuietSamples++;
                }
                Thread.sleep(20);
            }
            Log.i(TAG, "status=sampled, matchedSamples=" + samples + ", motionQuietSamples=" +
                motionQuietSamples + ", rotationAccuracy=" + observer.rotationAccuracy.get() +
                ", accelerationAccuracy=" + observer.accelerationAccuracy.get() +
                ", rotationEvents=" + observer.rotationEvents.get() +
                ", accelerationEvents=" + observer.accelerationEvents.get() +
                ", historyGeneration=" + collector.generation());
            assertTrue("No timestamp-matched IMU poses in three seconds; rotationAccuracy=" +
                observer.rotationAccuracy.get() + ", accelerationAccuracy=" + observer.accelerationAccuracy.get(),
                samples > 0);
            // Do not require motionQuiet: the user may legitimately be moving the connected phone.
        } finally {
            collector.stop();
            manager.unregisterListener(observer);
            statusThread.quitSafely();
        }
        assertNull("Stopping must discard all orientation data from the previous session",
            collector.at(SystemClock.elapsedRealtimeNanos() - 50_000_000L));
        Log.i(TAG, "status=stopped, retainedSamples=0");
    }

    @Test public void rearCameraDeclaresRealtimeSensorTimestampSourceWithoutOpeningIt() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        assertNotNull(manager);
        String rearCameraId = null;
        Integer timestampSource = null;
        for (String cameraId : manager.getCameraIdList()) {
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(cameraId);
            Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                rearCameraId = cameraId;
                timestampSource = characteristics.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE);
                break;
            }
        }
        Log.i(TAG, "rearCameraId=" + rearCameraId + ", timestampSource=" + timestampSource +
            ", realtimeValue=" + CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME +
            ", cameraOpened=false");
        assertNotNull("No rear camera declared", rearCameraId);
        assertEquals("The IMU fallback requires a camera clock comparable with elapsedRealtimeNanos",
            Integer.valueOf(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME), timestampSource);
    }

    private static void logSensor(Sensor sensor) {
        Log.i(TAG, "sensor=" + sensor.getName() + ", vendor=" + sensor.getVendor() +
            ", type=" + sensor.getType() + ", minDelayUs=" + sensor.getMinDelay() +
            ", reportingMode=" + sensor.getReportingMode());
    }

    private static final class StatusObserver implements SensorEventListener {
        final AtomicInteger rotationAccuracy = new AtomicInteger(Integer.MIN_VALUE);
        final AtomicInteger accelerationAccuracy = new AtomicInteger(Integer.MIN_VALUE);
        final AtomicInteger rotationEvents = new AtomicInteger();
        final AtomicInteger accelerationEvents = new AtomicInteger();

        @Override public void onSensorChanged(SensorEvent event) {
            if (event.sensor.getType() == Sensor.TYPE_GAME_ROTATION_VECTOR) {
                rotationAccuracy.set(event.accuracy);
                rotationEvents.incrementAndGet();
            } else if (event.sensor.getType() == Sensor.TYPE_LINEAR_ACCELERATION) {
                accelerationAccuracy.set(event.accuracy);
                accelerationEvents.incrementAndGet();
            }
        }

        @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {
            if (sensor.getType() == Sensor.TYPE_GAME_ROTATION_VECTOR) rotationAccuracy.set(accuracy);
            else if (sensor.getType() == Sensor.TYPE_LINEAR_ACCELERATION) accelerationAccuracy.set(accuracy);
        }
    }
}
