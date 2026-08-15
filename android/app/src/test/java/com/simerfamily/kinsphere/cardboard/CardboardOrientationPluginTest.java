package com.simerfamily.kinsphere.cardboard;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.content.pm.ActivityInfo;
import org.junit.Test;

public final class CardboardOrientationPluginTest {

    @Test
    public void keepsTheFirstOrientationUntilTheCardboardSessionIsRestored() {
        CardboardOrientationPlugin.OrientationSession session =
            new CardboardOrientationPlugin.OrientationSession();

        session.rememberIfNeeded(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        session.rememberIfNeeded(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);

        assertEquals(
            Integer.valueOf(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT),
            session.previousOrientation()
        );

        session.markRestored();
        assertNull(session.previousOrientation());
    }

    @Test
    public void canRememberAnewAfterACompletedRestoration() {
        CardboardOrientationPlugin.OrientationSession session =
            new CardboardOrientationPlugin.OrientationSession();

        session.rememberIfNeeded(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        session.markRestored();
        session.rememberIfNeeded(ActivityInfo.SCREEN_ORIENTATION_USER);

        assertEquals(
            Integer.valueOf(ActivityInfo.SCREEN_ORIENTATION_USER),
            session.previousOrientation()
        );
    }

    @Test
    public void reportsStableOrientationLabelsToTheSharedBridge() {
        assertEquals(
            "landscape",
            CardboardOrientationPlugin.orientationLabel(
                ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            )
        );
        assertEquals(
            "portrait",
            CardboardOrientationPlugin.orientationLabel(
                ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
            )
        );
        assertEquals(
            "unspecified",
            CardboardOrientationPlugin.orientationLabel(
                ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            )
        );
    }
}
