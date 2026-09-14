package com.simerfamily.kinsphere.gallery;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Explicit native work control. Merely loading this plugin starts no scan or prompt. */
@CapacitorPlugin(name = "BackgroundGalleryScan", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public final class BackgroundGalleryScanPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private BackgroundGalleryScanStore store;
    private boolean permissionPending;

    @Override public void load() { store = new BackgroundGalleryScanStore(getContext()); }

    @PluginMethod public void getNotificationPermission(PluginCall call) { call.resolve(notificationState()); }
    @PluginMethod public synchronized void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || "granted".equals(notificationStatus())) { call.resolve(notificationState()); return; }
        if (permissionPending) { call.reject("A notification permission request is already open.", "PERMISSION_REQUEST_ACTIVE"); return; }
        permissionPending = true;
        try { requestPermissionForAlias("notifications", call, "notificationFinished"); }
        catch (RuntimeException failure) { permissionPending = false; call.reject("Notification permission could not be requested.", "PERMISSION_REQUEST_FAILED"); }
    }
    @PermissionCallback private synchronized void notificationFinished(PluginCall call) {
        permissionPending = false;
        if (call != null) call.resolve(notificationState());
    }

    @PluginMethod public void start(PluginCall call) { run(call, () -> {
        requireStart();
        String scope = scope(call);
        BackgroundGalleryPhotoReader.requireAccess(getContext());
        store.reconcile(scope, call.getString("revision"), call.getArray("photos"));
        launchIfRunning(scope);
        return store.state(scope, 8);
    }); }

    @PluginMethod public void getState(PluginCall call) { run(call, () -> {
        String scope = scope(call);
        BackgroundGalleryScanStore.Owner owner = store.owner();
        if (owner != null && scope.equals(owner.scope)) {
            try { BackgroundGalleryPhotoReader.requireAccess(getContext()); }
            catch (SecurityException error) {
                store.cancel(scope); getContext().stopService(new Intent(getContext(), BackgroundGalleryScanService.class));
                throw error;
            }
        }
        return store.state(scope, call.getInt("limit", 8));
    }); }

    @PluginMethod public void ack(PluginCall call) { run(call, () -> {
        String scope = scope(call); store.ack(scope, call.getArray("entries")); return store.state(scope, 8);
    }); }
    @PluginMethod public void pause(PluginCall call) { run(call, () -> {
        String scope = scope(call); store.pause(scope, "manual"); return store.state(scope, 8);
    }); }
    @PluginMethod public void resume(PluginCall call) { resume(call, false); }
    @PluginMethod public void retry(PluginCall call) { resume(call, true); }
    private void resume(PluginCall call, boolean retry) { run(call, () -> {
        requireStart(); String scope = scope(call); BackgroundGalleryPhotoReader.requireAccess(getContext());
        store.resume(scope, retry); launchIfRunning(scope); return store.state(scope, 8);
    }); }
    @PluginMethod public void cancel(PluginCall call) { run(call, () -> {
        String scope = scope(call);
        BackgroundGalleryScanStore.Owner owner = store.owner();
        if (owner != null && scope.equals(owner.scope)) {
            store.cancel(scope); getContext().stopService(new Intent(getContext(), BackgroundGalleryScanService.class));
        }
        return store.state(scope, 8);
    }); }
    /** Auth resolution can revoke a departed owner without mounting Journal. */
    @PluginMethod public void retainScope(PluginCall call) { run(call, () -> {
        String scope = scope(call);
        if (store.retainScope(scope)) getContext().stopService(new Intent(getContext(), BackgroundGalleryScanService.class));
        return store.state(scope, 0);
    }); }

    private String scope(PluginCall call) { return BackgroundGalleryScanPolicy.scope(call.getString("scope")); }
    private void requireStart() {
        if (Build.VERSION.SDK_INT < 28) throw new ScanUnavailable("UNAVAILABLE", "Background checking requires Android 9 or newer.");
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed() ||
            !(activity instanceof androidx.lifecycle.LifecycleOwner) || !((androidx.lifecycle.LifecycleOwner) activity).getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) {
            throw new ScanUnavailable("APP_NOT_VISIBLE", "Open Bubble before starting background checking.");
        }
        if (!"granted".equals(notificationStatus())) throw new ScanUnavailable("NOTIFICATIONS_REQUIRED", "Allow notifications to use cancellable background checking.");
    }
    private void launchIfRunning(String scope) {
        BackgroundGalleryScanStore.Owner owner = store.owner();
        if (owner == null || !scope.equals(owner.scope) || !"running".equals(owner.status)) return;
        try { ContextCompat.startForegroundService(getContext(), new Intent(getContext(), BackgroundGalleryScanService.class).putExtra("scope", scope).putExtra("generation", owner.generation)); }
        catch (RuntimeException error) {
            store.pauseIfCurrent(scope, owner.generation, "interrupted");
            throw new ScanUnavailable("START_FAILED", "Android could not start background checking. Keep Bubble open and retry.");
        }
    }
    private String notificationStatus() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return getPermissionState("notifications") == PermissionState.DENIED ? "denied" : "prompt";
        }
        android.app.NotificationChannel channel = getContext().getSystemService(android.app.NotificationManager.class).getNotificationChannel("bubble-gallery-checking");
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() &&
            (channel == null || channel.getImportance() != android.app.NotificationManager.IMPORTANCE_NONE) ? "granted" : "denied";
    }
    private JSObject notificationState() { JSObject value = new JSObject(); value.put("status", notificationStatus()); return value; }
    private interface Work { JSONObject execute() throws Exception; }
    private void run(PluginCall call, Work work) {
        try {
            executor.execute(() -> {
                try { call.resolve(new JSObject(work.execute().toString())); }
                catch (ScanUnavailable error) { call.reject(error.getMessage(), error.code); }
                catch (SecurityException error) { call.reject("Photo access changed. Reconnect the gallery in Bubble.", "PERMISSION_REQUIRED"); }
                catch (IllegalArgumentException error) { call.reject("The gallery scan request is invalid.", "INVALID_SCAN"); }
                catch (Exception error) { call.reject("Background checking could not save its progress. Free some storage and retry.", "SCAN_STORAGE_FAILED"); }
            });
        } catch (RuntimeException error) { call.reject("Background checking is unavailable.", "UNAVAILABLE"); }
    }
    @Override protected void handleOnDestroy() {
        // The service owns its own process/store. Closing the UI must not cancel it.
        executor.execute(() -> { if (store != null) store.close(); });
        executor.shutdown();
        super.handleOnDestroy();
    }
    private static final class ScanUnavailable extends RuntimeException {
        final String code;
        ScanUnavailable(String code, String message) { super(message); this.code = code; }
    }
}
