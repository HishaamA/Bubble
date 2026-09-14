package com.simerfamily.kinsphere.panorama;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

/** Game-rotation fallback which remains available when a blank wall defeats visual tracking. */
final class PanoramaRotationSensor {
    private static final String TAG = "PanoramaRotationSensor";
    private final Object lifecycleLock = new Object();
    private final SensorManager manager;
    private final PanoramaSensorHistory history = new PanoramaSensorHistory();
    private Session session;

    PanoramaRotationSensor(Context context) {
        manager = (SensorManager) context.getApplicationContext().getSystemService(Context.SENSOR_SERVICE);
    }

    boolean start() {
        synchronized (lifecycleLock) {
            if (session != null) return true;
            if (manager == null) return false;
            Sensor rotation = manager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
            Sensor acceleration = manager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
            if (rotation == null || acceleration == null) return false;
            history.clear();
            Session next = new Session();
            next.thread.start();
            session = next;
            try {
                Handler handler = new Handler(next.thread.getLooper());
                // 100 Hz, no batching: history remains on the camera's elapsed-realtime clock.
                boolean rotationReady = manager.registerListener(next, rotation, 10_000, 0, handler);
                boolean accelerationReady = manager.registerListener(next, acceleration, 10_000, 0, handler);
                if (rotationReady && accelerationReady) return true;
            } catch (RuntimeException error) {
                Log.w(TAG, "Unable to register panorama motion sensors", error);
            }
            stopLocked();
            return false;
        }
    }

    void stop() {
        synchronized (lifecycleLock) { stopLocked(); }
    }

    private void stopLocked() {
        Session previous = session;
        session = null;
        history.clear();
        if (previous == null) return;
        try { manager.unregisterListener(previous); }
        catch (RuntimeException error) { Log.w(TAG, "Unable to unregister panorama sensors", error); }
        previous.thread.quitSafely();
    }

    PanoramaSensorHistory.Sample at(long cameraRealtimeNanos) { return history.at(cameraRealtimeNanos); }
    long generation() { return history.generation(); }

    private final class Session implements SensorEventListener {
        final HandlerThread thread = new HandlerThread("BubblePanoramaMotion");
        boolean rotationReliable = true;
        boolean accelerationReliable = true;

        @Override public void onSensorChanged(SensorEvent event) {
            synchronized (lifecycleLock) {
                if (session != this || event == null || event.sensor == null) return;
                int type = event.sensor.getType();
                if (type != Sensor.TYPE_GAME_ROTATION_VECTOR && type != Sensor.TYPE_LINEAR_ACCELERATION) return;
                if (event.accuracy == SensorManager.SENSOR_STATUS_UNRELIABLE) {
                    updateReliability(type, false);
                    return;
                }
                // An explicit accuracy recovery is required after an unreliable event.
                if ((type == Sensor.TYPE_GAME_ROTATION_VECTOR && !rotationReliable) ||
                    (type == Sensor.TYPE_LINEAR_ACCELERATION && !accelerationReliable)) return;
                long before = history.generation();
                try {
                    if (type == Sensor.TYPE_GAME_ROTATION_VECTOR) {
                        if (!validVector(event.values)) { history.clear(); return; }
                        float[] rowMajor = new float[16];
                        SensorManager.getRotationMatrixFromVector(rowMajor, event.values);
                        float[] columnMajor = new float[16];
                        for (int row = 0; row < 4; row++) {
                            for (int column = 0; column < 4; column++) columnMajor[column * 4 + row] = rowMajor[row * 4 + column];
                        }
                        history.addRotation(PanoramaPose.fromCameraTransform(columnMajor), event.timestamp);
                    } else {
                        if (event.values == null || event.values.length < 3) { history.clear(); return; }
                        double squared = 0;
                        for (int i = 0; i < 3; i++) squared += (double) event.values[i] * event.values[i];
                        history.addAcceleration((float) Math.sqrt(squared), event.timestamp);
                    }
                } catch (RuntimeException error) {
                    history.clear();
                    Log.w(TAG, "Rejected invalid panorama sensor event", error);
                } finally {
                    if (before != history.generation()) Log.w(TAG, "Motion stream reset; world calibration must be renewed");
                }
            }
        }

        @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {
            synchronized (lifecycleLock) {
                if (session != this || sensor == null) return;
                updateReliability(sensor.getType(), accuracy != SensorManager.SENSOR_STATUS_UNRELIABLE);
            }
        }

        private void updateReliability(int type, boolean reliable) {
            boolean changed;
            if (type == Sensor.TYPE_GAME_ROTATION_VECTOR) {
                changed = rotationReliable != reliable;
                rotationReliable = reliable;
            } else if (type == Sensor.TYPE_LINEAR_ACCELERATION) {
                changed = accelerationReliable != reliable;
                accelerationReliable = reliable;
            } else return;
            if (changed) {
                history.clear();
                Log.w(TAG, "Motion sensor accuracy changed; world calibration must be renewed");
            }
        }
    }

    private static boolean validVector(float[] vector) {
        if (vector == null || vector.length < 3) return false;
        int count = Math.min(4, vector.length);
        double normSquared = 0;
        for (int i = 0; i < count; i++) {
            if (!Float.isFinite(vector[i])) return false;
            normSquared += (double) vector[i] * vector[i];
        }
        return count == 3 ? normSquared <= 1.01 : Math.abs(normSquared - 1) <= .02;
    }
}
