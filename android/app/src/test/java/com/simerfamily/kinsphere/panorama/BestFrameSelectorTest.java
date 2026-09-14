package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;
import org.junit.Test;

public class BestFrameSelectorTest {
    @Test public void keepsSharpestFrameAndSynchronizedPayload() {
        BestFrameSelector<Object> selector = new BestFrameSelector<>(500);
        Object first = new Object();
        Object sharp = new Object();
        assertTrue(selector.consider(first, 10, 100));
        assertTrue(selector.consider(sharp, 20, 200));
        assertFalse(selector.consider(new Object(), 15, 300));
        assertSame(sharp, selector.best(400));
    }

    @Test public void acceptsTexturelessWallsAndPrefersNewerTies() {
        BestFrameSelector<String> selector = new BestFrameSelector<>(500);
        assertTrue(selector.consider("wall", 0, 100));
        assertTrue(selector.consider("new wall", 0, 200));
        assertEquals("new wall", selector.best(200));
    }

    @Test public void staleSharpFrameDoesNotBlockSofterFreshFrame() {
        BestFrameSelector<String> selector = new BestFrameSelector<>(500);
        selector.consider("sharp", 100, 100);
        assertTrue(selector.consider("fresh", 1, 601));
        assertEquals("fresh", selector.best(601));
    }

    @Test public void expiresOnlyAfterAgeLimit() {
        BestFrameSelector<String> selector = new BestFrameSelector<>(500);
        selector.consider("frame", 1, 100);
        assertEquals("frame", selector.best(600));
        assertNull(selector.best(601));
        assertNull(selector.best(100));
    }

    @Test public void rejectsInvalidFramesWithoutBlockingValidTimestamp() {
        BestFrameSelector<String> selector = new BestFrameSelector<>(500);
        assertFalse(selector.consider(null, 1, 100));
        assertFalse(selector.consider("bad", Double.NaN, 100));
        assertFalse(selector.consider("bad", Double.POSITIVE_INFINITY, 100));
        assertFalse(selector.consider("bad", -1, 100));
        assertFalse(selector.consider("bad", 1, 0));
        assertFalse(selector.consider("bad", 1, -1));
        assertTrue(selector.consider("valid", 0, 100));
    }

    @Test public void rejectsReplayedOrBackwardTimestampsEvenAfterWeakerFrame() {
        BestFrameSelector<String> selector = new BestFrameSelector<>(500);
        selector.consider("sharp", 10, 100);
        assertFalse(selector.consider("soft", 1, 200));
        assertFalse(selector.consider("repeated", 100, 200));
        assertFalse(selector.consider("backward", 100, 150));
        assertEquals("sharp", selector.best(200));
    }

    @Test public void resetDropsOldFrameAndTimestampHistory() {
        BestFrameSelector<String> selector = new BestFrameSelector<>(500);
        selector.consider("old target", 100, 1000);
        selector.reset();
        assertNull(selector.best(1000));
        assertTrue(selector.consider("new target", 0, 100));
        assertEquals("new target", selector.best(100));
    }

    @Test public void backwardClockInvalidatesStoredFrame() {
        BestFrameSelector<String> selector = new BestFrameSelector<>(500);
        selector.consider("frame", 1, 100);
        assertNull(selector.best(99));
        assertNull(selector.best(100));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsNonPositiveLifetime() {
        new BestFrameSelector<>(0);
    }
}
