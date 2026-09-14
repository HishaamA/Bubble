package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import java.io.File;
import java.io.IOException;
import java.util.UUID;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class PanoramaCaptureStoreTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void acceptsOnlyExactUuidChild() throws IOException {
        File root = temporary.newFolder("panorama_captures");
        File child = new File(root, UUID.randomUUID().toString());
        assertEquals(child.getCanonicalFile(), PanoramaCaptureStore.validateSession(root, child));
        assertThrows(IOException.class, () -> PanoramaCaptureStore.validateSession(root, root));
        assertThrows(IOException.class, () -> PanoramaCaptureStore.validateSession(root, new File(root, "not-a-session")));
        assertThrows(IOException.class, () -> PanoramaCaptureStore.validateSession(root, new File(child, UUID.randomUUID().toString())));
        assertThrows(IOException.class, () -> PanoramaCaptureStore.validateSession(root, new File(root.getParent(), UUID.randomUUID().toString())));
    }

    @Test public void rejectsTraversalAndAbbreviatedUuid() throws IOException {
        File root = temporary.newFolder("captures");
        String id = UUID.randomUUID().toString();
        assertThrows(IOException.class, () -> PanoramaCaptureStore.validateSession(root, new File(root, "../" + id)));
        assertThrows(IOException.class, () -> PanoramaCaptureStore.validateSession(root, new File(root, "1-1-1-1-1")));
    }

    @Test public void ownerIsExplicitAndNotSilentlyReassigned() {
        assertEquals("local:user-123", PanoramaCaptureStore.owner("local:user-123"));
        assertThrows(IllegalArgumentException.class, () -> PanoramaCaptureStore.owner(null));
        assertThrows(IllegalArgumentException.class, () -> PanoramaCaptureStore.owner(" "));
        assertThrows(IllegalArgumentException.class, () -> PanoramaCaptureStore.owner("x".repeat(513)));
    }
}
