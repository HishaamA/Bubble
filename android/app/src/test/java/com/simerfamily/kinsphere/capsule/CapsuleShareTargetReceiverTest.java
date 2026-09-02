package com.simerfamily.kinsphere.capsule;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Unit coverage for the bounded, token-scoped chooser callback state. */
public final class CapsuleShareTargetReceiverTest {

    @Test
    public void consumesOneMatchingSelection() {
        CapsuleShareTargetReceiver.prepareSelection("expected");
        CapsuleShareTargetReceiver.recordSelection("expected", "family.app/.ShareActivity");

        CapsuleShareTargetReceiver.Selection selection =
            CapsuleShareTargetReceiver.consumeSelection("expected");

        assertNotNull(selection);
        assertEquals("family.app/.ShareActivity", selection.activityType);
        assertNull(CapsuleShareTargetReceiver.consumeSelection("expected"));
    }

    @Test
    public void ignoresCallbacksWithAnotherToken() {
        CapsuleShareTargetReceiver.prepareSelection("expected");
        CapsuleShareTargetReceiver.recordSelection("unexpected", "other.app/.ShareActivity");

        assertNull(CapsuleShareTargetReceiver.consumeSelection("expected"));
    }

    @Test
    public void recordsAChooserActionWithoutAnActivity() {
        CapsuleShareTargetReceiver.prepareSelection("copy-action");
        CapsuleShareTargetReceiver.recordSelection("copy-action", null);

        CapsuleShareTargetReceiver.Selection selection =
            CapsuleShareTargetReceiver.consumeSelection("copy-action");

        assertNotNull(selection);
        assertNull(selection.activityType);
    }

    @Test
    public void clearPreventsALateCallbackFromBeingRecorded() {
        CapsuleShareTargetReceiver.prepareSelection("expected");
        CapsuleShareTargetReceiver.clearSelection("expected");
        CapsuleShareTargetReceiver.recordSelection("expected", "late.app/.ShareActivity");

        assertNull(CapsuleShareTargetReceiver.consumeSelection("expected"));
    }
}
