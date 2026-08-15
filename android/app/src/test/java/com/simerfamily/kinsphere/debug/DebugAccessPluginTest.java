package com.simerfamily.kinsphere.debug;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.pm.ApplicationInfo;
import org.junit.Test;

public final class DebugAccessPluginTest {

    @Test
    public void requiresDebugBuildExplicitRequestAndDebuggableApplication() {
        int debuggable = ApplicationInfo.FLAG_DEBUGGABLE;

        assertTrue(DebugAccessPlugin.isEnabled(true, true, debuggable));
        assertFalse(DebugAccessPlugin.isEnabled(false, true, debuggable));
        assertFalse(DebugAccessPlugin.isEnabled(true, false, debuggable));
        assertFalse(DebugAccessPlugin.isEnabled(true, true, 0));
    }
}
