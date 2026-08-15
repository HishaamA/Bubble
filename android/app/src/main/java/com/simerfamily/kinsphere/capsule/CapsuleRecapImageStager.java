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

    private final CapsuleRecapFiles files;

    CapsuleRecapImageStager(CapsuleRecapFiles files) {
        this.files = files;
    }

    File stage(String dataUrl) throws IOException {
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

        BitmapFactory.Options decode = new BitmapFactory.Options();
        decode.inPreferredConfig = Bitmap.Config.ARGB_8888;
        decode.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight);
        Bitmap source;
        try {
            source = BitmapFactory.decodeByteArray(sourceData, 0, sourceData.length, decode);
        } catch (OutOfMemoryError error) {
            throw new IOException("This image is too large to prepare safely on this device.", error);
        }
        if (source == null) {
            throw new IOException("This capsule image could not be decoded.");
        }
        sourceData = null;

        Bitmap normalized = null;
        File temporary = null;
        try {
            normalized = normalizedBitmap(source);
            File destination = files.createStagedImageFile();
            temporary = new File(destination.getParentFile(), destination.getName() + ".tmp");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                if (!normalized.compress(Bitmap.CompressFormat.JPEG, 90, output)) {
                    throw new IOException("This capsule image could not be prepared.");
                }
                output.getFD().sync();
            }
            if (!temporary.renameTo(destination)) {
                throw new IOException("This capsule image could not be prepared.");
            }
            temporary = null;
            return destination;
        } finally {
            if (temporary != null) {
                //noinspection ResultOfMethodCallIgnored -- best-effort failed-stage cleanup.
                temporary.delete();
            }
            if (normalized != null && normalized != source && !normalized.isRecycled()) {
                normalized.recycle();
            }
            if (!source.isRecycled()) {
                source.recycle();
            }
        }
    }

    private static int sampleSize(int width, int height) {
        int sample = 1;
        int longEdge = Math.max(width, height);
        while (longEdge / (sample * 2) >= CapsuleRecapContract.MAXIMUM_STAGED_LONG_EDGE) {
            sample *= 2;
        }
        return sample;
    }

    private static Bitmap normalizedBitmap(Bitmap source) throws IOException {
        int longEdge = Math.max(source.getWidth(), source.getHeight());
        float scale = longEdge > CapsuleRecapContract.MAXIMUM_STAGED_LONG_EDGE
            ? (float) CapsuleRecapContract.MAXIMUM_STAGED_LONG_EDGE / longEdge
            : 1f;
        int width = Math.max(1, Math.round(source.getWidth() * scale));
        int height = Math.max(1, Math.round(source.getHeight() * scale));

        final Bitmap output;
        try {
            output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        } catch (OutOfMemoryError error) {
            throw new IOException("This image is too large to prepare safely on this device.", error);
        }
        Canvas canvas = new Canvas(output);
        canvas.drawColor(Color.BLACK);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG | Paint.DITHER_FLAG);
        canvas.drawBitmap(source, null, new android.graphics.Rect(0, 0, width, height), paint);
        return output;
    }
}
