package com.simerfamily.kinsphere.widget;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import androidx.core.graphics.PathParser;

/** Same five quiet silhouettes and projected route as Journal's flight mini-map. */
final class BubbleWidgetFlightMapRenderer {
    // Keep parity with src/features/flights/flightMapGeography.ts. Schematic, not coastlines.
    static final float[][] LAND = {
        {8,55,22,41,44,33,103,40,112,57,72,72,52,76,40,98,22,103,13,83},
        {81,123,97,131,106,155,101,173,91,154,79,142},
        {142,41,164,24,193,19,211,28,239,24,263,34,280,52,273,64,248,59,232,71,212,65,197,80,180,73,170,52,148,54},
        {231,106,246,92,270,97,289,121,277,147,259,155,246,136,227,129},
        {299,63,318,49,342,52,352,65,343,75,317,74}
    };
    private static final String PLANE_DATA =
        "M7 1.5 2.4-.3V-4c0-.7-.6-1.7-1.3-1.7S-.2-4.7-.2-4v3.7l-4.7 1.8c-.3.1-.4.4-.4.7l.2.7c.1.3.3.4.6.4l4.4-.7v2.5l-1.4 1c-.2.1-.3.3-.2.5l.1.5c.1.2.3.3.5.3l2.2-.5 2.2.5c.2 0 .4-.1.5-.3l.1-.5c.1-.2 0-.4-.2-.5l-1.4-1V2.6l4.4.7c.3 0 .5-.1.6-.4l.2-.7c0-.3-.2-.6-.5-.7Z";

    private BubbleWidgetFlightMapRenderer() {}

    static Bitmap render(BubbleWidgetFlightMap map, String theme) {
        // One selected card only: 720x360 = ~1 MiB, never one bitmap per deck page.
        Bitmap bitmap = Bitmap.createBitmap(720, 360, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.scale(2, 2);
        int surface = Color.rgb(24,6,17), land = Color.rgb(58,16,43), route = Color.rgb(239,180,61);
        int border = Color.argb(74,255,241,210);
        if ("forest".equals(theme)) {
            surface = Color.rgb(3,37,31); land = Color.rgb(16,80,68); route = Color.rgb(168,137,96);
            border = Color.argb(74,245,238,214);
        } else if ("midnight".equals(theme)) {
            surface = Color.rgb(2,10,36); land = Color.rgb(16,38,87); route = Color.rgb(240,185,79);
            border = Color.argb(74,255,240,211);
        }
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        Path plane = PathParser.createPathFromPathData(PLANE_DATA);
        paint.setColor(surface);
        canvas.drawRoundRect(new RectF(0,0,360,180), 12,12,paint);
        for (float[] ring : LAND) {
            Path shape = new Path();
            shape.moveTo(ring[0], ring[1]);
            for (int i=2; i<ring.length; i+=2) shape.lineTo(ring[i],ring[i+1]);
            shape.close();
            paint.setStyle(Paint.Style.FILL); paint.setColor(Color.argb(122, Color.red(land), Color.green(land), Color.blue(land)));
            canvas.drawPath(shape,paint);
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(0.7f); paint.setColor(border);
            canvas.drawPath(shape,paint);
        }
        boolean cancelled = "cancelled".equals(map.mode);
        int routeInk = cancelled ? Color.argb(105, Color.red(route), Color.green(route), Color.blue(route)) : route;
        for (int shift : new int[]{-360,0,360}) {
            canvas.save(); canvas.translate(shift,0);
            Path path = new Path(); path.moveTo((float)map.start.x,(float)map.start.y);
            path.quadTo((float)map.control.x,(float)map.control.y,(float)map.end.x,(float)map.end.y);
            paint.setStyle(Paint.Style.STROKE); paint.setColor(routeInk); paint.setStrokeWidth(1.25f);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setPathEffect(new DashPathEffect(new float[]{3,3},0)); canvas.drawPath(path,paint);
            paint.setPathEffect(null);
            for (BubbleWidgetFlightMap.Point point : new BubbleWidgetFlightMap.Point[]{map.start,map.end}) {
                paint.setStyle(Paint.Style.FILL); paint.setColor(surface);
                canvas.drawCircle((float)point.x,(float)point.y,3,paint);
                paint.setStyle(Paint.Style.STROKE); paint.setColor(routeInk); paint.setStrokeWidth(1.3f);
                canvas.drawCircle((float)point.x,(float)point.y,3,paint);
            }
            if (map.showsPlane()) {
                canvas.save(); canvas.translate((float)map.marker.x,(float)map.marker.y);
                canvas.rotate((float)map.rotation);
                paint.setStyle(Paint.Style.FILL); paint.setColor(routeInk); canvas.drawPath(plane,paint);
                canvas.restore();
            }
            canvas.restore();
        }
        return bitmap;
    }
}
