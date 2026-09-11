package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/** Unit coverage for the widget store's privacy-first transaction ordering. */
public final class BubbleWidgetStoreTest {

    @Test
    public void installsPrivateBoundaryBeforeWritingPayload() throws IOException {
        List<String> steps = new ArrayList<>();

        BubbleWidgetStore.runPrivacyTransaction(
            () -> steps.add("private"),
            () -> steps.add("payload"),
            () -> steps.add("recover")
        );

        assertEquals(Arrays.asList("private", "payload"), steps);
    }

    @Test
    public void restoresPrivateBoundaryWhenPayloadWriteFails() {
        List<String> steps = new ArrayList<>();

        assertThrows(
            IOException.class,
            () -> BubbleWidgetStore.runPrivacyTransaction(
                () -> steps.add("private"),
                () -> {
                    steps.add("payload");
                    throw new IOException("disk full");
                },
                () -> steps.add("recover")
            )
        );

        assertEquals(Arrays.asList("private", "payload", "recover"), steps);
    }

    @Test
    public void doesNotTouchPayloadWhenPrivateBoundaryFails() {
        List<String> steps = new ArrayList<>();

        assertThrows(
            IOException.class,
            () -> BubbleWidgetStore.runPrivacyTransaction(
                () -> {
                    steps.add("private");
                    throw new IOException("commit failed");
                },
                () -> steps.add("payload"),
                () -> steps.add("recover")
            )
        );

        assertEquals(Arrays.asList("private", "recover"), steps);
    }

    @Test
    public void restoresPrivateBoundaryAfterUncheckedStorageFailure() {
        List<String> steps = new ArrayList<>();

        assertThrows(
            SecurityException.class,
            () -> BubbleWidgetStore.runPrivacyTransaction(
                () -> steps.add("private"),
                () -> {
                    steps.add("payload");
                    throw new SecurityException("storage denied");
                },
                () -> steps.add("recover")
            )
        );

        assertEquals(Arrays.asList("private", "payload", "recover"), steps);
    }

    @Test
    public void preferencesBoundaryStillRunsWhenMarkerWriteFails() throws IOException {
        List<String> steps = new ArrayList<>();

        BubbleWidgetStore.establishPrivacyBoundary(
            () -> {
                steps.add("marker");
                throw new IOException("marker unavailable");
            },
            () -> steps.add("preferences")
        );

        assertEquals(Arrays.asList("marker", "preferences"), steps);
    }

    @Test
    public void markerKeepsBoundaryValidWhenPreferencesCommitFails() throws IOException {
        List<String> steps = new ArrayList<>();

        BubbleWidgetStore.establishPrivacyBoundary(
            () -> steps.add("marker"),
            () -> {
                steps.add("preferences");
                throw new IOException("commit failed");
            }
        );

        assertEquals(Arrays.asList("marker", "preferences"), steps);
    }

    @Test
    public void redundantBoundaryFailsOnlyWhenBothWritesFail() {
        List<String> steps = new ArrayList<>();

        assertThrows(
            IOException.class,
            () -> BubbleWidgetStore.establishPrivacyBoundary(
                () -> {
                    steps.add("marker");
                    throw new IOException("marker unavailable");
                },
                () -> {
                    steps.add("preferences");
                    throw new IOException("commit failed");
                }
            )
        );

        assertEquals(Arrays.asList("marker", "preferences"), steps);
    }
}
