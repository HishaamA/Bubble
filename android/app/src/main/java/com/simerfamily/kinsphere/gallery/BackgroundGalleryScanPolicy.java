package com.simerfamily.kinsphere.gallery;

import java.net.URLDecoder;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/** Pure bounds shared by the service and tests; never accepts arbitrary file paths. */
final class BackgroundGalleryScanPolicy {
    static final int MAX_PHOTOS = 20_000;
    static final int MAX_RESULT_BYTES = 700_000;
    static final int MAX_BATCH_BYTES = 1_000_000;
    static final long MAX_OUTBOX_BYTES = 256L * 1024 * 1024;
    static final int MAX_ATTEMPTS = 3;
    private BackgroundGalleryScanPolicy() {}

    static String bounded(String value, int maximum) {
        if (value == null || value.isEmpty() || value.length() > maximum) throw new IllegalArgumentException("Invalid scan metadata");
        for (int i = 0; i < value.length(); i++) if (value.charAt(i) < 32 || value.charAt(i) == 127) {
            throw new IllegalArgumentException("Invalid scan metadata");
        }
        return value;
    }

    static String scope(String value) { return bounded(value, 512); }

    static void photo(String scope, String key, String nativeId, String source) {
        scope(scope);
        PhoneGalleryLimits.mediaId(nativeId);
        bounded(key, 2048);
        bounded(source, 8192);
        if (!key.startsWith("journal-photo:device-gallery:" + nativeId + ":") ||
            !source.startsWith("bubble-gallery:" + nativeId + "?")) throw new IllegalArgumentException("Invalid gallery reference");
        Map<String, String> query = query(source);
        if (!scope.equals(query.get("scope"))) throw new IllegalArgumentException("Photo belongs to another account");
        String modified = query.get("v");
        if (modified != null) Instant.parse(modified);
    }

    static long modifiedSeconds(String source) {
        String value = query(source).get("v");
        return value == null ? -1 : Instant.parse(value).getEpochSecond();
    }

    private static Map<String, String> query(String source) {
        Map<String, String> values = new HashMap<>();
        int separator = source.indexOf('?');
        if (separator < 0) throw new IllegalArgumentException("Invalid gallery reference");
        for (String item : source.substring(separator + 1).split("&", -1)) {
            String[] pair = item.split("=", 2);
            String name = decode(pair[0]);
            String value = pair.length == 2 ? decode(pair[1]) : "";
            if ((!name.equals("scope") && !name.equals("v")) || values.put(name, value) != null) {
                throw new IllegalArgumentException("Invalid gallery reference");
            }
        }
        return values;
    }

    private static String decode(String value) {
        try { return URLDecoder.decode(value, "UTF-8"); }
        catch (java.io.UnsupportedEncodingException impossible) { throw new IllegalStateException(impossible); }
    }

    static boolean tokenMatches(String expected, String actual) {
        return expected != null && expected.equals(actual);
    }

    static int resultLimit(int value) { return Math.max(1, Math.min(32, value)); }

    /** Readiness is not proof of a usable model; only a valid checkpoint resets this. */
    static final class RuntimeBudget {
        private int failures;
        boolean failed() { return ++failures >= MAX_ATTEMPTS; }
        void completed() { failures = 0; }
    }
}
