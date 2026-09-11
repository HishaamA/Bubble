package com.simerfamily.kinsphere.widget;

import java.nio.charset.StandardCharsets;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A small, validated representation of the shared widget snapshot contract. */
final class BubbleWidgetSnapshot {

    static final int CONTRACT_VERSION = 1;
    static final int MAX_SNAPSHOT_BYTES = 64 * 1024;
    private static final int MAX_SCHEDULE_ENTRIES = 12;
    private static final int MAX_PAGES = 12;

    private static final String[] KINDS = {
        "urgent", "unlock", "today", "capture", "memory", "empty"
    };
    private static final String[] THEMES = { "plum", "forest", "midnight" };
    private static final String[] PRIVACY_VALUES = { "full", "hidden" };
    private static final String[] PAGE_GROUPS = { "tasks", "photos", "recap", "capture" };
    private static final String[] ISO_PATTERNS = {
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ssXXX",
        "yyyy-MM-dd'T'HH:mmXXX"
    };

    final long generatedAtMillis;
    final long nextRefreshAtMillis;
    final String kind;
    final String theme;
    final String eyebrow;
    final String title;
    final String subtitle;
    final String badge;
    final String route;
    final String privacy;
    final List<ScheduledCard> schedule;
    final List<Page> pages;

    BubbleWidgetSnapshot(
        long generatedAtMillis,
        long nextRefreshAtMillis,
        String kind,
        String theme,
        String eyebrow,
        String title,
        String subtitle,
        String badge,
        String route,
        String privacy,
        List<ScheduledCard> schedule
    ) {
        this(
            generatedAtMillis,
            nextRefreshAtMillis,
            kind,
            theme,
            eyebrow,
            title,
            subtitle,
            badge,
            route,
            privacy,
            schedule,
            Collections.emptyList()
        );
    }

    BubbleWidgetSnapshot(
        long generatedAtMillis,
        long nextRefreshAtMillis,
        String kind,
        String theme,
        String eyebrow,
        String title,
        String subtitle,
        String badge,
        String route,
        String privacy,
        List<ScheduledCard> schedule,
        List<Page> pages
    ) {
        this.generatedAtMillis = generatedAtMillis;
        this.nextRefreshAtMillis = nextRefreshAtMillis;
        this.kind = kind;
        this.theme = theme;
        this.eyebrow = eyebrow;
        this.title = title;
        this.subtitle = subtitle;
        this.badge = badge;
        this.route = route;
        this.privacy = privacy;
        this.schedule = Collections.unmodifiableList(new ArrayList<>(schedule));
        this.pages = Collections.unmodifiableList(new ArrayList<>(pages));
    }

    /** Parses the exact version-one payload, rejecting oversized or unsafe fields. */
    static BubbleWidgetSnapshot parse(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            throw new IllegalArgumentException("snapshot is required.");
        }
        if (raw.getBytes(StandardCharsets.UTF_8).length > MAX_SNAPSHOT_BYTES) {
            throw new IllegalArgumentException("snapshot is too large.");
        }

        final JSONObject json;
        try {
            json = new JSONObject(raw);
        } catch (JSONException exception) {
            throw new IllegalArgumentException("snapshot must be valid JSON.", exception);
        }

        Object version = json.opt("version");
        if (
            !(version instanceof Number) ||
            ((Number) version).doubleValue() != CONTRACT_VERSION
        ) {
            throw new IllegalArgumentException("snapshot version must be 1.");
        }

        long generatedAt = requireTimestamp(json, "generatedAt");
        long nextRefreshAt = optionalTimestamp(json, "nextRefreshAt");
        String kind = requireEnum(json, "kind", KINDS);
        String theme = requireEnum(json, "theme", THEMES);
        String eyebrow = requireText(json, "eyebrow", 40);
        // Family captions may contain up to 240 characters. The compact
        // RemoteViews ellipsize visually, while validation preserves every
        // otherwise valid server value instead of leaving a stale widget.
        String title = requireText(json, "title", 260);
        String subtitle = optionalText(json, "subtitle", 320);
        String badge = optionalText(json, "badge", 40);
        String route = requireText(json, "route", 512);
        String privacy = requireEnum(json, "privacy", PRIVACY_VALUES);

        if (!isLocalRoute(route)) {
            throw new IllegalArgumentException("route must be a local app path.");
        }
        List<ScheduledCard> schedule = parseSchedule(
            json,
            generatedAt,
            theme,
            privacy
        );
        List<Page> pages = parsePages(json, privacy);

        return new BubbleWidgetSnapshot(
            generatedAt,
            nextRefreshAt,
            kind,
            theme,
            eyebrow,
            title,
            subtitle,
            badge,
            route,
            privacy,
            schedule,
            pages
        );
    }

    /** Friendly content shown before the app has published its first snapshot. */
    static BubbleWidgetSnapshot fallback(String theme) {
        String safeTheme = contains(THEMES, theme) ? theme : "plum";
        return new BubbleWidgetSnapshot(
            System.currentTimeMillis(),
            0L,
            "capture",
            safeTheme,
            "THIS WEEK",
            "A little moment?",
            "Take a quick photo for your family capsule.",
            "Open camera",
            "/capture?mode=manual",
            "hidden",
            Collections.emptyList(),
            Collections.emptyList()
        );
    }

    /** Keeps useful same-day content, but fails private once its local day ends. */
    BubbleWidgetSnapshot forDisplay(long nowMillis) {
        Calendar generated = Calendar.getInstance();
        generated.setTimeInMillis(generatedAtMillis);
        Calendar now = Calendar.getInstance();
        now.setTimeInMillis(nowMillis);
        boolean sameLocalDay = generated.get(Calendar.ERA) == now.get(Calendar.ERA)
            && generated.get(Calendar.YEAR) == now.get(Calendar.YEAR)
            && generated.get(Calendar.DAY_OF_YEAR) == now.get(Calendar.DAY_OF_YEAR);
        if (!sameLocalDay) {
            return fallback(theme);
        }
        ScheduledCard active = null;
        for (ScheduledCard scheduled : schedule) {
            if (scheduled.effectiveAtMillis > nowMillis) {
                break;
            }
            active = scheduled;
        }
        if (active != null) {
            return new BubbleWidgetSnapshot(
                generatedAtMillis,
                nextRefreshAtMillis,
                active.kind,
                active.theme,
                active.eyebrow,
                active.title,
                active.subtitle,
                active.badge,
                active.route,
                active.privacy,
                Collections.emptyList(),
                pages
            );
        }
        return this;
    }

    /** Earliest future redraw boundary represented by this stored payload. */
    long nextTransitionAtMillis(long nowMillis) {
        if (!isSameLocalDay(generatedAtMillis, nowMillis)) {
            return 0L;
        }
        long next = nextRefreshAtMillis > nowMillis ? nextRefreshAtMillis : 0L;
        for (ScheduledCard scheduled : schedule) {
            if (scheduled.effectiveAtMillis > nowMillis) {
                return next == 0L
                    ? scheduled.effectiveAtMillis
                    : Math.min(next, scheduled.effectiveAtMillis);
            }
        }
        return next;
    }

    boolean mayShowThumbnail() {
        return "full".equals(privacy) && ("memory".equals(kind) || "unlock".equals(kind));
    }

    boolean isCurrentLocalDay(long nowMillis) {
        return isSameLocalDay(generatedAtMillis, nowMillis);
    }

    Page findPage(String id) {
        if (id == null) {
            return null;
        }
        for (Page page : pages) {
            if (page.id.equals(id)) {
                return page;
            }
        }
        return null;
    }

    String toStorageJson() {
        try {
            JSONObject json = new JSONObject();
            json.put("version", CONTRACT_VERSION);
            json.put("generatedAt", formatTimestamp(generatedAtMillis));
            if (nextRefreshAtMillis > 0L) {
                json.put("nextRefreshAt", formatTimestamp(nextRefreshAtMillis));
            }
            json.put("kind", kind);
            json.put("theme", theme);
            json.put("eyebrow", eyebrow);
            json.put("title", title);
            if (subtitle != null) {
                json.put("subtitle", subtitle);
            }
            if (badge != null) {
                json.put("badge", badge);
            }
            json.put("route", route);
            json.put("privacy", privacy);
            if (!schedule.isEmpty()) {
                JSONArray scheduled = new JSONArray();
                for (ScheduledCard card : schedule) {
                    scheduled.put(card.toJson());
                }
                json.put("schedule", scheduled);
            }
            if (!pages.isEmpty()) {
                JSONArray pageValues = new JSONArray();
                for (Page page : pages) {
                    pageValues.put(page.toJson());
                }
                json.put("pages", pageValues);
            }
            return json.toString();
        } catch (JSONException impossible) {
            throw new IllegalStateException("Validated widget data could not be serialized.", impossible);
        }
    }

    private static List<Page> parsePages(JSONObject json, String parentPrivacy) {
        if (!json.has("pages") || json.isNull("pages")) {
            return Collections.emptyList();
        }
        Object raw = json.opt("pages");
        if (!(raw instanceof JSONArray)) {
            throw new IllegalArgumentException("pages must be an array.");
        }
        JSONArray values = (JSONArray) raw;
        if (values.length() > MAX_PAGES) {
            throw new IllegalArgumentException("pages has too many entries.");
        }
        if (values.length() > 0 && !"full".equals(parentPrivacy)) {
            throw new IllegalArgumentException("hidden snapshots cannot contain pages.");
        }

        String[] allowedKeys = {
            "id", "group", "kind", "theme", "eyebrow", "title",
            "subtitle", "badge", "route", "privacy"
        };
        List<Page> result = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < values.length(); index += 1) {
            Object rawPage = values.opt(index);
            if (!(rawPage instanceof JSONObject)) {
                throw new IllegalArgumentException("pages entries must be objects.");
            }
            JSONObject page = (JSONObject) rawPage;
            requireOnlyKeys(page, allowedKeys, "page");
            String id = requireText(page, "id", 120);
            if (!ids.add(id)) {
                throw new IllegalArgumentException("page ids must be unique.");
            }
            String group = requireEnum(page, "group", PAGE_GROUPS);
            String kind = requireEnum(page, "kind", KINDS);
            if (!isSupportedPageKind(group, kind)) {
                throw new IllegalArgumentException("page group does not match its kind.");
            }
            String theme = requireEnum(page, "theme", THEMES);
            String eyebrow = requireText(page, "eyebrow", 40);
            String title = requireText(page, "title", 260);
            String subtitle = optionalText(page, "subtitle", 320);
            String badge = optionalText(page, "badge", 40);
            String route = requireText(page, "route", 512);
            String privacy = requireEnum(page, "privacy", PRIVACY_VALUES);
            if (!parentPrivacy.equals(privacy) || !isLocalRoute(route)) {
                throw new IllegalArgumentException("page does not match its snapshot.");
            }
            result.add(new Page(
                id,
                group,
                kind,
                theme,
                eyebrow,
                title,
                subtitle,
                badge,
                route,
                privacy
            ));
        }
        return result;
    }

    private static String kindForGroup(String group) {
        switch (group) {
            case "tasks":
                return "today";
            case "photos":
                return "memory";
            case "recap":
                return "unlock";
            case "capture":
            default:
                return "capture";
        }
    }

    static boolean isSupportedPageKind(String group, String kind) {
        return contains(PAGE_GROUPS, group) && kindForGroup(group).equals(kind);
    }

    private static List<ScheduledCard> parseSchedule(
        JSONObject json,
        long generatedAtMillis,
        String expectedTheme,
        String expectedPrivacy
    ) {
        if (!json.has("schedule") || json.isNull("schedule")) {
            return Collections.emptyList();
        }
        Object raw = json.opt("schedule");
        if (!(raw instanceof JSONArray)) {
            throw new IllegalArgumentException("schedule must be an array.");
        }
        JSONArray values = (JSONArray) raw;
        if (values.length() > MAX_SCHEDULE_ENTRIES) {
            throw new IllegalArgumentException("schedule has too many entries.");
        }

        List<ScheduledCard> result = new ArrayList<>();
        long previous = generatedAtMillis;
        long nextMidnight = nextLocalMidnight(generatedAtMillis);
        String[] allowedKeys = {
            "effectiveAt", "kind", "theme", "eyebrow", "title",
            "subtitle", "badge", "route", "privacy"
        };
        for (int index = 0; index < values.length(); index += 1) {
            Object rawEntry = values.opt(index);
            if (!(rawEntry instanceof JSONObject)) {
                throw new IllegalArgumentException("schedule entries must be objects.");
            }
            JSONObject entry = (JSONObject) rawEntry;
            requireOnlyKeys(entry, allowedKeys, "schedule");
            long effectiveAt = requireTimestamp(entry, "effectiveAt");
            if (
                effectiveAt <= previous ||
                effectiveAt >= nextMidnight ||
                !isSameLocalDay(generatedAtMillis, effectiveAt)
            ) {
                throw new IllegalArgumentException(
                    "schedule effectiveAt values must be ordered within the generated local day."
                );
            }
            String kind = requireEnum(entry, "kind", KINDS);
            String theme = requireEnum(entry, "theme", THEMES);
            String eyebrow = requireText(entry, "eyebrow", 40);
            String title = requireText(entry, "title", 260);
            String subtitle = optionalText(entry, "subtitle", 320);
            String badge = optionalText(entry, "badge", 40);
            String route = requireText(entry, "route", 512);
            String privacy = requireEnum(entry, "privacy", PRIVACY_VALUES);
            if (
                !theme.equals(expectedTheme) ||
                !privacy.equals(expectedPrivacy) ||
                !isLocalRoute(route)
            ) {
                throw new IllegalArgumentException("schedule card does not match its snapshot.");
            }
            result.add(new ScheduledCard(
                effectiveAt,
                kind,
                theme,
                eyebrow,
                title,
                subtitle,
                badge,
                route,
                privacy
            ));
            previous = effectiveAt;
        }
        return result;
    }

    private static long requireTimestamp(JSONObject json, String key) {
        long value = parseTimestamp(json.opt(key), key);
        if (value <= 0L) {
            throw new IllegalArgumentException(key + " must be a valid ISO-8601 timestamp.");
        }
        return value;
    }

    private static long optionalTimestamp(JSONObject json, String key) {
        if (!json.has(key) || json.isNull(key)) {
            return 0L;
        }
        long value = parseTimestamp(json.opt(key), key);
        if (value <= 0L) {
            throw new IllegalArgumentException(key + " must be a valid ISO-8601 timestamp.");
        }
        return value;
    }

    private static long parseTimestamp(Object raw, String key) {
        if (!(raw instanceof String)) {
            return -1L;
        }
        String value = ((String) raw).trim();
        for (String pattern : ISO_PATTERNS) {
            SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
            format.setLenient(false);
            ParsePosition position = new ParsePosition(0);
            Date date = format.parse(value, position);
            if (date != null && position.getIndex() == value.length()) {
                return date.getTime();
            }
        }
        return -1L;
    }

    private static String formatTimestamp(long timestampMillis) {
        SimpleDateFormat format = new SimpleDateFormat(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            Locale.US
        );
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(timestampMillis));
    }

    private static String requireEnum(JSONObject json, String key, String[] allowed) {
        String value = requireText(json, key, 32).toLowerCase(Locale.US);
        if (!contains(allowed, value)) {
            throw new IllegalArgumentException(key + " has an unsupported value.");
        }
        return value;
    }

    private static String requireText(JSONObject json, String key, int maximumLength) {
        String value = optionalText(json, key, maximumLength);
        if (value == null) {
            throw new IllegalArgumentException(key + " is required.");
        }
        return value;
    }

    private static String optionalText(JSONObject json, String key, int maximumLength) {
        if (!json.has(key) || json.isNull(key)) {
            return null;
        }
        Object raw = json.opt(key);
        if (!(raw instanceof String)) {
            throw new IllegalArgumentException(key + " must be text.");
        }
        String value = ((String) raw).trim();
        if (value.isEmpty()) {
            return null;
        }
        if (value.length() > maximumLength) {
            throw new IllegalArgumentException(key + " is too long.");
        }
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (Character.isISOControl(character)) {
                throw new IllegalArgumentException(key + " contains unsupported control characters.");
            }
        }
        return value;
    }

    private static boolean contains(String[] values, String candidate) {
        if (candidate == null) {
            return false;
        }
        for (String value : values) {
            if (value.equals(candidate)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isLocalRoute(String route) {
        return route.startsWith("/")
            && !route.startsWith("//")
            && !route.contains("\\");
    }

    private static boolean isSameLocalDay(long leftMillis, long rightMillis) {
        Calendar left = Calendar.getInstance();
        left.setTimeInMillis(leftMillis);
        Calendar right = Calendar.getInstance();
        right.setTimeInMillis(rightMillis);
        return left.get(Calendar.ERA) == right.get(Calendar.ERA)
            && left.get(Calendar.YEAR) == right.get(Calendar.YEAR)
            && left.get(Calendar.DAY_OF_YEAR) == right.get(Calendar.DAY_OF_YEAR);
    }

    private static long nextLocalMidnight(long fromMillis) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(fromMillis);
        calendar.add(Calendar.DAY_OF_MONTH, 1);
        calendar.set(Calendar.HOUR_OF_DAY, 0);
        calendar.set(Calendar.MINUTE, 0);
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);
        return calendar.getTimeInMillis();
    }

    private static void requireOnlyKeys(JSONObject json, String[] allowed, String label) {
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            if (!contains(allowed, keys.next())) {
                throw new IllegalArgumentException(label + " contains an unsupported field.");
            }
        }
    }

    static final class Page {
        final String id;
        final String group;
        final String kind;
        final String theme;
        final String eyebrow;
        final String title;
        final String subtitle;
        final String badge;
        final String route;
        final String privacy;

        Page(
            String id,
            String group,
            String kind,
            String theme,
            String eyebrow,
            String title,
            String subtitle,
            String badge,
            String route,
            String privacy
        ) {
            this.id = id;
            this.group = group;
            this.kind = kind;
            this.theme = theme;
            this.eyebrow = eyebrow;
            this.title = title;
            this.subtitle = subtitle;
            this.badge = badge;
            this.route = route;
            this.privacy = privacy;
        }

        boolean mayShowThumbnail() {
            return "full".equals(privacy) &&
                ("photos".equals(group) || "recap".equals(group));
        }

        JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("group", group);
            json.put("kind", kind);
            json.put("theme", theme);
            json.put("eyebrow", eyebrow);
            json.put("title", title);
            if (subtitle != null) {
                json.put("subtitle", subtitle);
            }
            if (badge != null) {
                json.put("badge", badge);
            }
            json.put("route", route);
            json.put("privacy", privacy);
            return json;
        }
    }

    static final class ScheduledCard {
        final long effectiveAtMillis;
        final String kind;
        final String theme;
        final String eyebrow;
        final String title;
        final String subtitle;
        final String badge;
        final String route;
        final String privacy;

        ScheduledCard(
            long effectiveAtMillis,
            String kind,
            String theme,
            String eyebrow,
            String title,
            String subtitle,
            String badge,
            String route,
            String privacy
        ) {
            this.effectiveAtMillis = effectiveAtMillis;
            this.kind = kind;
            this.theme = theme;
            this.eyebrow = eyebrow;
            this.title = title;
            this.subtitle = subtitle;
            this.badge = badge;
            this.route = route;
            this.privacy = privacy;
        }

        JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("effectiveAt", formatTimestamp(effectiveAtMillis));
            json.put("kind", kind);
            json.put("theme", theme);
            json.put("eyebrow", eyebrow);
            json.put("title", title);
            if (subtitle != null) {
                json.put("subtitle", subtitle);
            }
            if (badge != null) {
                json.put("badge", badge);
            }
            json.put("route", route);
            json.put("privacy", privacy);
            return json;
        }
    }
}
