package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Physical-device smoke test for an ARCore-backed capture activity. */
@RunWith(AndroidJUnit4.class)
public final class PanoramaCaptureInstrumentedTest {

    @Test
    public void launchesArCoreCaptureWithoutCrashing() {
        Context applicationContext = ApplicationProvider.getApplicationContext();
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(
            applicationContext.getPackageName(),
            Manifest.permission.CAMERA
        );
        Intent captureIntent = new Intent(applicationContext, PanoramaCaptureActivity.class);
        captureIntent.putExtra(
            PanoramaCaptureActivity.EXTRA_OPTIONS_JSON,
            "{\"mode\":\"standard\",\"outputWidth\":2048}"
        );

        try (
            ActivityScenario<PanoramaCaptureActivity> scenario =
                ActivityScenario.launch(captureIntent)
        ) {
            // Allow ARCore to create the session and render several synchronized frames.
            SystemClock.sleep(3_000L);
            scenario.onActivity(activity -> {
                assertFalse(activity.isFinishing());
                assertNotNull(activity.findViewById(android.R.id.content));
            });
        }
    }
}
