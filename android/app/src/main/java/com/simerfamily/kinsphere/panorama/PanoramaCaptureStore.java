package com.simerfamily.kinsphere.panorama;

import android.content.Context;
import android.net.Uri;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Durable, owner-scoped camera originals. Cache eviction must never erase a scan. */
public final class PanoramaCaptureStore {
    private final File root;

    public PanoramaCaptureStore(Context context) throws IOException {
        root = new File(context.getFilesDir(), "panorama_captures").getCanonicalFile();
        if ((!root.isDirectory() && !root.mkdirs()) || !root.isDirectory()) {
            throw new IOException("Not enough storage to keep the original photos.");
        }
    }

    public File getRoot() { return root; }

    public static String owner(String value) {
        if (value == null || value.trim().isEmpty() || value.length() > 512) {
            throw new IllegalArgumentException("A local profile is required to access this capture.");
        }
        return value;
    }

    public File resolve(String directoryUrl, String ownerKey) throws IOException, JSONException {
        owner(ownerKey);
        if (directoryUrl == null) throw new IOException("The original capture folder is missing.");
        Uri uri = Uri.parse(directoryUrl);
        if (uri.getScheme() != null && !"file".equalsIgnoreCase(uri.getScheme())) {
            throw new IOException("The capture must be saved on this phone.");
        }
        String path = uri.getScheme() == null ? directoryUrl : uri.getPath();
        if (path == null) throw new IOException("The capture folder is invalid.");
        File candidate = validateSession(root, new File(path));
        JSONObject manifest = readJson(new File(candidate, "metadata.json"));
        if (!ownerKey.equals(manifest.optString("ownerKey", ""))) {
            throw new IOException("This capture belongs to a different local profile.");
        }
        return candidate;
    }

    /** Shared by reads and deletion; never accepts roots, traversal, or linked directories. */
    public static File validateSession(File root, File candidate) throws IOException {
        File canonicalRoot = root.getCanonicalFile();
        File canonical = candidate.getCanonicalFile();
        if (!canonical.equals(candidate.getAbsoluteFile()) || !canonicalRoot.equals(canonical.getParentFile())) {
            throw new IOException("This is not an app-owned capture folder.");
        }
        try {
            if (!UUID.fromString(canonical.getName()).toString().equals(canonical.getName())) {
                throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException error) {
            throw new IOException("The capture folder identifier is invalid.", error);
        }
        return canonical;
    }

    public JSONArray list(String ownerKey) throws IOException {
        owner(ownerKey);
        List<JSONObject> captures = new ArrayList<>();
        File[] children = root.listFiles();
        if (children != null) for (File child : children) {
            try {
                File session = validateSession(root, child);
                JSONObject manifest = readJson(new File(session, "metadata.json"));
                if (!ownerKey.equals(manifest.optString("ownerKey"))) continue;
                if (manifest.optInt("capturedCount") <= 0) continue;
                manifest.put("directoryUrl", Uri.fromFile(session).toString());
                // Assembly metadata is optional. Its corruption must never hide originals.
                JSONObject assembly = readOptionalJson(new File(session, "assembly.json"));
                if (assembly != null && !ownerKey.equals(assembly.optString("ownerKey"))) assembly = null;
                JSONObject live = PanoramaStitchService.activeStatus(session, ownerKey);
                if (live != null) {
                    assembly = live;
                } else if (assembly != null && ("queued".equals(assembly.optString("state")) || "running".equals(assembly.optString("state")))) {
                    assembly.put("state", "failed").put("code", "interrupted")
                        .put("error", "Assembly was interrupted. Your original photos are safe; retry on this phone.");
                    try { writeJson(new File(session, "assembly.json"), assembly); }
                    catch (IOException ignored) { /* Return usable recovery state even on a full disk. */ }
                }
                if (assembly != null) manifest.put("assembly", assembly);
                JSONObject completed = readOptionalJson(new File(session, "completed-assembly.json"));
                if (completed != null && !ownerKey.equals(completed.optString("ownerKey"))) completed = null;
                // Existing installations can have a completed assembly predating the separate record.
                if (completed == null && assembly != null && "completed".equals(assembly.optString("state"))) completed = assembly;
                if (completed != null && "completed".equals(completed.optString("state"))) manifest.put("savedResult", completed);
                captures.add(manifest);
            } catch (IOException | JSONException ignored) {
                // One corrupt/interrupted session must not hide other safely saved scans.
            }
        }
        captures.sort(Comparator.comparingLong((JSONObject value) -> value.optLong("createdAt")).reversed());
        return new JSONArray(captures);
    }

    public JSONObject normalizedManifest(File session) throws IOException, JSONException {
        validateSession(root, session);
        JSONObject manifest = readJson(new File(session, "metadata.json"));
        JSONArray frames = manifest.getJSONArray("frames");
        if (frames.length() < 8 || frames.length() > 64) throw new IOException("This capture needs 8–64 original photos.");
        if (manifest.optInt("capturedCount") != frames.length() || manifest.optInt("targetCount") != frames.length()
            || !manifest.optBoolean("coverageComplete", true)) {
            throw new IOException("This scan is incomplete. Its saved photos are safe, but it cannot yet form a complete sphere.");
        }
        long bytes = 0;
        for (int index = 0; index < frames.length(); index++) {
            JSONObject frame = frames.getJSONObject(index);
            String source = frame.optString("uri", frame.optString("fileUrl", frame.optString("path")));
            Uri uri = Uri.parse(source);
            String path = uri.getScheme() == null ? source : uri.getPath();
            if (path == null || (uri.getScheme() != null && !"file".equals(uri.getScheme()))) {
                throw new IOException("An original photo has an invalid path.");
            }
            File photo = new File(path).getCanonicalFile();
            if (!session.equals(photo.getParentFile()) || !photo.isFile() || photo.length() == 0 || photo.length() > 12L * 1024 * 1024) {
                throw new IOException("An original photo is missing or cannot be read safely.");
            }
            int width = frame.getInt("width"), height = frame.getInt("height");
            if (width <= 0 || height <= 0 || (long) width * height > 32_000_000) {
                throw new IOException("An original photo has unsupported dimensions.");
            }
            bytes += photo.length();
            frame.put("filePath", photo.getAbsolutePath());
        }
        if (bytes > 250L * 1024 * 1024) throw new IOException("This scan is too large to assemble safely on this phone.");
        return manifest;
    }

    public static JSONObject readJson(File file) throws IOException, JSONException {
        // Let AtomicFile restore a backup before testing existence or parsing.
        try (FileInputStream input = new AtomicFile(file).openRead(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > 8L * 1024 * 1024) throw new IOException("Capture metadata is unavailable.");
                bytes.write(buffer, 0, count);
            }
            return new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
        }
    }

    private static JSONObject readOptionalJson(File file) {
        try { return readJson(file); }
        catch (IOException | JSONException ignored) { return null; }
    }

    /** Preserve the last usable sphere before a retry replaces current job metadata. */
    public static void preserveCompletedResult(File session) throws IOException {
        JSONObject completed = readOptionalJson(new File(session, "assembly.json"));
        if (completed != null && "completed".equals(completed.optString("state"))) {
            writeJson(new File(session, "completed-assembly.json"), completed);
        }
    }

    /** Android AtomicFile retains the last good version through crashes and full-disk errors. */
    public static synchronized void writeJson(File file, JSONObject value) throws IOException {
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream stream = null;
        try {
            stream = atomic.startWrite();
            stream.write(value.toString().getBytes(StandardCharsets.UTF_8));
            atomic.finishWrite(stream);
        } catch (IOException | RuntimeException error) {
            if (stream != null) atomic.failWrite(stream);
            throw error;
        }
    }
}
