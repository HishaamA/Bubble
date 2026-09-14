package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;
import org.junit.Test;

/** Exercises the actual IMU-history / calibrated-pose / hold pipeline without scene features. */
public final class PanoramaLowTextureCaptureTest {
    @Test public void featurelessCeilingStillEarnsACompleteSteadyHold() {
        PanoramaSensorHistory history = new PanoramaSensorHistory();
        PanoramaRotationBridge bridge = new PanoramaRotationBridge();
        PanoramaCaptureGate gate = new PanoramaCaptureGate();
        PanoramaPose level = PanoramaPoseMapping.identity();
        bridge.calibrate(level, level, level, 1_000_000_000L);
        PanoramaPose ceiling = pitch(90);
        PanoramaCaptureGate.Sample last = null;
        for (long ms = 1100; ms <= 2600; ms += 10) {
            history.addRotation(ceiling, ms * 1_000_000L);
            history.addAcceleration(0.0f, ms * 1_000_000L);
            if (ms < 1400 || ms % 50 != 0) continue;
            PanoramaSensorHistory.Sample sensor = history.at(ms * 1_000_000L);
            PanoramaPose estimate = bridge.estimate(sensor.pose, sensor.timestampNanos);
            assertNotNull(estimate);
            assertTrue(sensor.motionQuiet);
            last = gate.update(estimate, sensor.timestampNanos, 32, 0, 4.5f, 650, sensor.motionQuiet);
        }
        assertNotNull(last);
        assertTrue(last.readyToCapture);
        assertEquals(1.0f, last.progress, 0.0f);
    }

    @Test public void missingMotionEvidenceCannotEarnAGyroPhotograph() {
        PanoramaSensorHistory history = new PanoramaSensorHistory();
        PanoramaRotationBridge bridge = new PanoramaRotationBridge();
        PanoramaCaptureGate gate = new PanoramaCaptureGate();
        PanoramaPose level = PanoramaPoseMapping.identity();
        bridge.calibrate(level, level, level, 1_000_000_000L);
        for (long ms = 1100; ms <= 2500; ms += 50) {
            history.addRotation(pitch(90), ms * 1_000_000L);
            PanoramaSensorHistory.Sample sensor = history.at(ms * 1_000_000L);
            assertFalse(sensor.motionQuiet);
            PanoramaPose estimate = bridge.estimate(sensor.pose, sensor.timestampNanos);
            assertFalse(gate.update(estimate, sensor.timestampNanos, 32, 0, 4.5f, 650, sensor.motionQuiet).readyToCapture);
        }
        assertEquals(0.0f, gate.getProgress(), 0.0f);
    }

    @Test public void replacementAnchorPreservesCameraAndFutureDirections() {
        PanoramaPose oldCamera = pitch(72);
        PanoramaPose rawCamera = pitch(-31);
        PanoramaPose mapping = PanoramaPoseMapping.between(rawCamera, oldCamera);
        assertArrayEquals(oldCamera.transform, PanoramaPoseMapping.compose(mapping, rawCamera).transform, 0.00001f);
        PanoramaPose delta = pitch(7);
        PanoramaPose expectedNext = PanoramaPoseMapping.compose(oldCamera, delta);
        PanoramaPose nextRaw = PanoramaPoseMapping.compose(rawCamera, delta);
        assertArrayEquals(expectedNext.transform, PanoramaPoseMapping.compose(mapping, nextRaw).transform, 0.00001f);
    }

    @Test public void reanchorMappingPreservesTranslationAndDoesNotMutateInput() {
        float[] first = pitch(23).transform.clone();
        first[12] = 8; first[13] = -2; first[14] = 4;
        float[] second = pitch(-67).transform.clone();
        second[12] = .2f; second[13] = -.1f; second[14] = .05f;
        PanoramaPose raw = PanoramaPose.fromCameraTransform(first);
        PanoramaPose capture = PanoramaPose.fromCameraTransform(second);
        PanoramaPose mapping = PanoramaPoseMapping.between(raw, capture);
        assertArrayEquals(second, PanoramaPoseMapping.compose(mapping, raw).transform, 0.00001f);
        assertArrayEquals(first, raw.transform, 0);
    }

    private static PanoramaPose pitch(double degrees) {
        float c = (float) Math.cos(Math.toRadians(degrees));
        float s = (float) Math.sin(Math.toRadians(degrees));
        return PanoramaPose.fromCameraTransform(new float[] {
            1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1
        });
    }
}
