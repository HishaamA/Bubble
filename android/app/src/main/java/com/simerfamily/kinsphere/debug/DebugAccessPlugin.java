package com.simerfamily.kinsphere.debug;

import android.content.pm.ApplicationInfo;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.simerfamily.kinsphere.BuildConfig;

/** Reports test access only when this exact APK is both debug-signed and debuggable. */
@CapacitorPlugin(name = "DebugAccess")
public final class DebugAccessPlugin extends Plugin {

    @PluginMethod
    public void getStatus(PluginCall call) {
        int applicationFlags = getContext().getApplicationInfo().flags;
        JSObject result = new JSObject();
        result.put(
            "enabled",
            isEnabled(
                BuildConfig.DEBUG,
                BuildConfig.ENABLE_TEST_AUTH_BYPASS,
                applicationFlags
            )
        );
        call.resolve(result);
    }

    static boolean isEnabled(
        boolean debugBuild,
        boolean testAccessRequested,
        int applicationFlags
    ) {
        boolean debuggable =
            (applicationFlags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        return debugBuild && testAccessRequested && debuggable;
    }
}
