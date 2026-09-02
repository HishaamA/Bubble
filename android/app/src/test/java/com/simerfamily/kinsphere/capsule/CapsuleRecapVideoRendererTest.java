package com.simerfamily.kinsphere.capsule;

import static org.junit.Assert.assertThrows;

import java.io.IOException;
import org.junit.Test;

/** Unit coverage for the encoder drain deadline. */
public final class CapsuleRecapVideoRendererTest {

    @Test
    public void finalDrainWaitsOnlyBeforeItsDeadline() throws IOException {
        CapsuleRecapVideoRenderer.ensureBeforeDeadline(199L, 200L);
        assertThrows(
            IOException.class,
            () -> CapsuleRecapVideoRenderer.ensureBeforeDeadline(200L, 200L)
        );
    }
}
