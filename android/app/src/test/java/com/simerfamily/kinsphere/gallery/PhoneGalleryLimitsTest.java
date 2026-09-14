package com.simerfamily.kinsphere.gallery;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

/** No device photos, permissions, or Android context are touched by these tests. */
public final class PhoneGalleryLimitsTest {
    @Test
    public void acceptsOnlyPositiveOpaqueMediaIds() {
        assertEquals(1L, PhoneGalleryLimits.mediaId("1"));
        assertEquals(Long.MAX_VALUE, PhoneGalleryLimits.mediaId(Long.toString(Long.MAX_VALUE)));
        for (String invalid : new String[] { null, "", "0", "-1", "01", "1.0", " 1", "1 ",
            "9223372036854775808", "content://media/external/images/1", "file:///secret.jpg", "../1" }) {
            assertThrows(IllegalArgumentException.class, () -> PhoneGalleryLimits.mediaId(invalid));
        }
    }

    @Test
    public void clampsPreviewAndPageSizes() {
        assertEquals(256, PhoneGalleryLimits.previewEdge(Integer.MIN_VALUE));
        assertEquals(1200, PhoneGalleryLimits.previewEdge(1200));
        assertEquals(1600, PhoneGalleryLimits.previewEdge(Integer.MAX_VALUE));
        assertEquals(1, PhoneGalleryLimits.pageLimit(0));
        assertEquals(100, PhoneGalleryLimits.pageLimit(100));
        assertEquals(200, PhoneGalleryLimits.pageLimit(Integer.MAX_VALUE));
    }

    @Test
    public void boundsDecodedPixelsBeforeAllocationWithoutUpscaling() {
        assertArrayEquals(new int[] {1600, 1200}, PhoneGalleryLimits.targetSize(8000, 6000, 1600));
        assertArrayEquals(new int[] {600, 1200}, PhoneGalleryLimits.targetSize(4000, 8000, 1200));
        assertArrayEquals(new int[] {80, 60}, PhoneGalleryLimits.targetSize(80, 60, 1600));
        assertArrayEquals(new int[] {1600, 1}, PhoneGalleryLimits.targetSize(Integer.MAX_VALUE, 1, Integer.MAX_VALUE));
        assertArrayEquals(new int[] {256, 256}, PhoneGalleryLimits.targetSize(10000, 10000, -1));
        assertThrows(IllegalArgumentException.class, () -> PhoneGalleryLimits.targetSize(0, 100, 1200));
        assertThrows(IllegalArgumentException.class, () -> PhoneGalleryLimits.targetSize(100, -1, 1200));
    }

    @Test
    public void rejectsChangedLibraryPagesUntilAnExplicitNewEnumeration() throws Exception {
        PhoneGalleryListingState state = new PhoneGalleryListingState();
        assertThrows(PhoneGalleryLibraryChangedException.class, () -> state.startPage(100, "granted"));
        long first = state.startPage(0, "granted");
        state.finishPage(first, "granted", "granted");
        assertEquals(first, state.startPage(100, "granted"));
        state.changed();
        assertThrows(PhoneGalleryLibraryChangedException.class, () -> state.finishPage(first, "granted", "granted"));
        assertThrows(PhoneGalleryLibraryChangedException.class, () -> state.startPage(200, "granted"));
        long restarted = state.startPage(0, "granted");
        state.finishPage(restarted, "granted", "granted");
        assertEquals(restarted, state.startPage(100, "granted"));
    }

    @Test
    public void permissionScopeChangesInvalidateAPageEvenWithoutMediaChanges() throws Exception {
        PhoneGalleryListingState state = new PhoneGalleryListingState();
        long first = state.startPage(0, "granted");
        assertThrows(PhoneGalleryLibraryChangedException.class, () -> state.finishPage(first, "granted", "limited"));
        assertThrows(PhoneGalleryLibraryChangedException.class, () -> state.startPage(100, "limited"));
        state.startPage(0, "limited");
        state.startPage(100, "limited");
    }

    @Test
    public void fingerprintIsStableAcrossIndependentInstancesAndContainsOnlyADigest() {
        String[][] photos = { { "11", "1000", "2000", "4000", "640", "480", "0", "family.jpg", "1234", "90" } };
        String first = fingerprint("granted", "media-db-v1", photos);
        assertEquals(first, fingerprint("granted", "media-db-v1", photos));
        assertTrue(first.matches("android-v1:[0-9a-f]{64}"));
        assertNotEquals(first, fingerprint("limited", "media-db-v1", photos));
        assertNotEquals(first, fingerprint("granted", "media-db-v2", photos));
    }

    @Test
    public void fingerprintChangesForAdditionDeletionAndSameCountSelectionReplacement() {
        String[] firstPhoto = { "11", "1000", "640", "480" };
        String[] secondPhoto = { "12", "1000", "640", "480" };
        String first = fingerprint("limited", "db", new String[][] { firstPhoto });
        assertNotEquals(first, fingerprint("limited", "db", new String[][] {}));
        assertNotEquals(first, fingerprint("limited", "db", new String[][] { firstPhoto, secondPhoto }));
        assertNotEquals(first, fingerprint("limited", "db", new String[][] { secondPhoto }));
    }

    @Test
    public void fingerprintChangesForEachPhotoMetadataFieldIncludingEditGeneration() {
        String[] photo = { "11", "1000", "2000", "4000", "640", "480", "0", "family.jpg", "1234", "90" };
        String original = fingerprint("granted", "db", new String[][] { photo });
        for (int index = 0; index < photo.length; index++) {
            String[] changed = photo.clone();
            changed[index] = photo[index] + "1";
            assertNotEquals("Field " + index + " must affect the revision", original,
                fingerprint("granted", "db", new String[][] { changed }));
        }
    }

    @Test
    public void fingerprintFramesFieldsAndDistinguishesMissingMetadata() {
        assertNotEquals(fingerprint("granted", "db", new String[][] { { "a", "b:c" } }),
            fingerprint("granted", "db", new String[][] { { "a:b", "c" } }));
        assertNotEquals(fingerprint("granted", "db", new String[][] { { "1", null } }),
            fingerprint("granted", "db", new String[][] { { "1", "" } }));
        assertNotEquals(fingerprint("granted", "db", new String[][] { { "1", "2" } }),
            fingerprint("granted", "db", new String[][] { { "1" }, { "2" } }));
    }

    @Test
    public void revisionChecksDoNotResetOrInvalidateAnExistingPageSequence() throws Exception {
        PhoneGalleryListingState state = new PhoneGalleryListingState();
        long first = state.startPage(0, "granted");
        state.finishPage(state.currentRevision(), "granted", "granted");
        assertEquals(first, state.startPage(100, "granted"));
        state.changed();
        state.finishPage(state.currentRevision(), "granted", "granted");
        assertThrows(PhoneGalleryLibraryChangedException.class, () -> state.startPage(200, "granted"));
    }

    private static String fingerprint(String permission, String storeVersion, String[][] photos) {
        PhoneGalleryFingerprint fingerprint = new PhoneGalleryFingerprint(permission, storeVersion);
        for (String[] photo : photos) fingerprint.addPhoto(photo);
        return fingerprint.finish();
    }
}
