package com.simerfamily.kinsphere.gallery;

import static org.junit.Assert.*;
import org.junit.Test;

/** Pure contract checks: no gallery, service, permissions or network calls. */
public final class BackgroundGalleryScanPolicyTest {
    private static final String SCOPE = "member:family";
    private static final String KEY = "journal-photo:device-gallery:12:2026-09-14T00%3A00%3A00.000Z";
    private static final String SOURCE = "bubble-gallery:12?scope=member%3Afamily&v=2026-09-14T00%3A00%3A00.000Z";

    @Test public void acceptsCurrentScopedPhotoAndOptionalModifiedRevision() {
        BackgroundGalleryScanPolicy.photo(SCOPE, KEY, "12", SOURCE);
        assertEquals(1_789_344_000L, BackgroundGalleryScanPolicy.modifiedSeconds(SOURCE));
        BackgroundGalleryScanPolicy.photo(SCOPE, "journal-photo:device-gallery:12:", "12", "bubble-gallery:12?scope=member%3Afamily");
        assertEquals(-1, BackgroundGalleryScanPolicy.modifiedSeconds("bubble-gallery:12?scope=member%3Afamily"));
    }

    @Test public void refusesUnscopedCrossAccountAndUntrustedFileSources() {
        for (String source : new String[] { "file:///private/photo.jpg", "https://example.com/photo.jpg", "bubble-gallery:12?scope=other",
            SOURCE + "&scope=member%3Afamily", SOURCE + "&extra=secret", "bubble-gallery:12?scope=%broken", "bubble-gallery:12?scope=member%3Afamily&v=not-a-date" }) {
            assertThrows(RuntimeException.class, () -> BackgroundGalleryScanPolicy.photo(SCOPE, KEY, "12", source));
        }
        assertThrows(RuntimeException.class, () -> BackgroundGalleryScanPolicy.photo(SCOPE, "journal-photo:device-gallery:13:", "12", SOURCE));
        assertThrows(RuntimeException.class, () -> BackgroundGalleryScanPolicy.photo(SCOPE, KEY, "012", SOURCE));
        assertThrows(RuntimeException.class, () -> BackgroundGalleryScanPolicy.photo(SCOPE, KEY + "\n", "12", SOURCE));
    }

    @Test public void boundsMetadataAndOpaqueTokens() {
        assertThrows(RuntimeException.class, () -> BackgroundGalleryScanPolicy.scope("x".repeat(513)));
        assertThrows(RuntimeException.class, () -> BackgroundGalleryScanPolicy.scope(""));
        assertTrue(BackgroundGalleryScanPolicy.tokenMatches("current", "current"));
        assertFalse(BackgroundGalleryScanPolicy.tokenMatches(null, null));
        assertFalse(BackgroundGalleryScanPolicy.tokenMatches("old", "new"));
        assertEquals(1, BackgroundGalleryScanPolicy.resultLimit(-1));
        assertEquals(8, BackgroundGalleryScanPolicy.resultLimit(8));
        assertEquals(32, BackgroundGalleryScanPolicy.resultLimit(20000));
    }

    @Test public void repeatedModelFailureStopsTheJobUntilARealCheckpointSucceeds() {
        BackgroundGalleryScanPolicy.RuntimeBudget budget = new BackgroundGalleryScanPolicy.RuntimeBudget();
        assertFalse(budget.failed()); assertFalse(budget.failed()); assertTrue(budget.failed());
        assertTrue(budget.failed());
        budget.completed();
        assertFalse(budget.failed()); assertFalse(budget.failed()); assertTrue(budget.failed());
    }
}
