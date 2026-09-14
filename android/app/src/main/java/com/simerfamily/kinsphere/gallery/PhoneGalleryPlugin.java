package com.simerfamily.kinsphere.gallery;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.ContentObserver;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Read-only, opt-in access to existing local photos. Only opaque MediaStore IDs
 * cross the bridge; no file path, GPS metadata, or original photo is copied.
 * JPEG previews are bounded and live only in memory for on-device face matching.
 */
@CapacitorPlugin(name = "PhoneGallery", permissions = {
    @Permission(alias = "legacyPhotos", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
    @Permission(alias = "photos", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
    @Permission(alias = "selectedPhotos", strings = { Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED })
})
public final class PhoneGalleryPlugin extends Plugin {
    private static final long MAX_SOURCE_BYTES = 150L * 1024L * 1024L;
    private static final int MAX_JPEG_BYTES = 4 * 1024 * 1024;
    private static final int MAX_REVISION_PHOTOS = 200_000;
    private static final int REVISION_TIMEOUT_SECONDS = 30;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService revisionWatchdog = Executors.newSingleThreadScheduledExecutor();
    private final PhoneGalleryListingState listingState = new PhoneGalleryListingState();
    private ContentObserver libraryObserver;
    private boolean destroyed;
    private boolean permissionRequestActive;

    @PluginMethod
    public void getPermission(PluginCall call) {
        call.resolve(permissionResult());
    }

    /** This is the only method allowed to request OS photo permission. */
    @PluginMethod
    public synchronized void requestPermission(PluginCall call) {
        if ("granted".equals(permissionStatus())) {
            call.resolve(permissionResult());
            return;
        }
        if (permissionRequestActive) {
            call.reject("A photo permission request is already open.", "PERMISSION_REQUEST_ACTIVE");
            return;
        }
        permissionRequestActive = true;
        String[] aliases = Build.VERSION.SDK_INT >= 34
            ? new String[] { "photos", "selectedPhotos" }
            : new String[] { Build.VERSION.SDK_INT >= 33 ? "photos" : "legacyPhotos" };
        try {
            requestPermissionForAliases(aliases, call, "permissionFinished");
        } catch (RuntimeException error) {
            permissionRequestActive = false;
            call.reject("Photo permission could not be requested.", "PERMISSION_REQUEST_FAILED");
        }
    }

    @PermissionCallback
    private synchronized void permissionFinished(PluginCall call) {
        permissionRequestActive = false;
        listingState.changed();
        if (call != null) call.resolve(permissionResult());
    }

    /** Stable across launches: only accessible photo metadata is hashed, never image bytes. */
    @PluginMethod
    public void getLibraryRevision(PluginCall call) {
        run(call, () -> {
            requireAccess();
            observeLibraryIfNeeded();
            String permission = permissionStatus();
            long observedRevision = listingState.currentRevision();
            String[] columns = Build.VERSION.SDK_INT >= 30
                ? new String[] { MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_TAKEN,
                    MediaStore.Images.Media.DATE_ADDED, MediaStore.Images.Media.DATE_MODIFIED,
                    MediaStore.Images.Media.WIDTH, MediaStore.Images.Media.HEIGHT,
                    MediaStore.Images.Media.ORIENTATION, MediaStore.Images.Media.DISPLAY_NAME,
                    MediaStore.Images.Media.SIZE, MediaStore.Images.Media.GENERATION_MODIFIED }
                : new String[] { MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_TAKEN,
                    MediaStore.Images.Media.DATE_ADDED, MediaStore.Images.Media.DATE_MODIFIED,
                    MediaStore.Images.Media.WIDTH, MediaStore.Images.Media.HEIGHT,
                    MediaStore.Images.Media.ORIENTATION, MediaStore.Images.Media.DISPLAY_NAME,
                    MediaStore.Images.Media.SIZE };
            PhoneGalleryFingerprint fingerprint = new PhoneGalleryFingerprint(permission,
                Build.VERSION.SDK_INT >= 29 ? MediaStore.getVersion(getContext()) : "legacy");
            CancellationSignal cancellation = new CancellationSignal();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(REVISION_TIMEOUT_SECONDS);
            var timeout = revisionWatchdog.schedule(cancellation::cancel, REVISION_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            int visited = 0;
            // Cursor windows and incremental hashing bound memory independently
            // of gallery size. Sort by the stable ID, not provider-default order.
            try (Cursor cursor = getContext().getContentResolver().query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, visibleImageSelection(), null,
                MediaStore.Images.Media._ID + " ASC", cancellation
            )) {
                if (cursor == null) throw new PhoneGalleryRevisionUnavailableException();
                while (cursor.moveToNext()) {
                    if (++visited > MAX_REVISION_PHOTOS || System.nanoTime() >= deadline || Thread.currentThread().isInterrupted()) {
                        throw new PhoneGalleryRevisionUnavailableException();
                    }
                    // Identical to listPhotos' output predicate, including its
                    // exclusion of incomplete zero-dimension MediaStore rows.
                    if (cursor.getInt(4) <= 0 || cursor.getInt(5) <= 0) continue;
                    String[] values = new String[columns.length];
                    for (int index = 0; index < columns.length; index++) {
                        values[index] = cursor.isNull(index) ? null : cursor.getString(index);
                    }
                    fingerprint.addPhoto(values);
                }
            } catch (OperationCanceledException error) {
                throw new PhoneGalleryRevisionUnavailableException();
            } finally {
                timeout.cancel(false);
            }
            if (System.nanoTime() >= deadline) throw new PhoneGalleryRevisionUnavailableException();
            requireAccess();
            listingState.finishPage(observedRevision, permission, permissionStatus());
            JSObject result = new JSObject();
            result.put("revision", fingerprint.finish());
            call.resolve(result);
        });
    }

    /** Stable newest-first pages of metadata, never thumbnail/original bytes. */
    @PluginMethod
    public void listPhotos(PluginCall call) {
        int offset = Math.max(0, call.getInt("offset", 0));
        int limit = PhoneGalleryLimits.pageLimit(call.getInt("limit", 100));
        run(call, () -> {
            requireAccess();
            observeLibraryIfNeeded();
            String permission = permissionStatus();
            long pageRevision = listingState.startPage(offset, permission);
            ContentResolver resolver = getContext().getContentResolver();
            String[] columns = {
                MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.DATE_ADDED, MediaStore.Images.Media.DATE_MODIFIED,
                MediaStore.Images.Media.WIDTH, MediaStore.Images.Media.HEIGHT,
                MediaStore.Images.Media.ORIENTATION, MediaStore.Images.Media.DISPLAY_NAME
            };
            JSArray photos = new JSArray();
            boolean hasMore = false;
            int visited = 0;
            // Cursor windows keep memory bounded. Avoid provider-specific SQL
            // LIMIT strings, which some OEM MediaProviders reject or ignore.
            try (Cursor cursor = resolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, visibleImageSelection(), null,
                MediaStore.Images.Media.DATE_TAKEN + " DESC, " + MediaStore.Images.Media._ID + " DESC"
            )) {
                if (cursor != null && cursor.moveToPosition(offset)) {
                    do {
                        if (visited++ == limit) {
                            hasMore = true;
                            break;
                        }
                        long taken = cursor.getLong(1);
                        long added = cursor.getLong(2) * 1000L;
                        long modified = cursor.getLong(3) * 1000L;
                        int width = Math.max(0, cursor.getInt(4));
                        int height = Math.max(0, cursor.getInt(5));
                        // Unsupported/incomplete MediaStore rows are excluded,
                        // but still consume an offset slot so pagination stays
                        // deterministic when a caller advances by page size.
                        if (width == 0 || height == 0) continue;
                        int orientation = cursor.getInt(6);
                        boolean portraitRotation = orientation == 90 || orientation == 270;
                        JSObject photo = new JSObject();
                        photo.put("id", Long.toString(cursor.getLong(0)));
                        photo.put("capturedAt", isoDate(taken > 0 ? taken : added > 0 ? added : modified));
                        photo.put("width", portraitRotation ? height : width);
                        photo.put("height", portraitRotation ? width : height);
                        photo.put("filename", cursor.isNull(7) ? "Photo" : cursor.getString(7));
                        if (modified > 0) photo.put("modifiedAt", isoDate(modified));
                        photos.put(photo);
                    } while (cursor.moveToNext());
                }
            }
            requireAccess();
            listingState.finishPage(pageRevision, permission, permissionStatus());
            JSObject result = new JSObject();
            result.put("photos", photos);
            result.put("hasMore", hasMore);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void readPhoto(PluginCall call) {
        String id = call.getString("id");
        final long mediaId;
        try {
            mediaId = PhoneGalleryLimits.mediaId(id);
        } catch (IllegalArgumentException error) {
            call.reject("Choose an existing phone photo.", "INVALID_PHOTO_ID");
            return;
        }
        int edge = PhoneGalleryLimits.previewEdge(call.getInt("maxDimension", 1200));
        run(call, () -> {
            requireAccess();
            Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, mediaId);
            ensureReadableImage(uri);
            Bitmap bitmap = null;
            try {
                bitmap = Build.VERSION.SDK_INT >= 28 ? decodeModern(uri, edge) : decodeLegacy(uri, edge);
                if (bitmap == null) throw new IOException("No image");
                try (ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                    if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 85, bytes) || bytes.size() > MAX_JPEG_BYTES) {
                        throw new IOException("Photo preview too large");
                    }
                    requireAccess();
                    // Query the ID again: a limited selection can change while
                    // decoding even though the overall permission stays limited.
                    ensureReadableImage(uri);
                    JSObject result = new JSObject();
                    result.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                    call.resolve(result);
                }
            } finally {
                if (bitmap != null) bitmap.recycle();
            }
        });
    }

    /** Only called by an explicit Manage photo access button. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Open Bubble's photo permissions in Settings.", "SETTINGS_UNAVAILABLE");
        }
    }

    private String permissionStatus() {
        if (Build.VERSION.SDK_INT >= 33 && isGranted(Manifest.permission.READ_MEDIA_IMAGES)) return "granted";
        if (Build.VERSION.SDK_INT >= 34 && isGranted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)) return "limited";
        if (Build.VERSION.SDK_INT < 33 && isGranted(Manifest.permission.READ_EXTERNAL_STORAGE)) return "granted";
        PermissionState state = getPermissionState(Build.VERSION.SDK_INT >= 33 ? "photos" : "legacyPhotos");
        return state == PermissionState.DENIED ? "denied" : "prompt";
    }

    private boolean isGranted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject permissionResult() {
        JSObject result = new JSObject();
        result.put("status", permissionStatus());
        return result;
    }

    private void requireAccess() {
        String status = permissionStatus();
        if (!"granted".equals(status) && !"limited".equals(status)) throw new SecurityException();
    }

    private static String visibleImageSelection() {
        return Build.VERSION.SDK_INT >= 30
            ? MediaStore.Images.Media.IS_PENDING + " = 0 AND " + MediaStore.Images.Media.IS_TRASHED + " = 0"
            : Build.VERSION.SDK_INT >= 29 ? MediaStore.Images.Media.IS_PENDING + " = 0" : null;
    }

    private synchronized void observeLibraryIfNeeded() throws IOException {
        if (destroyed) throw new IOException("Gallery closed");
        if (libraryObserver != null) return;
        ContentObserver observer = new ContentObserver(null) {
            @Override public void onChange(boolean selfChange) { listingState.changed(); }
        };
        // Observation begins only during an opted-in, authorized metadata check.
        // No scan or listener is started merely by loading the native plugin.
        getContext().getContentResolver().registerContentObserver(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, observer);
        libraryObserver = observer;
    }

    private void ensureReadableImage(Uri uri) throws IOException {
        try (Cursor cursor = getContext().getContentResolver().query(uri,
            new String[] { MediaStore.Images.Media.MIME_TYPE, MediaStore.Images.Media.SIZE }, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new IOException("Photo no longer available");
            String mime = cursor.getString(0);
            if (mime == null || !mime.startsWith("image/") || cursor.getLong(1) > MAX_SOURCE_BYTES) {
                throw new IOException("Unsupported photo");
            }
        }
    }

    private Bitmap decodeModern(Uri uri, int edge) throws IOException {
        return ImageDecoder.decodeBitmap(ImageDecoder.createSource(getContext().getContentResolver(), uri),
            (decoder, info, source) -> {
                int width = info.getSize().getWidth();
                int height = info.getSize().getHeight();
                int[] target = PhoneGalleryLimits.targetSize(width, height, edge);
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                decoder.setTargetSize(target[0], target[1]);
            });
    }

    /** API 24-27 fallback: sample before decoding, then normalize EXIF rotation. */
    private Bitmap decodeLegacy(Uri uri, int edge) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream input = resolver.openInputStream(uri)) { BitmapFactory.decodeStream(input, null, bounds); }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IOException("Invalid photo dimensions");
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > edge) options.inSampleSize *= 2;
        Bitmap bitmap;
        try (InputStream input = resolver.openInputStream(uri)) { bitmap = BitmapFactory.decodeStream(input, null, options); }
        if (bitmap == null) throw new IOException("Photo decode failed");
        try {
            int orientation = ExifInterface.ORIENTATION_NORMAL;
            try (InputStream input = resolver.openInputStream(uri)) {
                if (input == null) throw new IOException("Photo unavailable");
                orientation = new ExifInterface(input).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            } catch (IOException ignored) {
                // Older framework ExifInterface does not recognize every PNG /
                // GIF format BitmapFactory can decode. Such images use their
                // decoded orientation; access is checked again before returning.
            }
            Matrix matrix = new Matrix();
            switch (orientation) {
                case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: matrix.setScale(-1, 1); break;
                case ExifInterface.ORIENTATION_ROTATE_180: matrix.setRotate(180); break;
                case ExifInterface.ORIENTATION_FLIP_VERTICAL: matrix.setScale(1, -1); break;
                case ExifInterface.ORIENTATION_TRANSPOSE: matrix.setRotate(90); matrix.postScale(-1, 1); break;
                case ExifInterface.ORIENTATION_ROTATE_90: matrix.setRotate(90); break;
                case ExifInterface.ORIENTATION_TRANSVERSE: matrix.setRotate(-90); matrix.postScale(-1, 1); break;
                case ExifInterface.ORIENTATION_ROTATE_270: matrix.setRotate(-90); break;
                default: return bitmap;
            }
            Bitmap oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            if (oriented != bitmap) bitmap.recycle();
            return oriented;
        } catch (RuntimeException error) {
            bitmap.recycle();
            throw error;
        }
    }

    private static String isoDate(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(Math.max(0, millis)));
    }

    private interface ReadWork { void run() throws IOException; }

    private void run(PluginCall call, ReadWork work) {
        try {
            worker.execute(() -> {
                try { work.run(); }
                catch (PhoneGalleryLibraryChangedException error) { call.reject("The photo library changed while refreshing. Refresh photos again.", "LIBRARY_CHANGED"); }
                catch (PhoneGalleryRevisionUnavailableException error) { call.reject("The photo library change check could not finish. Try again shortly.", "GALLERY_UNAVAILABLE"); }
                catch (SecurityException error) { call.reject("Photo access changed. Review your gallery permission.", "PERMISSION_DENIED"); }
                catch (IOException | RuntimeException error) { call.reject("This phone photo is unavailable or cannot be read.", "PHOTO_UNAVAILABLE"); }
                catch (OutOfMemoryError error) { call.reject("This photo is too large to preview safely.", "PHOTO_UNAVAILABLE"); }
            });
        } catch (RejectedExecutionException error) {
            call.reject("Gallery access is not available right now.", "GALLERY_UNAVAILABLE");
        }
    }

    @Override
    protected void handleOnPause() {
        // A user can change selected-photo access in Settings while paused
        // without changing the overall "limited" status. Never continue an old
        // offset scan across that boundary; a foreground refresh starts at zero.
        listingState.changed();
        super.handleOnPause();
    }

    @Override
    protected synchronized void handleOnDestroy() {
        destroyed = true;
        if (libraryObserver != null) {
            getContext().getContentResolver().unregisterContentObserver(libraryObserver);
            libraryObserver = null;
        }
        worker.shutdownNow();
        revisionWatchdog.shutdownNow();
        super.handleOnDestroy();
    }
}

/** Reject offset pages from a changed library instead of silently skipping IDs. */
final class PhoneGalleryListingState {
    private final AtomicLong revision = new AtomicLong();
    private long scanRevision = -1;
    private String scanPermission;

    void changed() { revision.incrementAndGet(); }

    long currentRevision() { return revision.get(); }

    long startPage(int offset, String permission) throws PhoneGalleryLibraryChangedException {
        if (offset == 0) {
            scanRevision = revision.get();
            scanPermission = permission;
        } else if (scanRevision < 0 || scanRevision != revision.get() || !permission.equals(scanPermission)) {
            throw new PhoneGalleryLibraryChangedException();
        }
        return scanRevision;
    }

    void finishPage(long expectedRevision, String expectedPermission, String permission) throws PhoneGalleryLibraryChangedException {
        if (revision.get() != expectedRevision || !permission.equals(expectedPermission)) throw new PhoneGalleryLibraryChangedException();
    }
}

final class PhoneGalleryLibraryChangedException extends IOException {}
final class PhoneGalleryRevisionUnavailableException extends IOException {}

/** A versioned, length-framed metadata digest; no image, path, or GPS data is retained. */
final class PhoneGalleryFingerprint {
    private final MessageDigest digest;
    private long photoCount;

    PhoneGalleryFingerprint(String permission, String storeVersion) {
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
        addField("bubble-gallery:android:v1");
        addField(permission);
        addField(storeVersion);
    }

    void addPhoto(String... fields) {
        addField("photo");
        addField(Integer.toString(fields.length));
        for (String field : fields) addField(field);
        photoCount++;
    }

    private void addField(String value) {
        byte[] bytes = value == null ? null : value.getBytes(StandardCharsets.UTF_8);
        digest.update(ByteBuffer.allocate(4).putInt(bytes == null ? -1 : bytes.length).array());
        if (bytes != null) digest.update(bytes);
    }

    String finish() {
        addField("count");
        addField(Long.toString(photoCount));
        StringBuilder hex = new StringBuilder("android-v1:");
        for (byte value : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return hex.toString();
    }
}

/** Pure limits keep thumbnail allocation and ID validation testable off-device. */
final class PhoneGalleryLimits {
    private PhoneGalleryLimits() {}

    static long mediaId(String id) {
        if (id == null || !id.matches("[1-9][0-9]{0,18}")) throw new IllegalArgumentException("Invalid photo ID");
        return Long.parseLong(id);
    }

    static int pageLimit(int requested) { return Math.max(1, Math.min(200, requested)); }

    static int previewEdge(int requested) { return Math.max(256, Math.min(1600, requested)); }

    static int[] targetSize(int width, int height, int requestedEdge) {
        if (width <= 0 || height <= 0) throw new IllegalArgumentException("Invalid photo dimensions");
        int edge = previewEdge(requestedEdge);
        double scale = Math.min(1d, (double) edge / Math.max(width, height));
        return new int[] { Math.max(1, (int) Math.round(width * scale)), Math.max(1, (int) Math.round(height * scale)) };
    }
}
