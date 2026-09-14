package com.simerfamily.kinsphere.appearance;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import org.junit.Test;

public final class AppIconPluginTest {
    @Test public void mapsOnlyKnownThemesToLauncherAliasesNeverMainActivity() {
        assertEquals(".PlumLauncher", AppIconPlugin.aliasFor("plum"));
        assertEquals(".ForestLauncher", AppIconPlugin.aliasFor("forest"));
        assertEquals(".MidnightLauncher", AppIconPlugin.aliasFor("midnight"));
        assertThrows(IllegalArgumentException.class, () -> AppIconPlugin.aliasFor(null));
        assertThrows(IllegalArgumentException.class, () -> AppIconPlugin.aliasFor(".MainActivity"));
        assertThrows(IllegalArgumentException.class, () -> AppIconPlugin.aliasFor("neon"));
    }
}
