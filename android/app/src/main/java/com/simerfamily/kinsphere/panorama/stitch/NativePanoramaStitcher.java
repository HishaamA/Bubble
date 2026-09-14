package com.simerfamily.kinsphere.panorama.stitch;

import androidx.annotation.Keep;

/** Calibrated visual reconstruction; call from a worker, never the UI thread. */
@Keep
public final class NativePanoramaStitcher {
    static {
        System.loadLibrary("bubble_stitcher");
    }

    private NativePanoramaStitcher() {}

    /** Invoked synchronously on the stitching worker. Implementations must be thread-safe. */
    @Keep
    public interface ProgressCallback {
        void onProgress(int percent, String stage);
        boolean isCancelled();
    }

    /**
     * Inputs: {frames:[{filePath,width,height,intrinsics:[9],transform:[16]}]} and
     * {model,aiUsed,pairs:[{i,j,points0:[[x,y]],points1:[[x,y]]}]}.
     * Images and match coordinates must already be upright. Missing transforms are
     * supported only with a connected visual match graph. No pose-only fallback.
     * Returns {state:"completed",panoramaPath,thumbnailPath,width,height,report},
     * {state:"failed",code,reasonCode,error,report?}, or {state:"cancelled",...}.
     * Native code keeps originals and existing output files intact on failure.
     */
    @Keep
    public static native String stitch(String normalizedManifestJson, String outputDirectory,
        String matchesJson, int outputWidth, ProgressCallback callback);
}
