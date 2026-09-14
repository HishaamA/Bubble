package com.simerfamily.kinsphere.appearance;

import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

/** Switches launcher aliases without disabling the app's real deep-link activity. */
@CapacitorPlugin(name = "AppIcon")
public final class AppIconPlugin extends Plugin {
    private static final String[] THEMES = { "plum", "forest", "midnight" };

    static String aliasFor(String theme) {
        if ("plum".equals(theme)) return ".PlumLauncher";
        if ("forest".equals(theme)) return ".ForestLauncher";
        if ("midnight".equals(theme)) return ".MidnightLauncher";
        throw new IllegalArgumentException("Unsupported appearance theme.");
    }

    @PluginMethod
    public void setTheme(PluginCall call) {
        String theme = call.getString("theme");
        try {
            aliasFor(theme);
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage(), "INVALID_THEME");
            return;
        }
        try {
            PackageManager manager = getContext().getPackageManager();
            String packageName = getContext().getPackageName();
            List<PackageManager.ComponentEnabledSetting> settings = new ArrayList<>();
            List<ComponentName> disableAfterEnable = new ArrayList<>();
            ComponentName target = new ComponentName(packageName, packageName + aliasFor(theme));
            boolean changed = false;

            // Validate every manifest entry before changing any component state.
            for (String candidate : THEMES) {
                ComponentName component = new ComponentName(packageName, packageName + aliasFor(candidate));
                boolean defaultEnabled = manager.getActivityInfo(component, PackageManager.MATCH_DISABLED_COMPONENTS).enabled;
                int current = manager.getComponentEnabledSetting(component);
                boolean enabled = current == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    || (current == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && defaultEnabled);
                boolean desired = candidate.equals(theme);
                changed |= enabled != desired;
                if (Build.VERSION.SDK_INT >= 33) {
                    settings.add(new PackageManager.ComponentEnabledSetting(component,
                        desired ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP));
                }
                if (!desired && enabled) disableAfterEnable.add(component);
            }
            if (changed) {
                if (Build.VERSION.SDK_INT >= 33) {
                    // Atomic on modern Android: launchers never observe zero or two icons.
                    manager.setComponentEnabledSettings(settings);
                } else {
                    // Older Android still always has a working launcher entry.
                    manager.setComponentEnabledSetting(target, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
                    for (ComponentName component : disableAfterEnable) {
                        manager.setComponentEnabledSetting(component, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("status", changed ? "updated" : "unchanged");
            result.put("theme", theme);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("The launcher could not change the app icon. Your theme is still saved.", "ICON_UPDATE_FAILED", error);
        }
    }
}
