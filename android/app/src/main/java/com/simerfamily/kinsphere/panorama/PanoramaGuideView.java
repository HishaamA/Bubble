package com.simerfamily.kinsphere.panorama;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
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
    private final float density;
    private List<PanoramaTarget> targets = Collections.emptyList();
    private float[] cameraToWorld = IDENTITY_ROTATION.clone();
    private float[] projection = identityProjection();
    private int activeTargetIndex = -1;
    private float holdProgress;
    private boolean aligned;
    private boolean steady;
    private boolean capturing;
    private long flashStartedAtMillis;
    private LinearGradient topScrim;
    private LinearGradient bottomScrim;

    PanoramaGuideView(Context context) {
        this(context, null);
    }

    PanoramaGuideView(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        density = getResources().getDisplayMetrics().density;
        setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        setContentDescription("Guided panorama capture");
    }

    void setTargets(List<PanoramaTarget> targets) {
        this.targets = targets;
        invalidate();
    }

    void updatePose(
        float[] cameraToWorld,
        float[] projection,
        int activeTargetIndex,
        float holdProgress,
        boolean aligned,
        boolean steady,
        boolean capturing
    ) {
        System.arraycopy(cameraToWorld, 0, this.cameraToWorld, 0, 9);
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

    void pulseCapture() {
        flashStartedAtMillis = SystemClock.uptimeMillis();
        postInvalidateOnAnimation();
    }

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

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        drawScrims(canvas);

        boolean activeWasDrawn = false;
        for (PanoramaTarget target : targets) {
            boolean drawn = drawProjectedTarget(canvas, target);
            if (target.index == activeTargetIndex) {
                activeWasDrawn = drawn;
            }
        }

        if (!activeWasDrawn) {
            drawActiveEdgeMarker(canvas);
        }
        drawCenterReticle(canvas);
        drawCaptureFlash(canvas);
    }

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

    private boolean drawProjectedTarget(Canvas canvas, PanoramaTarget target) {
        if (target.captured) {
            return false;
        }
        float[] device = worldToDevice(target.direction);
        float depth = -device[2];
        if (depth <= 0.12f) {
            return false;
        }

        float clipX =
            projection[0] * device[0] +
            projection[4] * device[1] +
            projection[8] * device[2] +
            projection[12];
        float clipY =
            projection[1] * device[0] +
            projection[5] * device[1] +
            projection[9] * device[2] +
            projection[13];
        float clipW =
            projection[3] * device[0] +
            projection[7] * device[1] +
            projection[11] * device[2] +
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

    private void drawActiveEdgeMarker(Canvas canvas) {
        PanoramaTarget target = findActiveTarget();
        if (target == null || target.captured) {
            return;
        }

        float[] device = worldToDevice(target.direction);
        double horizontal = Math.atan2(device[0], -device[2]);
        double vertical = Math.atan2(device[1], Math.hypot(device[0], device[2]));
        float directionX = (float) (horizontal / Math.PI);
        float directionY = (float) (-vertical / (Math.PI * 0.5));
        if (Math.abs(directionX) < 0.001f && Math.abs(directionY) < 0.001f) {
            directionX = 1.0f;
        }

        float availableX = getWidth() * 0.5f - dp(34.0f);
        float availableY = getHeight() * 0.5f - dp(104.0f);
        float scaleX = Math.abs(directionX) < 0.001f ? Float.MAX_VALUE : availableX / Math.abs(directionX);
        float scaleY = Math.abs(directionY) < 0.001f ? Float.MAX_VALUE : availableY / Math.abs(directionY);
        float scale = Math.min(scaleX, scaleY);
        float x = getWidth() * 0.5f + directionX * scale;
        float y = getHeight() * 0.5f + directionY * scale;

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

    private PanoramaTarget findActiveTarget() {
        for (PanoramaTarget target : targets) {
            if (target.index == activeTargetIndex) {
                return target;
            }
        }
        return null;
    }

    private float[] worldToDevice(float[] world) {
        return new float[] {
            cameraToWorld[0] * world[0] + cameraToWorld[3] * world[1] + cameraToWorld[6] * world[2],
            cameraToWorld[1] * world[0] + cameraToWorld[4] * world[1] + cameraToWorld[7] * world[2],
            cameraToWorld[2] * world[0] + cameraToWorld[5] * world[1] + cameraToWorld[8] * world[2],
        };
    }

    private float dp(float value) {
        return value * density;
    }

    private static float[] identityProjection() {
        return new float[] {
            2.4f, 0.0f, 0.0f, 0.0f,
            0.0f, 2.4f, 0.0f, 0.0f,
            0.0f, 0.0f, -1.0f, -1.0f,
            0.0f, 0.0f, -0.2f, 0.0f,
        };
    }
}
