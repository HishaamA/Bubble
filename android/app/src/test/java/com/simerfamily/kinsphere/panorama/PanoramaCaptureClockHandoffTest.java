package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;

import org.junit.Test;

/**
 * JVM integration of the production hold, clock, and candidate-selection helpers.
 * Caller acquisition/handoff policy is modeled below; this does not exercise the Activity,
 * ARCore image acquisition, pixel encoding, durable acceptance, or device UI.
 */
public final class PanoramaCaptureClockHandoffTest {
    private static final long MILLIS = 1_000_000L;
    private static final long BASE = 10_000_000_000L;
    private static final long IMAGE_ANDROID_OFFSET = 31_346_842L;
    private static final long IMAGE_AR_OFFSET = 4_781_110L;
    private static final long CANDIDATE_MAX_AGE = 500 * MILLIS;

    @Test public void refinedArClockReachesHandoffWithinOnePointFiveSecondsIncludingZeroSharpness() {
        for (double sharpness : new double[] { 12.0, 0.0 }) {
            CallerModel caller = new CallerModel(ImageAvailability.AVAILABLE, sharpness);
            Candidate candidate = caller.firstHandoffBy(1500);

            assertNotNull("A centered stationary hold must obtain a trusted image", candidate);
            assertTrue(caller.elapsedMillis >= 650 && caller.elapsedMillis <= 1500);
            assertTrue(caller.sample.readyToCapture);
            assertTrue(caller.sample.freshFrame && caller.sample.withinCaptureZone && caller.sample.steady);
            assertEquals(sharpness, candidate.sharpness, 0.0);
            assertEquals(IMAGE_ANDROID_OFFSET, candidate.imageTimestamp - candidate.androidTimestamp);
            assertEquals(IMAGE_AR_OFFSET, candidate.imageTimestamp - candidate.arTimestamp);
            assertFalse("The former raw-clock eligibility check rejected this valid input",
                PanoramaCameraClock.matchesArFrame(candidate.imageTimestamp, candidate.arTimestamp));
            assertTrue(caller.arTimestamp - candidate.arTimestamp <= CANDIDATE_MAX_AGE);
            assertTrue("Clock warmup needs three throttled acquisitions", caller.acceptedImages > 0);
            assertEquals("accepted", caller.clock.lastDecision());
        }
    }

    @Test public void newestImageUnavailableStillHandsOffEarlierTrustedFreshCandidate() {
        CallerModel caller = new CallerModel(ImageAvailability.UNAVAILABLE_AFTER_THREE, 0.0);
        Candidate candidate = caller.firstHandoffBy(1500);

        assertNotNull(candidate);
        assertTrue(caller.sample.readyToCapture);
        assertEquals("not_yet_available", caller.lastImageResult);
        assertEquals(1, caller.acceptedImages);
        assertTrue(candidate.elapsedMillis < caller.lastImageAttemptMillis);
        assertTrue(caller.arTimestamp - candidate.arTimestamp <= CANDIDATE_MAX_AGE);
    }

    @Test public void newestImageClockRejectedStillHandsOffEarlierTrustedFreshCandidate() {
        CallerModel caller = new CallerModel(ImageAvailability.REJECTED_AFTER_THREE, 0.0);
        Candidate candidate = caller.firstHandoffBy(1500);

        assertNotNull(candidate);
        assertTrue(caller.sample.readyToCapture);
        assertEquals("offset_changed", caller.lastImageResult);
        assertEquals(1, caller.acceptedImages);
        assertEquals(IMAGE_ANDROID_OFFSET, candidate.imageTimestamp - candidate.androidTimestamp);
        assertTrue(candidate.elapsedMillis < caller.lastImageAttemptMillis);
        assertTrue(caller.arTimestamp - candidate.arTimestamp <= CANDIDATE_MAX_AGE);
    }

    @Test public void completedHoldCannotHandOffCandidateAfterItsFreshnessLimit() {
        CallerModel caller = new CallerModel(ImageAvailability.UNAVAILABLE_AFTER_THREE, 0.0);
        Candidate previouslyEligible = caller.firstHandoffBy(1500);
        assertNotNull(previouslyEligible);

        // Observe eligibility without dispatching an encoder or resetting the gate. This
        // isolates expiration: the modeled caller must not keep offering an old candidate.
        long endMillis = previouslyEligible.elapsedMillis + 520;
        for (long time = caller.elapsedMillis + 20; time <= endMillis; time += 20) {
            caller.onFrame(time);
        }

        assertTrue(caller.sample.readyToCapture);
        assertEquals(1.0f, caller.sample.progress, 0.0f);
        assertTrue(caller.arTimestamp - previouslyEligible.arTimestamp > CANDIDATE_MAX_AGE);
        assertEquals("not_yet_available", caller.lastImageResult);
        assertNull(caller.handoffCandidate);
    }

    private enum ImageAvailability { AVAILABLE, UNAVAILABLE_AFTER_THREE, REJECTED_AFTER_THREE }

    /** Models the relevant caller policy; all three stateful decision helpers are production code. */
    private static final class CallerModel {
        final PanoramaCaptureGate gate = new PanoramaCaptureGate();
        final PanoramaCameraClock clock = new PanoramaCameraClock();
        final BestFrameSelector<Candidate> selector = new BestFrameSelector<>(CANDIDATE_MAX_AGE);
        final PanoramaPose stationary = PanoramaPose.fromCameraTransform(new float[] {
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        });
        final ImageAvailability availability;
        final double sharpness;
        long elapsedMillis;
        long arTimestamp;
        long bestWindowStart = -1;
        long lastImageAttemptMillis = -120;
        int imageAttempts;
        int acceptedImages;
        String lastImageResult;
        PanoramaCaptureGate.Sample sample;
        Candidate handoffCandidate;

        CallerModel(ImageAvailability availability, double sharpness) {
            this.availability = availability;
            this.sharpness = sharpness;
        }

        Candidate firstHandoffBy(long deadlineMillis) {
            for (long time = 0; time <= deadlineMillis; time += 20) {
                onFrame(time);
                if (handoffCandidate != null) return handoffCandidate;
            }
            return null;
        }

        void onFrame(long timeMillis) {
            elapsedMillis = timeMillis;
            long androidTimestamp = BASE + timeMillis * MILLIS;
            long imageTimestamp = androidTimestamp + IMAGE_ANDROID_OFFSET;
            arTimestamp = imageTimestamp - IMAGE_AR_OFFSET;
            sample = gate.update(stationary, arTimestamp, 1, 0.0f, 4.5f, 650, true);
            handoffCandidate = null;
            if (!sample.freshFrame || !sample.withinCaptureZone || !sample.steady) return;
            if (bestWindowStart < 0) bestWindowStart = arTimestamp;
            if (!sample.readyToCapture && arTimestamp - bestWindowStart < 220 * MILLIS) return;

            if (timeMillis - lastImageAttemptMillis >= 120) {
                lastImageAttemptMillis = timeMillis;
                imageAttempts++;
                if (availability == ImageAvailability.UNAVAILABLE_AFTER_THREE && imageAttempts > 3) {
                    lastImageResult = "not_yet_available";
                } else {
                    if (availability == ImageAvailability.REJECTED_AFTER_THREE && imageAttempts > 3) {
                        imageTimestamp += 10 * MILLIS;
                    }
                    if (clock.acceptFrame(imageTimestamp, arTimestamp, androidTimestamp,
                        androidTimestamp + 80 * MILLIS, true)) {
                        Candidate candidate = new Candidate(timeMillis, imageTimestamp, arTimestamp,
                            androidTimestamp, sharpness);
                        selector.consider(candidate, sharpness, arTimestamp);
                        acceptedImages++;
                    }
                    lastImageResult = clock.lastDecision();
                }
            }

            // Lookup remains outside the newest-image success branch. Unavailable or
            // rejected input cannot bypass a trusted candidate's age and shutter checks.
            Candidate candidate = selector.best(arTimestamp);
            if (sample.readyToCapture) handoffCandidate = candidate;
        }
    }

    private static final class Candidate {
        final long elapsedMillis;
        final long imageTimestamp;
        final long arTimestamp;
        final long androidTimestamp;
        final double sharpness;

        Candidate(long elapsedMillis, long imageTimestamp, long arTimestamp,
                  long androidTimestamp, double sharpness) {
            this.elapsedMillis = elapsedMillis;
            this.imageTimestamp = imageTimestamp;
            this.arTimestamp = arTimestamp;
            this.androidTimestamp = androidTimestamp;
            this.sharpness = sharpness;
        }
    }
}
