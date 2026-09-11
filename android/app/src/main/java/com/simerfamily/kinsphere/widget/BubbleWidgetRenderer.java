package com.simerfamily.kinsphere.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;
import com.simerfamily.kinsphere.MainActivity;
import com.simerfamily.kinsphere.R;

/** Builds compact RemoteViews that preserve Bubble's paper-and-doodle character. */
final class BubbleWidgetRenderer {

    private static final int DEFAULT_WIDTH_DP = 120;
    private static final int DEFAULT_HEIGHT_DP = 120;

    private BubbleWidgetRenderer() {}

    static RemoteViews render(
        Context context,
        int appWidgetId,
        BubbleWidgetSnapshot snapshot,
        Bitmap thumbnail,
        Bundle options
    ) {
        BubbleWidgetSnapshot display = snapshot == null
            ? BubbleWidgetSnapshot.fallback("plum")
            : snapshot.forDisplay(System.currentTimeMillis());
        boolean mayUseImage = display == snapshot && display.mayShowThumbnail() && thumbnail != null;
        boolean mediaLayout = mayUseImage;
        int layout = mediaLayout ? R.layout.bubble_widget_media : R.layout.bubble_widget_text;
        RemoteViews views = new RemoteViews(context.getPackageName(), layout);

        int width = options == null
            ? DEFAULT_WIDTH_DP
            : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, DEFAULT_WIDTH_DP);
        int height = options == null
            ? DEFAULT_HEIGHT_DP
            : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, DEFAULT_HEIGHT_DP);
        boolean compact = width < 140 || height < 150;
        boolean roomy = width >= 180 || height >= 175;

        Palette palette = Palette.forTheme(display.theme);
        views.setInt(R.id.bubble_widget_card, "setBackgroundResource", palette.cardBackground);
        views.setInt(R.id.bubble_widget_tape, "setBackgroundResource", palette.tapeBackground);
        views.setTextColor(R.id.bubble_widget_eyebrow, palette.eyebrow);
        views.setTextColor(R.id.bubble_widget_title, palette.ink);
        views.setTextColor(R.id.bubble_widget_subtitle, palette.muted);
        views.setTextColor(R.id.bubble_widget_doodle, palette.doodle);
        views.setTextColor(R.id.bubble_widget_badge, palette.badgeInk);
        views.setInt(R.id.bubble_widget_badge, "setBackgroundResource", palette.badgeBackground);

        views.setTextViewText(
            R.id.bubble_widget_eyebrow,
            display.eyebrow.toUpperCase(java.util.Locale.US)
        );
        views.setTextViewText(R.id.bubble_widget_title, display.title);
        views.setTextViewText(
            R.id.bubble_widget_subtitle,
            display.subtitle == null ? "" : display.subtitle
        );
        views.setTextViewText(R.id.bubble_widget_doodle, doodleFor(display.kind));
        views.setTextViewText(
            R.id.bubble_widget_badge,
            display.badge == null ? defaultBadge(display.kind) : display.badge
        );

        boolean showSubtitle = display.subtitle != null && (!compact || !mediaLayout);
        boolean showBadge = !compact && (display.badge != null || !mediaLayout);
        views.setViewVisibility(
            R.id.bubble_widget_subtitle,
            showSubtitle && (roomy || !mediaLayout) ? View.VISIBLE : View.GONE
        );
        views.setViewVisibility(R.id.bubble_widget_badge, showBadge ? View.VISIBLE : View.GONE);

        if (mediaLayout) {
            views.setImageViewBitmap(R.id.bubble_widget_thumbnail, thumbnail);
            views.setViewVisibility(
                R.id.bubble_widget_play,
                "unlock".equals(display.kind) ? View.VISIBLE : View.GONE
            );
            views.setInt(R.id.bubble_widget_play, "setBackgroundResource", palette.playBackground);
            views.setTextColor(R.id.bubble_widget_play, palette.playInk);
        }

        Intent open = new Intent(
            Intent.ACTION_VIEW,
            new Uri.Builder()
                .scheme(context.getString(R.string.custom_url_scheme))
                .authority("open")
                .appendQueryParameter("route", display.route)
                .build(),
            context,
            MainActivity.class
        )
            .setPackage(context.getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent click = PendingIntent.getActivity(
            context,
            appWidgetId,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.bubble_widget_root, click);
        String description = display.subtitle == null
            ? display.title
            : display.title + ". " + display.subtitle;
        views.setContentDescription(R.id.bubble_widget_root, description);
        return views;
    }

    private static String doodleFor(String kind) {
        switch (kind) {
            case "urgent":
                return "!  ✦";
            case "unlock":
                return "♡  ▶";
            case "today":
                return "✓  〰";
            case "memory":
                return "✦  ♡";
            case "empty":
                return "·  ◡";
            case "capture":
            default:
                return "✦  +";
        }
    }

    private static String defaultBadge(String kind) {
        switch (kind) {
            case "urgent":
                return "Open task";
            case "unlock":
                return "Play recap";
            case "today":
                return "See today";
            case "memory":
                return "Remember this";
            case "capture":
                return "Open camera";
            case "empty":
            default:
                return "Open Bubble";
        }
    }

    private static final class Palette {
        final int cardBackground;
        final int tapeBackground;
        final int badgeBackground;
        final int playBackground;
        final int ink;
        final int muted;
        final int eyebrow;
        final int doodle;
        final int badgeInk;
        final int playInk;

        private Palette(
            int cardBackground,
            int tapeBackground,
            int badgeBackground,
            int playBackground,
            int ink,
            int muted,
            int eyebrow,
            int doodle,
            int badgeInk,
            int playInk
        ) {
            this.cardBackground = cardBackground;
            this.tapeBackground = tapeBackground;
            this.badgeBackground = badgeBackground;
            this.playBackground = playBackground;
            this.ink = ink;
            this.muted = muted;
            this.eyebrow = eyebrow;
            this.doodle = doodle;
            this.badgeInk = badgeInk;
            this.playInk = playInk;
        }

        static Palette forTheme(String theme) {
            int cream = Color.rgb(255, 241, 210);
            int plum = Color.rgb(53, 17, 39);
            if ("forest".equals(theme)) {
                return new Palette(
                    R.drawable.bubble_widget_card_forest,
                    R.drawable.bubble_widget_tape_forest,
                    R.drawable.bubble_widget_badge_forest,
                    R.drawable.bubble_widget_play_forest,
                    cream,
                    Color.rgb(217, 221, 186),
                    Color.rgb(217, 221, 186),
                    Color.rgb(169, 190, 121),
                    Color.rgb(0, 62, 52),
                    Color.rgb(0, 62, 52)
                );
            }
            if ("midnight".equals(theme)) {
                return new Palette(
                    R.drawable.bubble_widget_card_midnight,
                    R.drawable.bubble_widget_tape_midnight,
                    R.drawable.bubble_widget_badge_midnight,
                    R.drawable.bubble_widget_play_midnight,
                    cream,
                    Color.rgb(188, 199, 226),
                    Color.rgb(255, 219, 137),
                    Color.rgb(246, 188, 61),
                    Color.rgb(5, 24, 72),
                    Color.rgb(5, 24, 72)
                );
            }
            return new Palette(
                R.drawable.bubble_widget_card_plum,
                R.drawable.bubble_widget_tape_plum,
                R.drawable.bubble_widget_badge_plum,
                R.drawable.bubble_widget_play_plum,
                cream,
                Color.rgb(224, 190, 199),
                Color.rgb(243, 188, 207),
                Color.rgb(229, 173, 197),
                plum,
                plum
            );
        }
    }
}
