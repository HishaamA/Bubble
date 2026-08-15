package com.simerfamily.kinsphere.capsule;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.util.UUID;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class CapsuleRecapFilesTest {

    @Rule
    public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void acceptsOnlyExistingUuidNamedArtifactsInTheirExactCacheRoot()
        throws Exception {
        File cache = temporary.newFolder("cache");
        CapsuleRecapFiles files = new CapsuleRecapFiles(cache);

        File staged = files.createStagedImageFile();
        assertTrue(staged.createNewFile());
        File recap = files.createRecapFile();
        assertTrue(recap.createNewFile());

        assertEquals(staged.getCanonicalFile(), files.validateStagedImage(staged.toURI().toString()));
        assertEquals(recap.getCanonicalFile(), files.validateRecap(recap.getAbsolutePath()));
    }

    @Test
    public void rejectsTraversalWrongNamesTypesAndMissingFiles() throws Exception {
        File cache = temporary.newFolder("cache");
        CapsuleRecapFiles files = new CapsuleRecapFiles(cache);
        File staging = new File(cache, CapsuleRecapContract.STAGING_DIRECTORY);
        File outside = new File(cache, UUID.randomUUID() + ".jpg");
        assertTrue(outside.createNewFile());

        assertValidationFails(() -> files.validateStagedImage(outside.toURI().toString()));
        assertValidationFails(() -> files.validateStagedImage(
            new File(staging, "not-a-uuid.jpg").toURI().toString()
        ));
        assertValidationFails(() -> files.validateStagedImage(
            new File(staging, UUID.randomUUID() + ".png").toURI().toString()
        ));
        assertValidationFails(() -> files.validateStagedImage(
            new File(staging, UUID.randomUUID() + ".jpg").toURI().toString()
        ));
        assertValidationFails(() -> files.validateStagedImage("https://family.test/photo.jpg"));
    }

    @Test
    public void cleanupIgnoresForeignPathsAndAllowsMissingValidArtifacts() throws Exception {
        File cache = temporary.newFolder("cache");
        CapsuleRecapFiles files = new CapsuleRecapFiles(cache);
        File staged = files.createStagedImageFile();
        assertTrue(staged.createNewFile());

        assertNotNull(files.removableArtifact(staged.toURI().toString()));
        assertTrue(staged.delete());
        assertNotNull(files.removableArtifact(staged.toURI().toString()));
        assertNull(files.removableArtifact(
            new File(cache, UUID.randomUUID() + ".jpg").toURI().toString()
        ));
        assertNull(files.removableArtifact("file:///data/local/tmp/recap.mp4"));
    }

    private static void assertValidationFails(ThrowingAction action) throws Exception {
        try {
            action.run();
        } catch (IOException expected) {
            return;
        }
        throw new AssertionError("Expected constrained artifact validation to fail");
    }

    private interface ThrowingAction {
        void run() throws Exception;
    }
}
