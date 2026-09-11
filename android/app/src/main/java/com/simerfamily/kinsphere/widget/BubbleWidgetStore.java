package com.simerfamily.kinsphere.widget;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

/** App-private persistence shared by the Capacitor activity and widget provider. */
final class BubbleWidgetStore {

    private static final Object LOCK = new Object();
    private static final String PREFERENCES = "bubble_widget_v1";
    private static final String SNAPSHOT_KEY = "snapshot";
    private static final String IMAGE_KEY = "thumbnail_file";
    private static final String PAGE_IMAGES_KEY = "page_image_files";
    private static final String IMAGE_DIRECTORY = "bubble_widget";
    private static final String IMAGE_PREFIX = "thumbnail-";
    private static final String PAGE_IMAGE_PREFIX = "page-";
    private static final String IMAGE_SUFFIX = ".jpg";
    private static final int MAX_PAGE_IMAGES = 8;
    private static final String PRIVACY_BOUNDARY_FILE = "bubble-widget-private-v1.json";

    private BubbleWidgetStore() {}

    /** A snapshot and its image read under the same lock, so accounts cannot be mixed. */
    static final class Entry {
        final BubbleWidgetSnapshot snapshot;
        final Bitmap thumbnail;
        final Map<String, Bitmap> pageThumbnails;

        Entry(
            BubbleWidgetSnapshot snapshot,
            Bitmap thumbnail,
            Map<String, Bitmap> pageThumbnails
        ) {
            this.snapshot = snapshot;
            this.thumbnail = thumbnail;
            this.pageThumbnails = Collections.unmodifiableMap(
                new LinkedHashMap<>(pageThumbnails)
            );
        }
    }

    @FunctionalInterface
    interface TransactionStep {
        void run() throws IOException;
    }

    @FunctionalInterface
    interface RecoveryStep {
        void run();
    }

    @FunctionalInterface
    interface EntryConsumer {
        void accept(Entry entry);
    }

    static void save(Context context, BubbleWidgetSnapshot snapshot, Bitmap thumbnail)
        throws IOException {
        save(context, snapshot, thumbnail, Collections.emptyMap());
    }

    static void save(
        Context context,
        BubbleWidgetSnapshot snapshot,
        Bitmap thumbnail,
        Map<String, Bitmap> pageThumbnails
    ) throws IOException {
        synchronized (LOCK) {
            validatePageThumbnails(snapshot, pageThumbnails);
            SharedPreferences preferences = preferences(context);
            String privateSnapshot = BubbleWidgetSnapshot
                .fallback(snapshot.theme)
                .toStorageJson();
            PendingImages pending = new PendingImages();

            try {
                runPrivacyTransaction(
                    () -> establishPrivacyBoundary(
                        () -> writePrivacyBoundaryMarker(context, privateSnapshot),
                        () -> installPrivacyBoundary(preferences, privateSnapshot)
                    ),
                    () -> {
                        if (thumbnail != null && snapshot.mayShowThumbnail()) {
                            pending.legacyName = newImageName(IMAGE_PREFIX, 0, "legacy");
                            writeImage(context, thumbnail, pending.legacyName, pending);
                        }
                        int pageIndex = 0;
                        for (Map.Entry<String, Bitmap> pageImage : pageThumbnails.entrySet()) {
                            String name = newImageName(
                                PAGE_IMAGE_PREFIX,
                                pageIndex,
                                pageImage.getKey()
                            );
                            writeImage(context, pageImage.getValue(), name, pending);
                            pending.pageNames.put(pageImage.getKey(), name);
                            pageIndex += 1;
                        }
                        commitFinalSnapshot(
                            preferences,
                            snapshot,
                            pending.legacyName,
                            pending.pageNames
                        );
                        removePrivacyBoundaryMarker(context);
                    },
                    () -> {
                        installPrivacyBoundaryBestEffort(
                            context,
                            preferences,
                            privateSnapshot
                        );
                        deleteQuietly(pending.files);
                    }
                );
            } catch (RuntimeException exception) {
                throw new IOException("Could not persist the widget snapshot.", exception);
            }

            Set<String> retained = new HashSet<>(pending.pageNames.values());
            if (pending.legacyName != null) {
                retained.add(pending.legacyName);
            }
            deleteUnreferencedImages(context, retained, false);
        }
    }

    static BubbleWidgetSnapshot load(Context context) {
        synchronized (LOCK) {
            return loadSnapshotLocked(context, preferences(context));
        }
    }

    /** Keeps the read and launcher publication ordered against save/clear mutations. */
    static void withEntry(Context context, EntryConsumer consumer) {
        synchronized (LOCK) {
            SharedPreferences preferences = preferences(context);
            BubbleWidgetSnapshot snapshot = loadSnapshotLocked(context, preferences);
            boolean currentDay = snapshot != null && snapshot.isCurrentLocalDay(
                System.currentTimeMillis()
            );
            Bitmap thumbnail = currentDay && snapshot.mayShowThumbnail()
                ? loadThumbnailLocked(context, preferences)
                : null;
            Map<String, Bitmap> pageThumbnails = currentDay
                ? loadPageThumbnailsLocked(context, preferences, snapshot)
                : Collections.emptyMap();
            if (pageThumbnails == null) {
                recycle(thumbnail);
                clearBestEffort(context);
                BubbleWidgetSnapshot fallback = BubbleWidgetSnapshot.fallback(
                    snapshot == null ? "plum" : snapshot.theme
                );
                consumer.accept(new Entry(fallback, null, Collections.emptyMap()));
                return;
            }
            consumer.accept(new Entry(snapshot, thumbnail, pageThumbnails));
        }
    }

    static void clear(Context context) throws IOException {
        synchronized (LOCK) {
            SharedPreferences preferences = preferences(context);
            BubbleWidgetSnapshot current = parseWithoutRepair(
                preferences.getString(SNAPSHOT_KEY, null)
            );
            String privateSnapshot = BubbleWidgetSnapshot
                .fallback(current == null ? "plum" : current.theme)
                .toStorageJson();
            try {
                runPrivacyTransaction(
                    () -> establishPrivacyBoundary(
                        () -> writePrivacyBoundaryMarker(context, privateSnapshot),
                        () -> installPrivacyBoundary(preferences, privateSnapshot)
                    ),
                    () -> {
                        if (!deleteUnreferencedImages(
                            context,
                            Collections.emptySet(),
                            true
                        )) {
                            throw new IOException("Could not remove every widget thumbnail.");
                        }
                    },
                    () -> installPrivacyBoundaryBestEffort(
                        context,
                        preferences,
                        privateSnapshot
                    )
                );
            } catch (RuntimeException exception) {
                throw new IOException("Could not fully clear the widget cache.", exception);
            }
        }
    }

    /**
     * Runs the privacy boundary before every fallible payload step and restores
     * it in memory if a later SharedPreferences commit reports a disk failure.
     */
    static void runPrivacyTransaction(
        TransactionStep installBoundary,
        TransactionStep writePayload,
        RecoveryStep restoreBoundary
    ) throws IOException {
        try {
            installBoundary.run();
            writePayload.run();
        } catch (IOException | RuntimeException failure) {
            try {
                restoreBoundary.run();
            } catch (RuntimeException recoveryFailure) {
                failure.addSuppressed(recoveryFailure);
            }
            throw failure;
        }
    }

    /** Attempts both durable barriers; either one is sufficient to fail private. */
    static void establishPrivacyBoundary(
        TransactionStep markerBoundary,
        TransactionStep preferencesBoundary
    ) throws IOException {
        Throwable markerFailure = null;
        boolean markerInstalled = false;
        try {
            markerBoundary.run();
            markerInstalled = true;
        } catch (IOException | RuntimeException failure) {
            markerFailure = failure;
        }

        Throwable preferencesFailure = null;
        boolean preferencesInstalled = false;
        try {
            preferencesBoundary.run();
            preferencesInstalled = true;
        } catch (IOException | RuntimeException failure) {
            preferencesFailure = failure;
        }

        if (markerInstalled || preferencesInstalled) {
            return;
        }
        IOException failure = new IOException("Could not establish a private widget boundary.");
        if (markerFailure != null) {
            failure.addSuppressed(markerFailure);
        }
        if (preferencesFailure != null) {
            failure.addSuppressed(preferencesFailure);
        }
        throw failure;
    }

    private static void clearBestEffort(Context context) {
        try {
            clear(context);
        } catch (IOException ignored) {
            // load() must remain fail-closed and return the private fallback.
        }
    }

    private static BubbleWidgetSnapshot loadSnapshotLocked(
        Context context,
        SharedPreferences preferences
    ) {
        if (hasPrivacyBoundaryMarker(context)) {
            return BubbleWidgetSnapshot.fallback("plum");
        }
        String raw = preferences.getString(SNAPSHOT_KEY, null);
        if (raw == null) {
            return null;
        }
        BubbleWidgetSnapshot snapshot = parseWithoutRepair(raw);
        if (snapshot != null) {
            return snapshot;
        }
        // A future downgrade or interrupted write must never make the
        // launcher process crash or retain a reference to old media.
        clearBestEffort(context);
        return null;
    }

    private static BubbleWidgetSnapshot parseWithoutRepair(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return BubbleWidgetSnapshot.parse(raw);
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }

    private static Bitmap loadThumbnailLocked(
        Context context,
        SharedPreferences preferences
    ) {
        String imageName = preferences.getString(IMAGE_KEY, null);
        File file = resolveImage(context, imageName);
        if (file == null || !file.isFile()) {
            return null;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPreferredConfig = Bitmap.Config.RGB_565;
        return BitmapFactory.decodeFile(file.getAbsolutePath(), options);
    }

    /** Returns null for a corrupt mapping so callers can replace the whole deck privately. */
    private static Map<String, Bitmap> loadPageThumbnailsLocked(
        Context context,
        SharedPreferences preferences,
        BubbleWidgetSnapshot snapshot
    ) {
        String raw = preferences.getString(PAGE_IMAGES_KEY, null);
        if (raw == null) {
            return Collections.emptyMap();
        }
        if (snapshot == null || !"full".equals(snapshot.privacy)) {
            return null;
        }

        Map<String, Bitmap> result = new LinkedHashMap<>();
        try {
            JSONObject names = new JSONObject(raw);
            Iterator<String> keys = names.keys();
            int count = 0;
            while (keys.hasNext()) {
                String pageId = keys.next();
                count += 1;
                BubbleWidgetSnapshot.Page page = snapshot.findPage(pageId);
                Object rawName = names.opt(pageId);
                if (
                    count > MAX_PAGE_IMAGES ||
                    page == null ||
                    !page.mayShowThumbnail() ||
                    !(rawName instanceof String)
                ) {
                    recycle(result);
                    return null;
                }
                File file = resolveImage(context, (String) rawName);
                if (file == null) {
                    recycle(result);
                    return null;
                }
                if (!file.isFile()) {
                    continue;
                }
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inPreferredConfig = Bitmap.Config.RGB_565;
                Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
                if (bitmap != null) {
                    result.put(pageId, bitmap);
                }
            }
            return result;
        } catch (JSONException | RuntimeException exception) {
            recycle(result);
            return null;
        }
    }

    private static void installPrivacyBoundary(
        SharedPreferences preferences,
        String privateSnapshot
    ) throws IOException {
        boolean committed = preferences
            .edit()
            .clear()
            .putString(SNAPSHOT_KEY, privateSnapshot)
            .commit();
        if (!committed) {
            throw new IOException("Could not persist the private widget fallback.");
        }
    }

    private static void installPrivacyBoundaryBestEffort(
        Context context,
        SharedPreferences preferences,
        String privateSnapshot
    ) {
        try {
            establishPrivacyBoundary(
                () -> writePrivacyBoundaryMarker(context, privateSnapshot),
                // commit() updates SharedPreferences' in-memory map before its
                // disk result is known. Repeating it prevents a failed final
                // commit from feeding a same-process redraw.
                () -> installPrivacyBoundary(preferences, privateSnapshot)
            );
        } catch (IOException | RuntimeException ignored) {
            // The first successful redundant boundary remains authoritative.
        }
    }

    private static void writePrivacyBoundaryMarker(
        Context context,
        String privateSnapshot
    ) throws IOException {
        File marker = privacyBoundaryFile(context);
        if (marker.exists()) {
            return;
        }
        byte[] contents = privateSnapshot.getBytes(StandardCharsets.UTF_8);
        // The marker's existence is itself fail-private, so create it at its
        // final path before any payload write. Its JSON is useful for forensic
        // inspection but is never trusted to decide whether the guard applies.
        try (FileOutputStream output = new FileOutputStream(marker, false)) {
            output.write(contents);
            output.flush();
            output.getFD().sync();
        }
    }

    private static boolean hasPrivacyBoundaryMarker(Context context) {
        try {
            return privacyBoundaryFile(context).exists();
        } catch (RuntimeException exception) {
            // If marker state cannot be inspected, never read potentially
            // sensitive preferences as a fallback.
            return true;
        }
    }

    private static void removePrivacyBoundaryMarker(Context context) throws IOException {
        try {
            File marker = privacyBoundaryFile(context);
            if (marker.exists() && !marker.delete()) {
                throw new IOException("Could not finish the widget privacy transaction.");
            }
        } catch (SecurityException exception) {
            throw new IOException("Could not finish the widget privacy transaction.", exception);
        }
    }

    private static void commitFinalSnapshot(
        SharedPreferences preferences,
        BubbleWidgetSnapshot snapshot,
        String imageName,
        Map<String, String> pageImageNames
    ) throws IOException {
        SharedPreferences.Editor editor = preferences
            .edit()
            .clear()
            .putString(SNAPSHOT_KEY, snapshot.toStorageJson());
        if (imageName != null) {
            editor.putString(IMAGE_KEY, imageName);
        }
        if (!pageImageNames.isEmpty()) {
            JSONObject names = new JSONObject();
            try {
                for (Map.Entry<String, String> entry : pageImageNames.entrySet()) {
                    names.put(entry.getKey(), entry.getValue());
                }
            } catch (JSONException impossible) {
                throw new IOException("Could not serialize widget image references.", impossible);
            }
            editor.putString(PAGE_IMAGES_KEY, names.toString());
        }
        if (!editor.commit()) {
            throw new IOException("Could not persist the widget snapshot.");
        }
    }

    private static void writeImage(
        Context context,
        Bitmap thumbnail,
        String imageName,
        PendingImages pending
    ) throws IOException {
        File directory = thumbnailDirectory(context);
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Could not create the widget image directory.");
        }
        File destination = new File(directory, imageName);
        pending.files.add(destination);
        File temporary = new File(directory, imageName + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary, false)) {
            if (!thumbnail.compress(Bitmap.CompressFormat.JPEG, 84, output)) {
                throw new IOException("Could not encode the widget thumbnail.");
            }
            output.flush();
            output.getFD().sync();
        } catch (IOException | RuntimeException exception) {
            deleteQuietly(temporary);
            throw exception;
        }
        if (!temporary.renameTo(destination)) {
            deleteQuietly(temporary);
            throw new IOException("Could not store the widget thumbnail.");
        }
    }

    private static void validatePageThumbnails(
        BubbleWidgetSnapshot snapshot,
        Map<String, Bitmap> pageThumbnails
    ) {
        if (pageThumbnails == null || pageThumbnails.size() > MAX_PAGE_IMAGES) {
            throw new IllegalArgumentException("pageThumbnails has an unsupported size.");
        }
        for (Map.Entry<String, Bitmap> entry : pageThumbnails.entrySet()) {
            BubbleWidgetSnapshot.Page page = snapshot.findPage(entry.getKey());
            if (
                page == null ||
                !page.mayShowThumbnail() ||
                entry.getValue() == null ||
                !"full".equals(snapshot.privacy)
            ) {
                throw new IllegalArgumentException("pageThumbnails does not match its snapshot.");
            }
        }
    }

    private static String newImageName(String prefix, int index, String identity) {
        return prefix + String.format(Locale.US, "%02d", index) + "-" +
            shortHash(identity) + "-" + UUID.randomUUID() + IMAGE_SUFFIX;
    }

    private static String shortHash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(16);
            for (int index = 0; index < 8; index += 1) {
                result.append(String.format(Locale.US, "%02x", bytes[index] & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required by Android.", impossible);
        }
    }

    private static boolean deleteUnreferencedImages(
        Context context,
        Set<String> retainedNames,
        boolean removeDirectory
    ) {
        File directory = thumbnailDirectory(context);
        File[] files = directory.listFiles();
        if (directory.exists() && files == null) {
            return false;
        }
        boolean deleted = true;
        if (files != null) {
            for (File file : files) {
                if (!retainedNames.contains(file.getName())) {
                    try {
                        deleted &= !file.exists() || file.delete();
                    } catch (SecurityException exception) {
                        deleted = false;
                    }
                }
            }
        }
        if (removeDirectory && directory.exists()) {
            try {
                deleted &= directory.delete();
            } catch (SecurityException exception) {
                deleted = false;
            }
        }
        return deleted;
    }

    private static SharedPreferences preferences(Context context) {
        return context
            .getApplicationContext()
            .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static File thumbnailDirectory(Context context) {
        return new File(context.getApplicationContext().getNoBackupFilesDir(), IMAGE_DIRECTORY);
    }

    private static File privacyBoundaryFile(Context context) {
        return new File(
            context.getApplicationContext().getNoBackupFilesDir(),
            PRIVACY_BOUNDARY_FILE
        );
    }

    private static File resolveImage(Context context, String imageName) {
        if (
            imageName == null ||
            (!imageName.startsWith(IMAGE_PREFIX) &&
                !imageName.startsWith(PAGE_IMAGE_PREFIX)) ||
            !imageName.endsWith(IMAGE_SUFFIX) ||
            imageName.length() > 120 ||
            imageName.contains("/") ||
            imageName.contains("\\")
        ) {
            return null;
        }
        return new File(thumbnailDirectory(context), imageName);
    }

    private static void deleteQuietly(File file) {
        try {
            if (file != null && file.exists()) {
                file.delete();
            }
        } catch (SecurityException ignored) {
            // The preferences boundary never points at an unremoved file.
        }
    }

    private static void deleteQuietly(List<File> files) {
        for (File file : files) {
            deleteQuietly(file);
        }
    }

    private static void recycle(Bitmap bitmap) {
        if (bitmap != null && !bitmap.isRecycled()) {
            bitmap.recycle();
        }
    }

    private static void recycle(Map<String, Bitmap> bitmaps) {
        for (Bitmap bitmap : bitmaps.values()) {
            recycle(bitmap);
        }
    }

    private static final class PendingImages {
        String legacyName;
        final Map<String, String> pageNames = new LinkedHashMap<>();
        final List<File> files = new ArrayList<>();
    }
}
