package com.simerfamily.kinsphere.capsule;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/** Decodes, bounds, normalizes, and metadata-strips one bridge image. */
final class CapsuleRecapImageStager {

    private final CapsuleRecapFiles recapFiles;

    /** Uses the supplied cache boundary for every staged output. */
    CapsuleRecapImageStager(CapsuleRecapFiles recapFiles) {
        this.recapFiles = recapFiles;
    }

    /** Produces an orientation-normalized, bounded JPEG through an atomic cache write. */
    File stage(String dataUrl) throws IOException {
        ensureStagingActive();
        if (dataUrl == null) {
            throw new IOException("Choose a valid image for the capsule recap.");
        }
        if (dataUrl.length() > CapsuleRecapContract.MAXIMUM_DATA_URL_CHARACTERS) {
            throw new IOException("This image is too large to prepare safely on this device.");
        }
        if (!CapsuleRecapContract.hasSupportedImageDataUrlHeader(dataUrl)) {
            throw new IOException("Choose a valid image for the capsule recap.");
        }

        int separator = dataUrl.indexOf(',');
        byte[] sourceData;
        try {
            sourceData = Base64.decode(dataUrl.substring(separator + 1), Base64.DEFAULT);
        } catch (IllegalArgumentException exception) {
            throw new IOException("Choose a valid image for the capsule recap.", exception);
        } catch (OutOfMemoryError error) {
            throw new IOException("This image is too large to prepare safely on this device.", error);
        }
        if (sourceData.length == 0) {
            throw new IOException("Choose a valid image for the capsule recap.");
        }
        ensureStagingActive();

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(sourceData, 0, sourceData.length, bounds);
        if (
            bounds.outWidth <= 0 ||
            bounds.outHeight <= 0 ||
            (long) bounds.outWidth * bounds.outHeight > CapsuleRecapContract.MAXIMUM_DECODED_PIXELS
        ) {
            throw new IOException("This image is too large to prepare safely on this device.");
        }

        BitmapFactory.Options decodeOptions = new BitmapFactory.Options();
        decodeOptions.inPreferredConfig = Bitmap.Config.ARGB_8888;
        decodeOptions.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight);
        Bitmap sourceBitmap;
        try {
            sourceBitmap = BitmapFactory.decodeByteArray(
                sourceData,
                0,
                sourceData.length,
                decodeOptions
            );
        } catch (OutOfMemoryError error) {
            throw new IOException("This image is too large to prepare safely on this device.", error);
        }
        if (sourceBitmap == null) {
            throw new IOException("This capsule image could not be decoded.");
        }
        sourceData = null;

        Bitmap normalizedBitmap = null;
        File temporaryFile = null;
        try {
            ensureStagingActive();
            normalizedBitmap = normalizedBitmap(sourceBitmap);
            File destinationFile = recapFiles.createStagedImageFile();
            temporaryFile = new File(
                destinationFile.getParentFile(),
                destinationFile.getName() + ".tmp"
            );
            try (FileOutputStream outputStream = new FileOutputStream(temporaryFile)) {
                if (!normalizedBitmap.compress(Bitmap.CompressFormat.JPEG, 90, outputStream)) {
                    throw new IOException("This capsule image could not be prepared.");
                }
                outputStream.getFD().sync();
            }
            ensureStagingActive();
            if (!temporaryFile.renameTo(destinationFile)) {
                throw new IOException("This capsule image could not be prepared.");
            }
            temporaryFile = null;
            return destinationFile;
        } finally {
            if (temporaryFile != null) {
                //noinspection ResultOfMethodCallIgnored -- best-effort failed-stage cleanup.
                temporaryFile.delete();
            }
            if (
                normalizedBitmap != null &&
                normalizedBitmap != sourceBitmap &&
                !normalizedBitmap.isRecycled()
            ) {
                normalizedBitmap.recycle();
            }
            if (!sourceBitmap.isRecycled()) {
                sourceBitmap.recycle();
            }
        }
    }

    /** Chooses the largest power-of-two decode sample that stays near the staging limit. */
    private static int sampleSize(int width, int height) {
        int sample = 1;
        int longEdge = Math.max(width, height);
        while (longEdge / (sample * 2) >= CapsuleRecapContract.MAXIMUM_STAGED_LONG_EDGE) {
            sample *= 2;
        }
        return sample;
    }

    /** Removes metadata and alpha while resizing the decoded image to a safe long edge. */
    private static Bitmap normalizedBitmap(Bitmap source) throws IOException {
        int longEdge = Math.max(source.getWidth(), source.getHeight());
        float scale = longEdge > CapsuleRecapContract.MAXIMUM_STAGED_LONG_EDGE
            ? (float) CapsuleRecapContract.MAXIMUM_STAGED_LONG_EDGE / longEdge
            : 1f;
        int width = Math.max(1, Math.round(source.getWidth() * scale));
        int height = Math.max(1, Math.round(source.getHeight() * scale));

        Bitmap output = null;
        try {
            output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(output);
            canvas.drawColor(Color.BLACK);
            Paint paint = new Paint(
                Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG | Paint.DITHER_FLAG
            );
            canvas.drawBitmap(source, null, new android.graphics.Rect(0, 0, width, height), paint);
            return output;
        } catch (OutOfMemoryError error) {
            if (output != null && !output.isRecycled()) {
                output.recycle();
            }
            throw new IOException("This image is too large to prepare safely on this device.", error);
        } catch (RuntimeException error) {
            if (output != null && !output.isRecycled()) {
                output.recycle();
            }
            throw new IOException("This capsule image could not be prepared.", error);
        }
    }

    /** Converts worker interruption into the staging operation's checked cancellation contract. */
    private static void ensureStagingActive() throws IOException {
        if (Thread.currentThread().isInterrupted()) {
            throw new IOException("The capsule image preparation was cancelled.");
        }
    }
}
