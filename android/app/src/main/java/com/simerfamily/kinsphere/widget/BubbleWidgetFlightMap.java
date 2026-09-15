package com.simerfamily.kinsphere.widget;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/** Bounded 360x180 route geometry shared with the app, without provider credentials. */
final class BubbleWidgetFlightMap {
    private static final Set<String> MODES = new HashSet<>(Arrays.asList(
        "live", "estimated", "scheduled", "arrived", "cancelled", "unavailable"));
    final Point start;
    final Point end;
    final Point control;
    final Point marker;
    final double rotation;
    final String mode;
    final Double progress;
    final boolean advanceWithTime;

    BubbleWidgetFlightMap(Point start, Point end, Point control, Point marker,
        double rotation, String mode, Double progress, boolean advanceWithTime) {
        if (start == null || end == null || control == null || marker == null
            || !Double.isFinite(rotation)
            || !MODES.contains(mode) || (progress != null
                && (!Double.isFinite(progress) || progress < 0 || progress > 100)))
            throw new IllegalArgumentException("Invalid flight map.");
        this.start = start;
        this.end = end;
        this.control = control;
        this.marker = marker;
        this.rotation = rotation % 360;
        this.mode = mode;
        this.progress = progress;
        this.advanceWithTime = advanceWithTime && ("estimated".equals(mode) || "scheduled".equals(mode));
    }

    boolean mayAdvance() { return advanceWithTime; }

    boolean showsPlane() {
        return !"cancelled".equals(mode) && !"unavailable".equals(mode);
    }

    BubbleWidgetFlightMap at(long now, BubbleWidgetSnapshot.Flight flight) {
        if ("arrived".equals(mode))
            return new BubbleWidgetFlightMap(start, end, control, end, rotation, mode, 100.0, false);
        if (!mayAdvance() || flight == null) return this;
        double percentage = Math.max(0, Math.min(100, 100.0 * (now - flight.departureAtMillis)
            / (flight.arrivalAtMillis - flight.departureAtMillis)));
        double t = percentage / 100;
        double inverse = 1 - t;
        Point position = new Point(inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
            inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y);
        double dx = 2 * inverse * (control.x - start.x) + 2 * t * (end.x - control.x);
        double dy = 2 * inverse * (control.y - start.y) + 2 * t * (end.y - control.y);
        return new BubbleWidgetFlightMap(start, end, control, position,
            Math.toDegrees(Math.atan2(dy, dx)), mode, percentage, true);
    }

    String label() {
        switch (mode) {
            case "live": return "Last reported location";
            case "arrived": return "Arrived at destination";
            case "cancelled": return "Cancelled · route only";
            case "unavailable": return "Location unavailable";
            case "scheduled": return "Scheduled route · not live GPS";
            default: return "Estimated route · not live GPS";
        }
    }

    static BubbleWidgetFlightMap parse(JSONObject json) {
        onlyKeys(json, "start", "end", "control", "marker", "rotation", "mode", "progress", "advanceWithTime");
        Object mode = json.opt("mode");
        if (!(mode instanceof String)) throw new IllegalArgumentException("flightMap.mode is required.");
        if (!json.has("progress")) throw new IllegalArgumentException("flightMap.progress is required.");
        Double progress = json.isNull("progress") ? null : number(json.opt("progress"));
        Object advance = json.opt("advanceWithTime");
        if (advance != null && advance != JSONObject.NULL && !(advance instanceof Boolean))
            throw new IllegalArgumentException("flightMap.advanceWithTime must be boolean.");
        return new BubbleWidgetFlightMap(point(json.opt("start")), point(json.opt("end")),
            point(json.opt("control")), point(json.opt("marker")), number(json.opt("rotation")),
            (String) mode, progress, Boolean.TRUE.equals(advance));
    }

    JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject().put("start", start.toJson()).put("end", end.toJson())
            .put("control", control.toJson()).put("marker", marker.toJson())
            .put("rotation", rotation).put("mode", mode)
            .put("progress", progress == null ? JSONObject.NULL : progress);
        if (advanceWithTime) json.put("advanceWithTime", true);
        return json;
    }

    private static Point point(Object raw) {
        if (!(raw instanceof JSONObject)) throw new IllegalArgumentException("flightMap point is required.");
        JSONObject json = (JSONObject) raw;
        onlyKeys(json, "x", "y");
        return new Point(number(json.opt("x")), number(json.opt("y")));
    }

    private static double number(Object raw) {
        if (!(raw instanceof Number) || !Double.isFinite(((Number) raw).doubleValue()))
            throw new IllegalArgumentException("flightMap coordinates must be finite numbers.");
        return ((Number) raw).doubleValue();
    }

    private static void onlyKeys(JSONObject json, String... allowed) {
        Set<String> keys = new HashSet<>(Arrays.asList(allowed));
        Iterator<String> iterator = json.keys();
        while (iterator.hasNext()) if (!keys.contains(iterator.next()))
            throw new IllegalArgumentException("flightMap contains an unsupported field.");
    }

    static final class Point {
        final double x;
        final double y;
        Point(double x, double y) {
            if (!Double.isFinite(x) || !Double.isFinite(y) || x < -360 || x > 720 || y < -180 || y > 360)
                throw new IllegalArgumentException("flightMap point is out of bounds.");
            this.x = x; this.y = y;
        }
        JSONObject toJson() throws JSONException { return new JSONObject().put("x", x).put("y", y); }
    }
}
