package com.simerfamily.kinsphere.panorama;

import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;

/** Owner-scoped Capacitor API for the offline engine and durable capture recovery. */
@CapacitorPlugin(name = "PanoramaStitch")
public final class PanoramaStitchPlugin extends Plugin {
    @PluginMethod public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        boolean available = false;
        try {
            String[] assets = getContext().getAssets().list("stitch-models");
            available = assets != null && java.util.Arrays.stream(assets).filter(name -> name.endsWith(".onnx")).count() >= 2;
        } catch (IOException ignored) { }
        result.put("available", available);
        result.put("offline", true);
        result.put("model", "DISK + LightGlue");
        result.put("platform", "android");
        result.put("sdk", Build.VERSION.SDK_INT);
        result.put("originalsRetained", true);
        call.resolve(result);
    }

    @PluginMethod public void startStitch(PluginCall call) {
        try {
            call.resolve(new JSObject(PanoramaStitchService.start(getContext(), call.getString("directoryUrl"),
                call.getString("ownerKey"), call.getInt("outputWidth", 4096)).toString()));
        } catch (Exception error) { call.reject(error.getMessage(), "STITCH_START_FAILED", error); }
    }

    @PluginMethod public void getJob(PluginCall call) {
        try {
            call.resolve(new JSObject(PanoramaStitchService.getJob(getContext(), call.getString("jobId"), call.getString("ownerKey")).toString()));
        } catch (Exception error) { call.reject(error.getMessage(), "JOB_UNAVAILABLE", error); }
    }

    @PluginMethod public void cancelStitch(PluginCall call) {
        try {
            PanoramaStitchService.cancel(call.getString("jobId"), call.getString("ownerKey"));
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage(), "INVALID_PROFILE", error); }
    }

    @PluginMethod public void getCaptures(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("captures", new PanoramaCaptureStore(getContext()).list(call.getString("ownerKey")));
            call.resolve(result);
        } catch (Exception error) { call.reject(error.getMessage(), "CAPTURE_RECOVERY_FAILED", error); }
    }
}
