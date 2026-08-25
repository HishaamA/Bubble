package com.simerfamily.kinsphere.cardboard;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class CardboardPanoramaPluginTest {

    @Test
    public void mapsSupportedImageMimeTypesToStableCacheExtensions() {
        assertEquals(".jpg", CardboardPanoramaPlugin.extensionForMimeType("image/jpeg"));
        assertEquals(".png", CardboardPanoramaPlugin.extensionForMimeType("IMAGE/PNG"));
        assertEquals(".webp", CardboardPanoramaPlugin.extensionForMimeType("image/webp"));
        assertEquals(".jpg", CardboardPanoramaPlugin.extensionForMimeType(null));
    }

    @Test
    public void rejectsNonFiniteInitialAngles() {
        assertEquals(4.0, CardboardPanoramaPlugin.finiteOrDefault(4.0, 0.0), 0.0);
        assertEquals(0.0, CardboardPanoramaPlugin.finiteOrDefault(null, 0.0), 0.0);
        assertEquals(0.0, CardboardPanoramaPlugin.finiteOrDefault(Double.NaN, 0.0), 0.0);
        assertEquals(
            0.0,
            CardboardPanoramaPlugin.finiteOrDefault(Double.POSITIVE_INFINITY, 0.0),
            0.0
        );
    }
}
