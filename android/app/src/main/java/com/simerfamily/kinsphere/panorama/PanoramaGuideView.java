package com.simerfamily.kinsphere.panorama;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.os.SystemClock;
import android.util.AttributeSet;
import android.view.View;
import androidx.annotation.Nullable;
import java.util.Collections;
import java.util.List;

/** Monochrome target-dot overlay for the native panorama camera preview. */
final class PanoramaGuideView extends View {

    private static final long FLASH_DURATION_MILLIS = 180L;
    private static final float[] IDENTITY_ROTATION = {
        1.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 1.0f,
    };

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint scrimPaint = new Paint();
    private final RectF progressBounds = new RectF();
    private final Path chevronPath = new Path();
    private final float[] deviceDirection = new float[3];
    private final float density;
    private List<PanoramaTarget> targets = Collections.emptyList();
    private final float[] cameraRotation = IDENTITY_ROTATION.clone();
    private float[] projection = identityProjection();
    private int activeTargetIndex = -1;
    private float holdProgress;
    private boolean aligned;
    private boolean steady;
    private boolean capturing;
    private long flashStartedAtMillis;
    private LinearGradient topScrim;
    private LinearGradient bottomScrim;

    /** Creates the guide using default view attributes. */
    PanoramaGuideView(Context context) {
        this(context, null);
    }

    /** Initializes density-aware drawing state and an accessible overlay label. */
    PanoramaGuideView(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        density = getResources().getDisplayMetrics().density;
        // Software rendering is required for the deliberately soft target and
        // reticle shadows drawn above the hardware-accelerated camera surface.
        setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        setContentDescription("Guided panorama capture");
    }

    /** Replaces the deterministic capture grid displayed by this overlay. */
    void setTargets(List<PanoramaTarget> targets) {
        this.targets = targets;
        invalidate();
    }

    /** Copies the latest pose state from the GL thread and schedules one UI redraw. */
    void updatePose(
        float[] cameraRotation,
        float[] projection,
        int activeTargetIndex,
        float holdProgress,
        boolean aligned,
        boolean steady,
        boolean capturing
    ) {
        System.arraycopy(cameraRotation, 0, this.cameraRotation, 0, 9);
        if (projection != null && projection.length == 16) {
            System.arraycopy(projection, 0, this.projection, 0, 16);
        }
        this.activeTargetIndex = activeTargetIndex;
        this.holdProgress = Math.max(0.0f, Math.min(1.0f, holdProgress));
        this.aligned = aligned;
        this.steady = steady;
        this.capturing = capturing;
        postInvalidateOnAnimation();
    }

    /** Starts the short visual acknowledgement after a frame is accepted. */
    void pulseCapture() {
        flashStartedAtMillis = SystemClock.uptimeMillis();
        postInvalidateOnAnimation();
    }

    /** Rebuilds edge scrims for the current portrait or landscape surface size. */
    @Override
    protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        float scrimHeight = Math.max(dp(132.0f), height * 0.23f);
        topScrim = new LinearGradient(
            0.0f,
            0.0f,
            0.0f,
            scrimHeight,
            new int[] { 0xB8000000, 0x62000000, Color.TRANSPARENT },
            null,
            Shader.TileMode.CLAMP
        );
        bottomScrim = new LinearGradient(
            0.0f,
            height - scrimHeight,
            0.0f,
            height,
            new int[] { Color.TRANSPARENT, 0x62000000, 0xB8000000 },
            null,
            Shader.TileMode.CLAMP
        );
    }

    /** Draws uncaptured targets, off-screen navigation, reticle progress, and flash. */
    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        drawScrims(canvas);

        boolean activeWasDrawn = false;
        PanoramaTarget activeTarget = null;
        int remainingTargetCount = 0;
        for (PanoramaTarget target : targets) {
            if (!target.captured) {
                remainingTargetCount += 1;
            }
            boolean drawn = drawProjectedTarget(canvas, target);
            if (target.index == activeTargetIndex) {
                activeTarget = target;
                activeWasDrawn = drawn;
            }
        }

        boolean showCompletionChevron =
            PanoramaCapturePolicy.shouldShowCompletionChevron(remainingTargetCount);
        if (!activeWasDrawn || showCompletionChevron) {
            drawActiveEdgeMarker(
                canvas,
                activeTarget,
                showCompletionChevron
            );
        }
        drawCenterReticle(canvas);
        drawCaptureFlash(canvas);
    }

    /** Preserves guide readability over bright camera content near system controls. */
    private void drawScrims(Canvas canvas) {
        if (topScrim == null || bottomScrim == null) {
            return;
        }
        float scrimHeight = Math.max(dp(132.0f), getHeight() * 0.23f);
        scrimPaint.setShader(topScrim);
        canvas.drawRect(0.0f, 0.0f, getWidth(), scrimHeight, scrimPaint);
        scrimPaint.setShader(bottomScrim);
        canvas.drawRect(0.0f, getHeight() - scrimHeight, getWidth(), getHeight(), scrimPaint);
        scrimPaint.setShader(null);
    }

    /** Projects and draws one visible, uncaptured world-space target. */
    private boolean drawProjectedTarget(Canvas canvas, PanoramaTarget target) {
        if (target.captured) {
            return false;
        }
        worldToDevice(target.direction, deviceDirection);
        float depth = -deviceDirection[2];
        if (depth <= 0.12f) {
            return false;
        }

        float clipX =
            projection[0] * deviceDirection[0] +
            projection[4] * deviceDirection[1] +
            projection[8] * deviceDirection[2] +
            projection[12];
        float clipY =
            projection[1] * deviceDirection[0] +
            projection[5] * deviceDirection[1] +
            projection[9] * deviceDirection[2] +
            projection[13];
        float clipW =
            projection[3] * deviceDirection[0] +
            projection[7] * deviceDirection[1] +
            projection[11] * deviceDirection[2] +
            projection[15];
        if (clipW <= 0.0001f) {
            return false;
        }
        float x = (clipX / clipW * 0.5f + 0.5f) * getWidth();
        float y = (0.5f - clipY / clipW * 0.5f) * getHeight();
        float margin = dp(32.0f);
        if (x < margin || x > getWidth() - margin || y < margin || y > getHeight() - margin) {
            return false;
        }

        boolean active = target.index == activeTargetIndex;
        float radius = dp(active ? 8.0f : 5.0f);
        paint.setStyle(Paint.Style.FILL);
        paint.setStrokeWidth(dp(1.0f));
        paint.setColor(Color.WHITE);
        paint.setAlpha(active ? 255 : 178);
        paint.setShadowLayer(dp(active ? 5.0f : 3.0f), 0.0f, dp(1.0f), 0x8A000000);
        canvas.drawCircle(x, y, radius, paint);
        paint.clearShadowLayer();

        if (active) {
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dp(1.5f));
            paint.setAlpha(190);
            canvas.drawCircle(x, y, dp(15.0f), paint);
        }
        paint.setAlpha(255);
        return true;
    }

    /** Pins guidance to the safe edge when the active target is outside the viewport. */
    private void drawActiveEdgeMarker(
        Canvas canvas,
        PanoramaTarget target,
        boolean showCompletionChevron
    ) {
        if (target == null || target.captured) {
            return;
        }

        worldToDevice(target.direction, deviceDirection);
        double horizontal = Math.atan2(deviceDirection[0], -deviceDirection[2]);
        double vertical = Math.atan2(
            deviceDirection[1],
            Math.hypot(deviceDirection[0], deviceDirection[2])
        );
        float directionX = (float) (horizontal / Math.PI);
        float directionY = (float) (-vertical / (Math.PI * 0.5));
        if (Math.abs(directionX) < 0.001f && Math.abs(directionY) < 0.001f) {
            directionX = 1.0f;
        }

        if (showCompletionChevron && aligned) {
            drawCompletionChevron(
                canvas,
                getWidth() * 0.5f,
                getHeight() * 0.5f - dp(58.0f),
                0.0f,
                1.0f
            );
            return;
        }

        // Keep the marker clear of the header and bottom guidance in portrait
        // and landscape, including compact-height displays.
        float horizontalInset = Math.min(
            dp(showCompletionChevron ? 42.0f : 34.0f),
            getWidth() * 0.22f
        );
        float verticalInset = Math.min(
            dp(showCompletionChevron ? 112.0f : 104.0f),
            getHeight() * 0.34f
        );
        float availableX = Math.max(dp(12.0f), getWidth() * 0.5f - horizontalInset);
        float availableY = Math.max(dp(12.0f), getHeight() * 0.5f - verticalInset);
        float scaleX = Math.abs(directionX) < 0.001f ? Float.MAX_VALUE : availableX / Math.abs(directionX);
        float scaleY = Math.abs(directionY) < 0.001f ? Float.MAX_VALUE : availableY / Math.abs(directionY);
        float scale = Math.min(scaleX, scaleY);
        float x = getWidth() * 0.5f + directionX * scale;
        float y = getHeight() * 0.5f + directionY * scale;

        if (showCompletionChevron) {
            drawCompletionChevron(canvas, x, y, directionX, directionY);
            return;
        }

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(Color.WHITE);
        paint.setAlpha(215);
        paint.setShadowLayer(dp(5.0f), 0.0f, dp(1.0f), 0x99000000);
        canvas.drawCircle(x, y, dp(7.0f), paint);
        paint.clearShadowLayer();
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1.5f));
        paint.setAlpha(150);
        canvas.drawCircle(x, y, dp(14.0f), paint);
        paint.setAlpha(255);
    }

    /** Draws the high-contrast final-target arrow in the supplied screen direction. */
    private void drawCompletionChevron(
        Canvas canvas,
        float x,
        float y,
        float directionX,
        float directionY
    ) {
        float radius = dp(22.0f);
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(0xE0000000);
        paint.setAlpha(255);
        paint.setShadowLayer(dp(6.0f), 0.0f, dp(2.0f), 0xA6000000);
        canvas.drawCircle(x, y, radius, paint);
        paint.clearShadowLayer();

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1.0f));
        paint.setColor(Color.WHITE);
        paint.setAlpha(105);
        canvas.drawCircle(x, y, radius, paint);

        float angleDegrees = (float) Math.toDegrees(Math.atan2(directionY, directionX));
        canvas.save();
        canvas.translate(x, y);
        canvas.rotate(angleDegrees);
        chevronPath.reset();
        chevronPath.moveTo(dp(-6.0f), dp(-9.0f));
        chevronPath.lineTo(dp(5.0f), 0.0f);
        chevronPath.lineTo(dp(-6.0f), dp(9.0f));
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(4.0f));
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
        paint.setColor(Color.WHITE);
        paint.setAlpha(255);
        canvas.drawPath(chevronPath, paint);
        canvas.restore();
        paint.setStrokeCap(Paint.Cap.BUTT);
        paint.setStrokeJoin(Paint.Join.MITER);
    }

    /** Draws alignment state and the continuous steady-hold progress ring. */
    private void drawCenterReticle(Canvas canvas) {
        float centerX = getWidth() * 0.5f;
        float centerY = getHeight() * 0.5f;
        float radius = dp(24.0f);

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(aligned ? 2.5f : 1.5f));
        paint.setColor(Color.WHITE);
        paint.setAlpha(capturing ? 255 : (aligned ? 230 : 150));
        paint.setShadowLayer(dp(5.0f), 0.0f, dp(1.0f), 0xA0000000);
        canvas.drawCircle(centerX, centerY, radius, paint);
        paint.clearShadowLayer();

        if (aligned) {
            paint.setStyle(Paint.Style.FILL);
            paint.setAlpha(steady ? 235 : 145);
            canvas.drawCircle(centerX, centerY, dp(3.5f), paint);
        }

        if (holdProgress > 0.0f && !capturing) {
            float progressRadius = dp(31.0f);
            progressBounds.set(
                centerX - progressRadius,
                centerY - progressRadius,
                centerX + progressRadius,
                centerY + progressRadius
            );
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeWidth(dp(3.0f));
            paint.setAlpha(255);
            canvas.drawArc(progressBounds, -90.0f, 360.0f * holdProgress, false, paint);
            paint.setStrokeCap(Paint.Cap.BUTT);
        }
        paint.setAlpha(255);
    }

    /** Fades the accepted-frame flash over a fixed monotonic duration. */
    private void drawCaptureFlash(Canvas canvas) {
        if (flashStartedAtMillis == 0L) {
            return;
        }

        long elapsed = SystemClock.uptimeMillis() - flashStartedAtMillis;
        if (elapsed >= FLASH_DURATION_MILLIS) {
            flashStartedAtMillis = 0L;
            return;
        }

        float fraction = 1.0f - elapsed / (float) FLASH_DURATION_MILLIS;
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(Color.WHITE);
        paint.setAlpha((int) (115.0f * fraction));
        canvas.drawRect(0.0f, 0.0f, getWidth(), getHeight(), paint);
        paint.setAlpha(255);
        postInvalidateOnAnimation();
    }

    /** Rotates one world-space direction into the current device camera frame. */
    private void worldToDevice(float[] world, float[] destination) {
        destination[0] =
            cameraRotation[0] * world[0] +
            cameraRotation[3] * world[1] +
            cameraRotation[6] * world[2];
        destination[1] =
            cameraRotation[1] * world[0] +
            cameraRotation[4] * world[1] +
            cameraRotation[7] * world[2];
        destination[2] =
            cameraRotation[2] * world[0] +
            cameraRotation[5] * world[1] +
            cameraRotation[8] * world[2];
    }

    /** Converts density-independent drawing units to physical pixels. */
    private float dp(float value) {
        return value * density;
    }

    /** Supplies a stable pre-tracking projection until ARCore publishes the real matrix. */
    private static float[] identityProjection() {
        return new float[] {
            2.4f, 0.0f, 0.0f, 0.0f,
            0.0f, 2.4f, 0.0f, 0.0f,
            0.0f, 0.0f, -1.0f, -1.0f,
            0.0f, 0.0f, -0.2f, 0.0f,
        };
    }
}
