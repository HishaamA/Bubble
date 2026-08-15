package com.simerfamily.kinsphere.capsule;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.UUID;

/** Restricts every bridge-visible artifact to a UUID-named app cache file. */
final class CapsuleRecapFiles {

    private final File stagingRoot;
    private final File recapRoot;

    CapsuleRecapFiles(File cacheRoot) throws IOException {
        if (cacheRoot == null) {
            throw new IOException("The app cache directory is unavailable.");
        }
        stagingRoot = ensureDirectory(cacheRoot, CapsuleRecapContract.STAGING_DIRECTORY);
        recapRoot = ensureDirectory(cacheRoot, CapsuleRecapContract.RECAP_DIRECTORY);
    }

    File createStagedImageFile() {
        return new File(stagingRoot, UUID.randomUUID().toString().toLowerCase(Locale.ROOT) + ".jpg");
    }

    File createRecapFile() {
        return new File(recapRoot, UUID.randomUUID().toString().toLowerCase(Locale.ROOT) + ".mp4");
    }

    File validateStagedImage(String value) throws IOException {
        File candidate = validateArtifact(value, stagingRoot, "jpg");
        if (!candidate.isFile()) {
            throw new IOException("A staged capsule image is no longer available.");
        }
        return candidate;
    }

    File validateRecap(String value) throws IOException {
        File candidate = validateArtifact(value, recapRoot, "mp4");
        if (!candidate.isFile()) {
            throw new IOException("The capsule recap video is no longer available.");
        }
        return candidate;
    }

    File removableArtifact(String value) {
        try {
            File parsed = localFile(value);
            String extension = extension(parsed.getName());
            if ("jpg".equals(extension)) {
                return validateArtifact(value, stagingRoot, extension);
            }
            if ("mp4".equals(extension)) {
                return validateArtifact(value, recapRoot, extension);
            }
        } catch (IOException ignored) {
            // Invalid or non-app paths are deliberately ignored by best-effort cleanup.
        }
        return null;
    }

    String bridgeUri(File file) {
        return file.toURI().toString();
    }

    private static File ensureDirectory(File cacheRoot, String child) throws IOException {
        File root = new File(cacheRoot, child).getCanonicalFile();
        File canonicalCache = cacheRoot.getCanonicalFile();
        if (!canonicalCache.equals(root.getParentFile())) {
            throw new IOException("The Capsule recap cache path is invalid.");
        }
        if ((!root.exists() && !root.mkdirs()) || !root.isDirectory()) {
            throw new IOException("The Capsule recap cache could not be created.");
        }
        return root;
    }

    private static File validateArtifact(
        String value,
        File expectedParent,
        String expectedExtension
    ) throws IOException {
        File candidate = localFile(value).getCanonicalFile();
        if (!expectedParent.equals(candidate.getParentFile())) {
            throw new IOException("The artifact is not in the app-owned Capsule recap cache.");
        }
        String name = candidate.getName();
        if (!expectedExtension.equals(extension(name))) {
            throw new IOException("The Capsule recap artifact type is invalid.");
        }
        String stem = name.substring(0, name.length() - expectedExtension.length() - 1);
        try {
            UUID.fromString(stem);
        } catch (IllegalArgumentException exception) {
            throw new IOException("The Capsule recap artifact name is invalid.", exception);
        }
        return candidate;
    }

    private static File localFile(String value) throws IOException {
        if (value == null || value.trim().isEmpty()) {
            throw new IOException("A local Capsule recap artifact is required.");
        }
        File pathValue = new File(value);
        if (pathValue.isAbsolute()) {
            return pathValue;
        }
        try {
            URI uri = new URI(value);
            if (!"file".equalsIgnoreCase(uri.getScheme())) {
                throw new IOException("Only a local file URI is accepted.");
            }
            return new File(uri);
        } catch (URISyntaxException | IllegalArgumentException exception) {
            throw new IOException("The Capsule recap file URI is invalid.", exception);
        }
    }

    private static String extension(String name) {
        int separator = name.lastIndexOf('.');
        return separator < 0 ? "" : name.substring(separator + 1).toLowerCase(Locale.ROOT);
    }
}
