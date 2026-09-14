package com.simerfamily.kinsphere.gallery;

import android.Manifest;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

/** Same 1600px, orientation-aware JPEG path as the visible gallery; memory only. */
final class BackgroundGalleryPhotoReader {
    private BackgroundGalleryPhotoReader() {}

    static void requireAccess(Context context) {
        boolean allowed = Build.VERSION.SDK_INT >= 33
            ? ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED ||
                (Build.VERSION.SDK_INT >= 34 && ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED)
            : ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        if (!allowed) throw new SecurityException("Reconnect photo access in Bubble.");
    }

    static String verify(Context context, BackgroundGalleryScanStore.Photo photo) throws IOException {
        requireAccess(context);
        Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, PhoneGalleryLimits.mediaId(photo.nativeId));
        String selection = Build.VERSION.SDK_INT >= 30 ? "is_pending=0 AND is_trashed=0" : Build.VERSION.SDK_INT >= 29 ? "is_pending=0" : null;
        String[] columns = { MediaStore.Images.Media.MIME_TYPE, MediaStore.Images.Media.SIZE, MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.WIDTH, MediaStore.Images.Media.HEIGHT, MediaStore.Images.Media.ORIENTATION };
        try (Cursor cursor = context.getContentResolver().query(uri, columns, selection, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new IOException("This photo is no longer available.");
            String mime = cursor.getString(0);
            long size = cursor.getLong(1), modified = cursor.getLong(2);
            if (mime == null || !mime.startsWith("image/") || size > 150L * 1024 * 1024 || cursor.getInt(3) <= 0 || cursor.getInt(4) <= 0) {
                throw new IOException("This photo format cannot be checked.");
            }
            long expected = BackgroundGalleryScanPolicy.modifiedSeconds(photo.source);
            if (expected >= 0 && expected != modified) throw new IOException("This photo changed. Refresh your gallery in Bubble.");
            return mime + ":" + size + ":" + modified + ":" + cursor.getInt(3) + ":" + cursor.getInt(4) + ":" + cursor.getInt(5);
        }
    }

    static byte[] read(Context context, BackgroundGalleryScanStore.Photo photo) throws IOException {
        String before = verify(context, photo);
        Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, PhoneGalleryLimits.mediaId(photo.nativeId));
        Bitmap bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.getContentResolver(), uri), (decoder, info, source) -> {
            int[] target = PhoneGalleryLimits.targetSize(info.getSize().getWidth(), info.getSize().getHeight(), 1600);
            decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            decoder.setTargetSize(target[0], target[1]);
        });
        try {
            if (bitmap == null) throw new IOException("Photo could not be decoded.");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 85, bytes) || bytes.size() > 4 * 1024 * 1024) throw new IOException("Photo preview is too large.");
            if (!before.equals(verify(context, photo))) throw new IOException("Photo access changed while reading.");
            return bytes.toByteArray();
        } finally { if (bitmap != null) bitmap.recycle(); }
    }
}
