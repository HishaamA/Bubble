package com.simerfamily.kinsphere.panorama;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * Bounded, calibration-aware fill-view planning. Run off the UI thread using a snapshot of
 * accepted frames, never the intended target poses. Coverage is a geometric estimate, not a
 * promise of a successful stitch: parallax, motion and feature alignment are not measured here.
 */
public final class PanoramaCoveragePlanner {
    public static final int MAX_TOTAL_FRAMES = 64;
    public static final int MAX_EXTRA_TARGETS = 12;
    public static final double AIM_MARGIN_DEGREES = 1.5;
    private static final int COLUMNS = 720;
    private static final int ROWS = 360;
    private static final int PIXELS = COLUMNS * ROWS;
    private static final double BORDER_PIXELS = 2.0;
    private static final int MAX_REGIONS = 12;
    private static final int MAX_CANDIDATES = 96;
    private static final BooleanSupplier NEVER_CANCELLED = () -> false;
    private static final Sphere SPHERE = new Sphere();

    private PanoramaCoveragePlanner() {}

    /** Row-major 3x3 intrinsics and column-major ARCore camera-to-world 4x4 transform. */
    public static final class Frame {
        public final int width;
        public final int height;
        private final double[] intrinsics;
        private final float[] transform;

        public Frame(int width, int height, double[] intrinsics, float[] transform) {
            if (width <= 4 || height <= 4 || intrinsics == null || intrinsics.length != 9 ||
                transform == null || transform.length != 16) {
                throw new IllegalArgumentException("A frame needs image dimensions, 3x3 intrinsics and a 4x4 pose.");
            }
            for (double value : intrinsics) {
                if (!Double.isFinite(value)) throw new IllegalArgumentException("Intrinsics must be finite.");
            }
            for (float value : transform) {
                if (!Float.isFinite(value)) throw new IllegalArgumentException("Pose must be finite.");
            }
            if (intrinsics[0] <= 0 || intrinsics[4] <= 0 || Math.abs(intrinsics[1]) > 0.0001 ||
                Math.abs(intrinsics[3]) > 0.0001 || Math.abs(intrinsics[6]) > 0.0001 ||
                Math.abs(intrinsics[7]) > 0.0001 || Math.abs(intrinsics[8] - 1) > 0.0001) {
                throw new IllegalArgumentException("Expected positive, unskewed pinhole intrinsics.");
            }
            for (int column = 0; column < 3; column++) {
                double norm = 0;
                for (int row = 0; row < 3; row++) norm += transform[column * 4 + row] * transform[column * 4 + row];
                if (Math.abs(norm - 1) > 0.02) throw new IllegalArgumentException("Pose rotation must be orthonormal.");
                for (int other = 0; other < column; other++) {
                    double dot = 0;
                    for (int row = 0; row < 3; row++) dot += transform[column * 4 + row] * transform[other * 4 + row];
                    if (Math.abs(dot) > 0.02) throw new IllegalArgumentException("Pose rotation must be orthonormal.");
                }
            }
            this.width = width;
            this.height = height;
            this.intrinsics = intrinsics.clone();
            this.transform = transform.clone();
        }

        public double[] getIntrinsics() { return intrinsics.clone(); }
        public float[] getTransform() { return transform.clone(); }
    }

    public static final class Target {
        /** [0,360), using PanoramaPose's yaw convention. */
        public final double yawDegrees;
        /** [-82,82]; a near-pole view covers the pole without requiring a singular aim. */
        public final double pitchDegrees;
        private final Frame frame;

        private Target(double yawDegrees, double pitchDegrees, Frame calibration) {
            this.yawDegrees = (yawDegrees % 360 + 360) % 360;
            this.pitchDegrees = Math.max(-82, Math.min(82, pitchDegrees));
            double yaw = Math.toRadians(this.yawDegrees);
            double pitch = Math.toRadians(this.pitchDegrees);
            double sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
            frame = new Frame(calibration.width, calibration.height, calibration.intrinsics, new float[] {
                (float) cy, 0, (float) sy, 0,
                (float) (-sp * sy), (float) cp, (float) (sp * cy), 0,
                (float) (-sy * cp), (float) -sp, (float) (cy * cp), 0,
                0, 0, 0, 1,
            });
        }

        /** Hypothetical upright frame, for prediction only; never replace an accepted pose with it. */
        public Frame asFrame() { return frame; }
    }

    public static final class Plan {
        public final List<Target> extraTargets;
        /** Solid-angle weighted observed coverage before adding any proposed views. */
        public final double initialCoverage;
        /** Equirectangular pixel coverage, also checked by the native stitch quality gate. */
        public final double initialPixelCoverage;
        /** Solid-angle weighted coverage including margin-shrunken proposed views. */
        public final double predictedCoverage;
        public final double remainingGapFraction;
        public final double pixelGapFraction;
        /** Largest wrapping, eight-connected uncovered component / all equirectangular pixels. */
        public final double largestHoleFraction;
        public final boolean cancelled;

        private Plan(List<Target> targets, BitSet initial, BitSet predicted, boolean cancelled) {
            this.extraTargets = Collections.unmodifiableList(new ArrayList<>(targets));
            this.initialCoverage = coverage(initial);
            this.initialPixelCoverage = initial.cardinality() / (double) PIXELS;
            this.predictedCoverage = coverage(predicted);
            this.remainingGapFraction = Math.max(0, 1 - predictedCoverage);
            this.pixelGapFraction = 1 - predicted.cardinality() / (double) PIXELS;
            List<Region> holes = regions(predicted, NEVER_CANCELLED);
            this.largestHoleFraction = holes.isEmpty() ? 0 : holes.get(0).size / (double) PIXELS;
            this.cancelled = cancelled;
        }
    }

    public static Plan plan(List<Frame> accepted, int maxExtraTargets) {
        return plan(accepted, maxExtraTargets, NEVER_CANCELLED);
    }

    /**
     * Greedy gap coverage with redundant-view pruning: a practical small set, not exact global
     * set cover. Call again after the proposed photos are accepted, using their real poses.
     * A cancelled plan is partial and must not be used to declare capture complete.
     */
    public static Plan plan(List<Frame> accepted, int maxExtraTargets, BooleanSupplier cancelled) {
        if (accepted == null || cancelled == null) throw new IllegalArgumentException("Frames and cancellation are required.");
        if (accepted.size() > MAX_TOTAL_FRAMES) throw new IllegalArgumentException("A scan is limited to 64 accepted frames.");
        List<Frame> frames = new ArrayList<>(accepted);
        for (Frame frame : frames) if (frame == null) throw new IllegalArgumentException("Accepted frame cannot be null.");
        BitSet initial = new BitSet(PIXELS);
        List<Target> targets = new ArrayList<>();
        for (Frame frame : frames) {
            if (!addCoverage(initial, new Projection(frame, false), null, cancelled)) {
                return new Plan(targets, initial, initial, true);
            }
        }
        BitSet predicted = (BitSet) initial.clone();
        int limit = Math.max(0, Math.min(Math.min(MAX_EXTRA_TARGETS, maxExtraTargets), MAX_TOTAL_FRAMES - frames.size()));
        List<BitSet> additions = new ArrayList<>();
        if (frames.isEmpty() || limit == 0) return new Plan(targets, initial, predicted, cancelled.getAsBoolean());
        Frame calibration = frames.get(frames.size() - 1);
        while (targets.size() < limit && predicted.cardinality() < PIXELS) {
            if (cancelled.getAsBoolean()) return new Plan(targets, initial, predicted, true);
            List<Region> holes = regions(predicted, cancelled);
            if (holes == null) return new Plan(targets, initial, predicted, true);
            List<Target> candidates = candidates(holes, calibration);
            BitSet uncovered = new BitSet(PIXELS);
            uncovered.set(0, PIXELS);
            uncovered.andNot(predicted);
            Target best = null;
            BitSet bestGain = null;
            int bestSize = 0;
            double bestArea = 0;
            for (Target candidate : candidates) {
                BitSet gain = new BitSet(PIXELS);
                if (!addCoverage(gain, new Projection(candidate.frame, true), uncovered, cancelled)) {
                    return new Plan(targets, initial, predicted, true);
                }
                int size = gain.cardinality();
                double area = size >= bestSize ? coverage(gain) : 0;
                if (size > bestSize || (size == bestSize && area > bestArea)) {
                    best = candidate;
                    bestGain = gain;
                    bestSize = size;
                    bestArea = area;
                }
            }
            if (best == null || bestSize == 0) break;
            // Retain coverage over every original gap for later redundant-target removal.
            BitSet originalGaps = new BitSet(PIXELS);
            originalGaps.set(0, PIXELS);
            originalGaps.andNot(initial);
            BitSet contribution = new BitSet(PIXELS);
            if (!addCoverage(contribution, new Projection(best.frame, true), originalGaps, cancelled)) {
                return new Plan(targets, initial, predicted, true);
            }
            targets.add(best);
            additions.add(contribution);
            predicted.or(bestGain);
        }
        // Keep the same predicted coverage while removing any target made redundant by later ones.
        for (int index = targets.size() - 1; index >= 0; index--) {
            if (cancelled.getAsBoolean()) return new Plan(targets, initial, predicted, true);
            BitSet without = (BitSet) initial.clone();
            for (int other = 0; other < additions.size(); other++) if (other != index) without.or(additions.get(other));
            if (without.equals(predicted)) {
                targets.remove(index);
                additions.remove(index);
            }
        }
        return new Plan(targets, initial, predicted, cancelled.getAsBoolean());
    }

    private static List<Target> candidates(List<Region> holes, Frame calibration) {
        List<Target> result = new ArrayList<>();
        int count = Math.min(MAX_REGIONS, holes.size());
        for (int index = 0; index < count; index++) {
            Region region = holes.get(index);
            addCandidate(result, region.x, region.y, region.z, calibration);
            // The centroid of a ring or large concave gap can lie outside that gap.
            addCandidate(result, SPHERE.x[region.seed], SPHERE.y[region.seed], SPHERE.z[region.seed], calibration);
            addCandidate(result, SPHERE.x[region.farthest], SPHERE.y[region.farthest], SPHERE.z[region.farthest], calibration);
        }
        // Nearby disconnected holes may fit in one frame, including opposite edges of the wrap.
        for (int first = 0; first < count && result.size() < MAX_CANDIDATES; first++) {
            for (int second = first + 1; second < count && result.size() < MAX_CANDIDATES; second++) {
                Region a = holes.get(first), b = holes.get(second);
                if (a.x * b.x + a.y * b.y + a.z * b.z > 0.5) {
                    addCandidate(result, a.x + b.x, a.y + b.y, a.z + b.z, calibration);
                }
            }
        }
        return result;
    }

    private static void addCandidate(List<Target> result, double x, double y, double z, Frame calibration) {
        if (result.size() >= MAX_CANDIDATES) return;
        double length = Math.sqrt(x * x + y * y + z * z);
        if (length < 0.000001) return;
        double yaw = Math.toDegrees(Math.atan2(x, z));
        double pitch = Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, y / length))));
        Target candidate = new Target(yaw, pitch, calibration);
        for (Target existing : result) {
            double yawDistance = Math.abs(existing.yawDegrees - candidate.yawDegrees);
            yawDistance = Math.min(yawDistance, 360 - yawDistance);
            if (yawDistance < 0.25 && Math.abs(existing.pitchDegrees - candidate.pitchDegrees) < 0.25) return;
        }
        result.add(candidate);
    }

    private static boolean addCoverage(BitSet result, Projection projection, BitSet allowed, BooleanSupplier cancelled) {
        for (int pixel = allowed == null ? 0 : allowed.nextSetBit(0); pixel >= 0 && pixel < PIXELS;
            pixel = allowed == null ? pixel + 1 : allowed.nextSetBit(pixel + 1)) {
            if ((pixel & 1023) == 0 && cancelled.getAsBoolean()) return false;
            if (!result.get(pixel) && projection.contains(SPHERE.x[pixel], SPHERE.y[pixel], SPHERE.z[pixel])) result.set(pixel);
        }
        return !cancelled.getAsBoolean();
    }

    private static double coverage(BitSet pixels) {
        double area = 0;
        for (int pixel = pixels.nextSetBit(0); pixel >= 0; pixel = pixels.nextSetBit(pixel + 1)) area += SPHERE.weight[pixel / COLUMNS];
        return Math.min(1, area / SPHERE.totalWeight);
    }

    private static List<Region> regions(BitSet covered, BooleanSupplier cancelled) {
        BitSet visited = (BitSet) covered.clone();
        List<Region> result = new ArrayList<>();
        int[] queue = new int[PIXELS];
        for (int seed = visited.nextClearBit(0); seed < PIXELS; seed = visited.nextClearBit(seed + 1)) {
            if (cancelled.getAsBoolean()) return null;
            int start = 0, end = 1;
            queue[0] = seed;
            visited.set(seed);
            double x = 0, y = 0, z = 0;
            int farthest = seed;
            double furthestDot = 1;
            while (start < end) {
                if ((start & 1023) == 0 && cancelled.getAsBoolean()) return null;
                int pixel = queue[start++], row = pixel / COLUMNS, column = pixel % COLUMNS;
                double weight = SPHERE.weight[row];
                x += SPHERE.x[pixel] * weight;
                y += SPHERE.y[pixel] * weight;
                z += SPHERE.z[pixel] * weight;
                double dot = SPHERE.x[seed] * SPHERE.x[pixel] + SPHERE.y[seed] * SPHERE.y[pixel] + SPHERE.z[seed] * SPHERE.z[pixel];
                if (dot < furthestDot) { furthestDot = dot; farthest = pixel; }
                for (int dy = -1; dy <= 1; dy++) {
                    int nextRow = row + dy;
                    if (nextRow < 0 || nextRow >= ROWS) continue;
                    for (int dx = -1; dx <= 1; dx++) {
                        int nextColumn = (column + dx + COLUMNS) % COLUMNS;
                        int next = nextRow * COLUMNS + nextColumn;
                        if (!visited.get(next)) { visited.set(next); queue[end++] = next; }
                    }
                }
            }
            double length = Math.sqrt(x * x + y * y + z * z);
            if (length < 0.000001) { x = SPHERE.x[seed]; y = SPHERE.y[seed]; z = SPHERE.z[seed]; length = 1; }
            result.add(new Region(end, seed, farthest, x / length, y / length, z / length));
        }
        result.sort(Comparator.comparingInt((Region region) -> region.size).reversed());
        return result;
    }

    private static final class Projection {
        final double rx, ry, rz, ux, uy, uz, fx, fy, fz;
        final double left, right, bottom, top;
        final double leftMargin, rightMargin, bottomMargin, topMargin;

        Projection(Frame frame, boolean margin) {
            float[] t = frame.transform;
            // ARCore world -Z forward -> equirectangular world +Z forward; preserve actual roll.
            rx = t[0]; ry = t[1]; rz = -t[2];
            ux = t[4]; uy = t[5]; uz = -t[6];
            fx = -t[8]; fy = -t[9]; fz = t[10];
            left = (BORDER_PIXELS - frame.intrinsics[2]) / frame.intrinsics[0];
            right = (frame.width - BORDER_PIXELS - frame.intrinsics[2]) / frame.intrinsics[0];
            bottom = -(frame.height - BORDER_PIXELS - frame.intrinsics[5]) / frame.intrinsics[4];
            top = -(BORDER_PIXELS - frame.intrinsics[5]) / frame.intrinsics[4];
            // Distance from each normalized frustum plane provides a true angular margin,
            // including corners, rather than shrinking only yaw/pitch at the image center.
            double sineMargin = margin ? Math.sin(Math.toRadians(AIM_MARGIN_DEGREES)) : 0;
            leftMargin = sineMargin * Math.sqrt(1 + left * left);
            rightMargin = sineMargin * Math.sqrt(1 + right * right);
            bottomMargin = sineMargin * Math.sqrt(1 + bottom * bottom);
            topMargin = sineMargin * Math.sqrt(1 + top * top);
        }

        boolean contains(double x, double y, double z) {
            double depth = x * fx + y * fy + z * fz;
            if (depth <= 0) return false;
            double cameraX = x * rx + y * ry + z * rz;
            double cameraY = x * ux + y * uy + z * uz;
            return cameraX - left * depth >= leftMargin && right * depth - cameraX > rightMargin &&
                cameraY - bottom * depth > bottomMargin && top * depth - cameraY >= topMargin;
        }
    }

    private static final class Region {
        final int size, seed, farthest;
        final double x, y, z;
        Region(int size, int seed, int farthest, double x, double y, double z) {
            this.size = size; this.seed = seed; this.farthest = farthest; this.x = x; this.y = y; this.z = z;
        }
    }

    private static final class Sphere {
        final float[] x = new float[PIXELS], y = new float[PIXELS], z = new float[PIXELS];
        final double[] weight = new double[ROWS];
        final double totalWeight;
        Sphere() {
            double total = 0;
            for (int row = 0; row < ROWS; row++) {
                double pitch = Math.PI * (0.5 - (row + 0.5) / ROWS);
                double cp = Math.cos(pitch), sp = Math.sin(pitch);
                weight[row] = cp;
                total += cp * COLUMNS;
                for (int column = 0; column < COLUMNS; column++) {
                    double yaw = Math.PI * 2 * ((column + 0.5) / COLUMNS - 0.5);
                    int index = row * COLUMNS + column;
                    x[index] = (float) (cp * Math.sin(yaw)); y[index] = (float) sp; z[index] = (float) (cp * Math.cos(yaw));
                }
            }
            totalWeight = total;
        }
    }
}
