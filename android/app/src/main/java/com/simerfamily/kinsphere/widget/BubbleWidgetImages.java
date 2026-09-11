package com.simerfamily.kinsphere.widget;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import java.util.Locale;

/** Bounded decoding for untrusted image strings crossing the web/native bridge. */
final class BubbleWidgetImages {

    static final int MAX_BASE64_CHARACTERS = 6_000_000;
    static final int MAX_DECODED_BYTES = 4_500_000;
    static final int MAX_SOURCE_EDGE = 8_192;
    static final long MAX_SOURCE_PIXELS = 24_000_000L;
    static final int STORED_EDGE = 512;

    private BubbleWidgetImages() {}

    static Bitmap decodeThumbnail(String encoded) {
        if (encoded == null || encoded.trim().isEmpty()) {
            return null;
        }
        if (encoded.length() > MAX_BASE64_CHARACTERS) {
            throw new IllegalArgumentException("thumbnailBase64 is too large.");
        }

        String payload = encoded.trim();
        if (payload.startsWith("data:")) {
            int comma = payload.indexOf(',');
            if (comma < 0 || comma > 96) {
                throw new IllegalArgumentException("thumbnailBase64 has an invalid data URL.");
            }
            String descriptor = payload.substring(5, comma).toLowerCase(Locale.US);
            if (
                !descriptor.endsWith(";base64") ||
                (!descriptor.startsWith("image/jpeg") &&
                    !descriptor.startsWith("image/png") &&
                    !descriptor.startsWith("image/webp"))
            ) {
                throw new IllegalArgumentException("thumbnailBase64 must be a JPEG, PNG, or WebP image.");
            }
            payload = payload.substring(comma + 1);
        }

        final byte[] bytes;
        try {
            bytes = Base64.decode(payload, Base64.DEFAULT);
        } catch (IllegalArgumentException exception) {
            throw new IllegalArgumentException("thumbnailBase64 is not valid base64.", exception);
        }
        if (bytes.length == 0 || bytes.length > MAX_DECODED_BYTES) {
            throw new IllegalArgumentException("thumbnailBase64 has an unsupported size.");
        }

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (
            bounds.outWidth <= 0 ||
            bounds.outHeight <= 0 ||
            bounds.outWidth > MAX_SOURCE_EDGE ||
            bounds.outHeight > MAX_SOURCE_EDGE ||
            ((long) bounds.outWidth * bounds.outHeight) > MAX_SOURCE_PIXELS
        ) {
            throw new IllegalArgumentException("thumbnailBase64 is not a supported image.");
        }

        int sampleSize = 1;
        while (
            (bounds.outWidth / sampleSize) > STORED_EDGE * 2 ||
            (bounds.outHeight / sampleSize) > STORED_EDGE * 2
        ) {
            sampleSize *= 2;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize;
        options.inPreferredConfig = Bitmap.Config.RGB_565;
        Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (decoded == null) {
            throw new IllegalArgumentException("thumbnailBase64 could not be decoded.");
        }

        int width = decoded.getWidth();
        int height = decoded.getHeight();
        float scale = Math.min(1f, (float) STORED_EDGE / Math.max(width, height));
        if (scale >= 1f) {
            return decoded;
        }
        Bitmap scaled = Bitmap.createScaledBitmap(
            decoded,
            Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)),
            true
        );
        if (scaled != decoded) {
            decoded.recycle();
        }
        return scaled;
    }
}
