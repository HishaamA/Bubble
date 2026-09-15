package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.appwidget.AppWidgetHostView;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterViewAnimator;
import android.widget.ImageView;
import android.widget.RemoteViews;
import android.widget.TextView;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.simerfamily.kinsphere.MainActivity;
import com.simerfamily.kinsphere.R;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.Timeout;
import org.junit.runner.RunWith;

/**
 * Applies complete, absolute RemoteViews updates to a real AppWidgetHostView.
 * The host is never bound to a launcher or registered widget. All snapshots and
 * images are synthetic; no family data is read or changed. Selection persistence
 * uses explicitly isolated temporary preferences, removed in finally. Visual QA
 * writes only synthetic PNGs under cache/widget-layout-qa.
 *
 * These tests do not claim to prove launcher PendingIntent delivery. Real home
 * screen arrow taps must be verified separately on the installed build.
 */
@RunWith(AndroidJUnit4.class)
public final class BubbleWidgetLayoutInstrumentedTest {
    @Rule public final Timeout testTimeout = Timeout.seconds(120);

    private static final int TEST_WIDGET_ID = 900001;
    private static final int[][] HOST_SIZES_DP = {
        {110, 110}, {320, 220}, {160, 360}, {420, 140}
    };
    private static final String[] THEMES = {"plum", "forest", "midnight"};
    private static final int[][] PREVIEW_SIZES_DP = {
        {320, 220}, {320, 300}, {180, 180}
    };
    private static final String[] PREVIEW_KINDS = {
        "task", "capture", "empty", "memory", "unlock", "flight"
    };

    @Test
    public void photoWidgetsFillTheWholeHostAtEverySupportedShape() {
        assertSizes(true, Configuration.ORIENTATION_PORTRAIT);
    }

    @Test
    public void taskWidgetsFillTheWholeHostAtEverySupportedShape() {
        assertSizes(false, Configuration.ORIENTATION_PORTRAIT);
    }

    @Test
    public void flightTicketsKeepFullSizeAndNavigationWithoutAMap() {
        for (int[] size : new int[][] {{110, 110}, {320, 220}, {320, 240}, {160, 360}, {420, 140}, {320, 300}}) {
            Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT);
            try {
                onMain(() -> {
                    fixture.create(size[0], size[1]);
                    long now = fixture.now;
                    fixture.pages[1] = new BubbleWidgetSnapshot.Page("flight-qa", "flights", "flight",
                        "midnight", "EK202 · FAMILY", "JFK → DXB",
                        "ETA 7:30 PM GST · Estimated · Updated 7:05 PM", "En route",
                        "/journal?section=flights", "full", now + 6 * 3_600_000L,
                        new BubbleWidgetSnapshot.Flight(now - 2 * 3_600_000L,
                            now + 6 * 3_600_000L, now - 60_000L), true,
                        new BubbleWidgetFlightMap(new BubbleWidgetFlightMap.Point(106.222,51.115),
                            new BubbleWidgetFlightMap.Point(235.364,65.833), new BubbleWidgetFlightMap.Point(170.793,27.869),
                            new BubbleWidgetFlightMap.Point(138.5075,43.3174), -6.8,
                            "estimated",25.0,true));
                    fixture.snapshot = deck(now, "full", fixture.pages);
                    fixture.render(1);
                });
                settle(fixture);
                onMain(() -> {
                    fixture.assertFillsHost();
                    fixture.assertFooter();
                    assertEquals("JFK → DXB", fixture.text(R.id.bubble_widget_title));
                    if (size[0] >= 150 && size[1] >= 150) {
                        assertEquals("JFK",fixture.text(R.id.bubble_widget_flight_origin));
                        assertEquals("DXB",fixture.text(R.id.bubble_widget_flight_destination));
                    }
                    assertNull(fixture.host.findViewById(R.id.bubble_widget_thumbnail));
                    assertEquals(View.GONE,
                        fixture.view(R.id.bubble_widget_flight_map).getVisibility());
                    assertEquals(View.GONE, fixture.view(R.id.bubble_widget_flight_estimate).getVisibility());
                    assertNull(((ImageView)fixture.view(R.id.bubble_widget_flight_map)).getDrawable());
                    if (size[0] == 320 && size[1] == 300) fixture.savePreview("flight-midnight-320x300.png");
                    if (size[0] == 320 && size[1] == 220) fixture.savePreview("flight-midnight-320x220.png");
                });
            } finally { onMain(fixture::close); }
        }
    }

    @Test
    public void flightTicketsKeepTheDarkPaletteAndExportEveryThemeAtCompactAndTallSizes() {
        for (String theme : new String[]{"plum","forest","midnight"}) {
            for (int height : new int[]{220,240,300}) {
                assertFlightTicket(theme,height,1f,false);
            }
        }
    }

    @Test
    public void flightTicketsHandleLongNamesStatusesAndLargeSystemFonts() {
        for (String theme : new String[]{"plum","forest","midnight"}) {
            for (int height : new int[]{220,300}) assertFlightTicket(theme,height,1.4f,true);
        }
    }

    private static void assertFlightTicket(String theme, int height, float fontScale, boolean longText) {
        Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT,fontScale);
        try {
            onMain(() -> {
                fixture.create(320,height);
                long now = fixture.now;
                fixture.pages[1] = new BubbleWidgetSnapshot.Page("flight-ticket-qa","flights","flight",theme,
                    longText ? "EK202 · Christopher Alexander Richardson" : "EK202 · Mum",
                    "JFK → DXB","ETA 7:30 PM GST · Sep 15 · Updated 7:05 PM",
                    longText ? "Departure delayed · awaiting update" : "En route",
                    "/journal?section=flights","full",0,
                    new BubbleWidgetSnapshot.Flight(now-2*3_600_000L,now+6*3_600_000L,now-60_000L),true,
                    new BubbleWidgetFlightMap(new BubbleWidgetFlightMap.Point(106.222,51.115),
                        new BubbleWidgetFlightMap.Point(235.364,65.833),new BubbleWidgetFlightMap.Point(170.793,27.869),
                        new BubbleWidgetFlightMap.Point(138.5075,43.3174),-6.8,"estimated",25.0,false));
                fixture.snapshot=deck(now,"full",fixture.pages);
                fixture.render(1);
            });
            settle(fixture);
            onMain(() -> {
                fixture.assertFillsHost(); fixture.assertFooter();
                assertEquals("JFK",fixture.text(R.id.bubble_widget_flight_origin));
                assertEquals("DXB",fixture.text(R.id.bubble_widget_flight_destination));
                assertEquals("ETA 7:30 PM GST",fixture.text(R.id.bubble_widget_time));
                assertEquals(View.GONE,fixture.view(R.id.bubble_widget_flight_map).getVisibility());
                assertNull(((ImageView)fixture.view(R.id.bubble_widget_flight_map)).getDrawable());
                assertEquals(View.VISIBLE,fixture.view(R.id.bubble_widget_flight_status).getVisibility());
                assertFalse("Header and status pill must have separate space",Rect.intersects(
                    fixture.bounds(fixture.view(R.id.bubble_widget_eyebrow)),
                    fixture.bounds(fixture.view(R.id.bubble_widget_flight_status))));
                assertTrue("Airport columns must not crowd the central route",
                    fixture.bounds(fixture.view(R.id.bubble_widget_flight_origin)).right
                    < fixture.bounds(fixture.view(R.id.bubble_widget_flight_destination)).left);
                Rect footer=fixture.bounds(fixture.view(R.id.bubble_widget_navigation));
                for (int id : new int[]{R.id.bubble_widget_flight_route,R.id.bubble_widget_time,
                    R.id.bubble_widget_subtitle}) {
                    Rect content=fixture.bounds(fixture.view(id));
                    assertTrue("Flight content must end above the controls: "+id,content.bottom<=footer.top);
                }
                fixture.assertDarkGradient(theme);
                fixture.assertVisibleContentAboveFooter();
                GradientDrawable pill=(GradientDrawable)fixture.view(R.id.bubble_widget_flight_status).getBackground();
                assertTrue("Status pill should remain a soft tint, not cream paper",Color.alpha(pill.getColor().getDefaultColor())<=40);
                fixture.savePreview("flight-ticket-"+theme+"-320x"+height+(longText?"-large-text":"")+".png");
            });
        } finally { onMain(fixture::close); }
    }

    @Test
    public void landscapeWidgetsUseTheLandscapeWidthAndHeightTogether() {
        assertSizes(true, Configuration.ORIENTATION_LANDSCAPE);
        assertSizes(false, Configuration.ORIENTATION_LANDSCAPE);
    }

    @Test
    public void fullUpdatesReplaceTasksPhotosAndCountersWithoutAStack() {
        Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT);
        try {
            onMain(() -> fixture.create(320, 220));
            for (int position : new int[] {0, 1, 2, 0, 2, 1}) {
                onMain(() -> fixture.render(position));
                settle(fixture);
                onMain(() -> {
                    assertEquals(fixture.pages[position].title,
                        fixture.text(R.id.bubble_widget_title));
                    assertEquals((position + 1) + " / 3",
                        fixture.text(R.id.bubble_widget_navigation_position));
                    assertEquals(position == 2,
                        fixture.host.findViewById(R.id.bubble_widget_thumbnail) != null);
                    assertEquals(1, ((ViewGroup) fixture.view(
                        R.id.bubble_widget_page_container)).getChildCount());
                    assertFalse("There must be no perspective stack or relative animation state",
                        containsAnimator(fixture.host));
                    fixture.assertFillsHost();
                    fixture.assertFooter();
                });
            }
        } finally {
            onMain(fixture::close);
        }
    }

    @Test
    public void resizingKeepsTheExplicitlySelectedCard() {
        Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT);
        try {
            onMain(() -> fixture.create(160, 220));
            for (int[] dimensions : HOST_SIZES_DP) {
                onMain(() -> {
                    fixture.resize(dimensions[0], dimensions[1]);
                    fixture.render(2);
                });
                settle(fixture);
                onMain(() -> {
                    assertEquals(fixture.pages[2].title, fixture.text(R.id.bubble_widget_title));
                    assertEquals("3 / 3", fixture.text(R.id.bubble_widget_navigation_position));
                    fixture.assertFillsHost();
                });
            }
        } finally {
            onMain(fixture::close);
        }
    }

    @Test
    public void hiddenAndStaleDecksRejectPreviouslyVisiblePhotos() {
        for (boolean stale : new boolean[] {false, true}) {
            Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT);
            try {
                onMain(() -> {
                    fixture.create(320, 220);
                    fixture.render(2);
                });
                settle(fixture);
                onMain(() -> {
                    assertNotNull(fixture.host.findViewById(R.id.bubble_widget_thumbnail));
                    // Keep every old bitmap in memory: privacy must be enforced
                    // by the production renderer, not by a sanitized test fixture.
                    fixture.snapshot = deck(stale ? fixture.now - 172_800_000L : fixture.now,
                        stale ? "full" : "hidden", fixture.pages);
                    fixture.render(2);
                });
                settle(fixture);
                onMain(() -> {
                    assertNull("Hidden/stale content must not inflate a photo",
                        fixture.host.findViewById(R.id.bubble_widget_thumbnail));
                    assertEquals(View.GONE, fixture.view(R.id.bubble_widget_navigation).getVisibility());
                    assertEquals(View.GONE, fixture.view(R.id.bubble_widget_page_position).getVisibility());
                    fixture.assertFillsHost();
                });
            } finally {
                onMain(fixture::close);
            }
        }
    }

    @Test
    public void singleCardsAndNarrowWidgetsDoNotShowAnUnusableCounter() {
        Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT);
        try {
            onMain(() -> fixture.create(110, 220));
            settle(fixture);
            onMain(() -> {
                assertEquals(View.GONE,
                    fixture.view(R.id.bubble_widget_navigation_position).getVisibility());
                fixture.snapshot = deck(fixture.now, "full", fixture.pages[2]);
                fixture.resize(320, 220);
                fixture.render(20);
            });
            settle(fixture);
            onMain(() -> {
                assertEquals(View.GONE, fixture.view(R.id.bubble_widget_navigation).getVisibility());
                assertEquals(fixture.pages[2].title, fixture.text(R.id.bubble_widget_title));
                assertEquals(View.GONE, fixture.view(R.id.bubble_widget_page_position).getVisibility());
                fixture.assertFillsHost();
            });
        } finally {
            onMain(fixture::close);
        }
    }

    @Test
    public void timePlanAndLocalOpeningRouteMatchTheSelectedTask() {
        Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT);
        try {
            onMain(() -> fixture.create(320, 220));
            for (int position = 0; position < 3; position++) {
                final int selected = position;
                onMain(() -> fixture.render(selected));
                settle(fixture);
                onMain(() -> {
                    BubbleWidgetSnapshot.Page page = fixture.pages[selected];
                    assertEquals(page.title, fixture.text(R.id.bubble_widget_title));
                    assertEquals("Card " + (selected + 1) + " of 3",
                        fixture.view(R.id.bubble_widget_navigation_position)
                            .getContentDescription().toString());
                    if (selected < 2) {
                        assertEquals(selected == 0 ? "4:53 PM" : "5:30 PM",
                            fixture.text(R.id.bubble_widget_time));
                        assertEquals("Road trip", fixture.text(R.id.bubble_widget_subtitle));
                    }
                    // This is the production builder used by the direct card
                    // PendingIntent. Inspect it without sending/opening anything.
                    Intent open = BubbleWidgetRenderer.directOpenIntent(fixture.context, page.route);
                    assertEquals(Intent.ACTION_VIEW, open.getAction());
                    assertNotNull(open.getData());
                    assertEquals(page.route, open.getData().getQueryParameter("route"));
                    assertEquals(fixture.context.getPackageName(), open.getPackage());
                    assertEquals(MainActivity.class.getName(), open.getComponent().getClassName());
                });
            }
            assertEquals("Bring camping gear", fixture.pages[0].title);
            assertEquals("4:53 PM · Road trip", fixture.pages[0].subtitle);
            assertEquals("full", fixture.pages[0].privacy);
        } finally {
            onMain(fixture::close);
        }
    }

    @Test
    public void navigationRequiresCurrentOptedInMultiplePageSnapshot() {
        long now = System.currentTimeMillis();
        BubbleWidgetSnapshot.Page[] pages = {page(0), page(1), page(2)};
        assertFalse(BubbleWidgetNavigation.canBrowse(null, now));
        assertFalse(BubbleWidgetNavigation.canBrowse(deck(now, "hidden", pages), now));
        assertFalse(BubbleWidgetNavigation.canBrowse(deck(now - 172_800_000L, "full", pages), now));
        assertFalse(BubbleWidgetNavigation.canBrowse(deck(now, "full"), now));
        assertFalse(BubbleWidgetNavigation.canBrowse(deck(now, "full", pages[0]), now));
        assertTrue(BubbleWidgetNavigation.canBrowse(deck(now, "full", pages), now));
    }

    @Test
    public void nativePreferencesPersistIndependentSelectionsAndResetAtPrivacyBoundary() {
        Context app = ApplicationProvider.getApplicationContext();
        IsolatedPreferencesContext isolated = new IsolatedPreferencesContext(app);
        long now = System.currentTimeMillis();
        BubbleWidgetSnapshot snapshot = deck(now, "full", page(0), page(1), page(2));
        try {
            assertEquals(0, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, 0));
            assertEquals(1, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, 1));
            assertEquals(2, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, 1));
            assertEquals(0, BubbleWidgetNavigation.selectPosition(isolated, 900102, snapshot, now, 0));
            assertEquals(2, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, 0));
            assertEquals(0, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, 1));
            assertEquals(2, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, -1));
            assertEquals(0, BubbleWidgetNavigation.selectPosition(isolated, 900101,
                deck(now, "hidden", page(0), page(1)), now, 0));
            assertEquals(0, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, 0));
            assertEquals(1, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, 1));
            assertEquals(0, BubbleWidgetNavigation.selectPosition(isolated, 900101,
                deck(now - 172_800_000L, "full", page(0), page(1)), now, 0));
            assertEquals(0, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, 0));
            BubbleWidgetNavigation.clearSelection(isolated, 900101);
            assertEquals(0, BubbleWidgetNavigation.selectPosition(isolated, 900101, snapshot, now, 0));
        } finally {
            isolated.close();
        }
    }

    @Test
    public void savesCompleteSyntheticWidgetsIncludingFooterForVisualReview() {
        Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT);
        try {
            onMain(() -> fixture.create(320, 220));
            settle(fixture);
            onMain(() -> {
                fixture.assertFillsHost();
                fixture.assertFooter();
                fixture.savePreview("task.png");
                fixture.render(2);
            });
            settle(fixture);
            onMain(() -> {
                fixture.assertFillsHost();
                fixture.assertFooter();
                fixture.savePreview("photo.png");
            });
        } finally {
            onMain(fixture::close);
        }
    }

    @Test
    public void savesRepresentativeCardsAtEveryThemeAndSize() {
        for (String theme : THEMES) {
            for (int[] size : PREVIEW_SIZES_DP) {
                for (String kind : PREVIEW_KINDS) {
                    assertRepresentativeCard(theme, kind, size[0], size[1], 1f);
                }
            }
        }
    }

    @Test
    public void representativeCardsKeepVisibleTextInsideContentAtLargeSystemFonts() {
        for (String theme : THEMES) {
            for (String kind : new String[] {"task", "capture", "empty", "memory", "unlock"}) {
                assertRepresentativeCard(theme, kind, 320, 220, 1.4f);
                assertRepresentativeCard(theme, kind, 180, 180, 1.4f);
            }
        }
    }

    @Test
    public void singleCaptureAndPrivateFallbackFitAtLargeSystemFonts() {
        for (String theme : THEMES) {
            for (boolean privateFallback : new boolean[] {false, true}) {
                Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT, 1.4f);
                String variant = privateFallback ? "private-fallback" : "single-capture";
                try {
                    onMain(() -> {
                        fixture.create(180, 180);
                        BubbleWidgetSnapshot.Page capture = representativePage(theme, "capture", fixture.now);
                        fixture.snapshot = privateFallback ? BubbleWidgetSnapshot.fallback(theme)
                            : new BubbleWidgetSnapshot(fixture.now, 0L, capture.kind, theme,
                                capture.eyebrow, capture.title, capture.subtitle, capture.badge,
                                capture.route, "full", Collections.emptyList(), Collections.emptyList());
                        fixture.render(0);
                    });
                    settle(fixture);
                    onMain(() -> {
                        fixture.savePreview(variant + "-" + theme + "-180x180-large-text.png");
                        fixture.assertFillsHost();
                        fixture.assertDarkGradient(theme);
                        fixture.assertVisibleContentAboveFooter();
                        assertEquals(View.GONE, fixture.view(R.id.bubble_widget_navigation).getVisibility());
                        assertEquals(View.GONE, fixture.view(R.id.bubble_widget_badge).getVisibility());
                        assertEquals(View.VISIBLE, fixture.view(R.id.bubble_widget_title).getVisibility());
                        assertEquals(View.VISIBLE, fixture.view(R.id.bubble_widget_subtitle).getVisibility());
                        assertEquals(fixture.snapshot.title, fixture.text(R.id.bubble_widget_title));
                        assertEquals(fixture.snapshot.subtitle, fixture.text(R.id.bubble_widget_subtitle));
                        assertNull("Capture and private fallback must reject the retained fixture bitmap",
                            fixture.host.findViewById(R.id.bubble_widget_thumbnail));
                    });
                } catch (AssertionError error) {
                    throw new AssertionError(variant + " / " + theme + " at 180x180dp, fontScale=1.4", error);
                } finally {
                    onMain(fixture::close);
                }
            }
        }
    }

    @Test
    public void longTaskAndPlanNamesFitAboveNavigationAtCompactHeight() {
        final String title = "Pack the camping gear and supplies for our weekend away";
        final String plan = "Annual family camping weekend in the mountains near the lake";
        for (String theme : THEMES) {
            for (float fontScale : new float[] {1f, 1.4f}) {
                Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT, fontScale);
                try {
                    onMain(() -> {
                        fixture.create(320, 220);
                        fixture.pages[1] = new BubbleWidgetSnapshot.Page("qa-long-task", "tasks", "today",
                            theme, "TODAY'S TASK", title, "4:53 PM · " + plan, null,
                            "/journal?plan=qa-long-trip&task=gear", "full");
                        fixture.snapshot = deck(fixture.now, "full", fixture.pages);
                        fixture.render(1);
                    });
                    settle(fixture);
                    onMain(() -> {
                        fixture.savePreview("long-task-" + theme + "-320x220"
                            + (fontScale > 1f ? "-large-text" : "") + ".png");
                        fixture.assertFillsHost();
                        fixture.assertFooter();
                        fixture.assertDarkGradient(theme);
                        fixture.assertVisibleContentAboveFooter();
                        assertEquals("2 / 3", fixture.text(R.id.bubble_widget_navigation_position));
                        assertEquals(title, fixture.text(R.id.bubble_widget_title));
                        assertEquals("4:53 PM", fixture.text(R.id.bubble_widget_time));
                        assertEquals(plan, fixture.text(R.id.bubble_widget_subtitle));
                        assertEquals(View.VISIBLE, fixture.view(R.id.bubble_widget_title).getVisibility());
                        assertEquals(View.VISIBLE, fixture.view(R.id.bubble_widget_time).getVisibility());
                        if (fontScale == 1f) {
                            assertEquals(View.VISIBLE, fixture.view(R.id.bubble_widget_subtitle).getVisibility());
                            assertTrue("The regression fixture must exercise a multiline title",
                                ((TextView) fixture.view(R.id.bubble_widget_title)).getLayout().getLineCount() > 1);
                        }
                    });
                } catch (AssertionError error) {
                    throw new AssertionError("Long task / " + theme + " at 320x220dp, fontScale=" + fontScale, error);
                } finally {
                    onMain(fixture::close);
                }
            }
        }
    }

    private static void assertRepresentativeCard(
        String theme, String kind, int width, int height, float fontScale
    ) {
        Fixture fixture = new Fixture(Configuration.ORIENTATION_PORTRAIT, fontScale);
        try {
            onMain(() -> {
                fixture.create(width, height);
                if ("empty".equals(kind)) {
                    fixture.snapshot = new BubbleWidgetSnapshot(fixture.now, 0L, "empty", theme,
                        "A LITTLE BREATHING ROOM", "Room for something lovely.",
                        "Your family plans will appear here.", null, "/journal?tab=plans",
                        "full", Collections.emptyList(), Collections.emptyList());
                    fixture.render(0);
                } else {
                    fixture.pages[1] = representativePage(theme, kind, fixture.now);
                    fixture.snapshot = deck(fixture.now, "full", fixture.pages);
                    fixture.render(1);
                }
            });
            settle(fixture);
            onMain(() -> {
                fixture.savePreview("representative-" + kind + "-" + theme + "-" + width + "x" + height
                    + (fontScale > 1f ? "-large-text" : "") + ".png");
                fixture.assertFillsHost();
                fixture.assertFooter();
                fixture.assertDarkGradient(theme);
                fixture.assertVisibleContentAboveFooter();
                assertEquals("empty".equals(kind) ? View.GONE : View.VISIBLE,
                    fixture.view(R.id.bubble_widget_navigation).getVisibility());
                if (!"empty".equals(kind)) {
                    assertEquals("2 / 3", fixture.text(R.id.bubble_widget_navigation_position));
                    assertEquals(fixture.pages[1].title, fixture.text(R.id.bubble_widget_title));
                }
                boolean imageCard = "memory".equals(kind) || "unlock".equals(kind);
                assertEquals("Only memories and unlocked recaps may display the synthetic image",
                    imageCard, fixture.host.findViewById(R.id.bubble_widget_thumbnail) != null);
                if (imageCard) {
                    assertNotNull(((ImageView) fixture.view(R.id.bubble_widget_thumbnail)).getDrawable());
                    assertEquals("unlock".equals(kind) ? View.VISIBLE : View.GONE,
                        fixture.view(R.id.bubble_widget_play).getVisibility());
                }
                if ("flight".equals(kind)) {
                    assertEquals("JFK", fixture.text(R.id.bubble_widget_flight_origin));
                    assertEquals("DXB", fixture.text(R.id.bubble_widget_flight_destination));
                    assertEquals(View.GONE, fixture.view(R.id.bubble_widget_flight_map).getVisibility());
                    assertEquals(View.GONE, fixture.view(R.id.bubble_widget_flight_estimate).getVisibility());
                    assertNull(((ImageView) fixture.view(R.id.bubble_widget_flight_map)).getDrawable());
                }
            });
        } catch (AssertionError error) {
            throw new AssertionError("Synthetic " + kind + " / " + theme + " at " + width + "x" + height
                + "dp, fontScale=" + fontScale, error);
        } finally {
            onMain(fixture::close);
        }
    }

    private static BubbleWidgetSnapshot.Page representativePage(String theme, String kind, long now) {
        switch (kind) {
            case "task":
                return new BubbleWidgetSnapshot.Page("qa-editorial-task", "tasks", "today", theme,
                    "TODAY'S TASK", "Bring camping gear", "4:53 PM · Road trip", null,
                    "/journal?plan=qa-trip&task=gear", "full");
            case "capture":
                return new BubbleWidgetSnapshot.Page("qa-editorial-capture", "capture", "capture", theme,
                    "THIS WEEK", "A little moment?", "Save a glimpse of today for your family.",
                    "Open camera", "/journal?section=capsule", "full");
            case "memory":
                return new BubbleWidgetSnapshot.Page("qa-editorial-memory", "photos", "memory", theme,
                    "FROM YOUR JOURNAL", "Our quiet corner", "A weekend to remember", null,
                    "/journal?photo=qa-cottage", "full");
            case "unlock":
                return new BubbleWidgetSnapshot.Page("qa-editorial-unlock", "recap", "unlock", theme,
                    "YOUR FAMILY CAPSULE", "Last week, together", "Your little moments are ready.",
                    "Watch recap", "/journal?section=capsule", "full");
            case "flight":
                return new BubbleWidgetSnapshot.Page("qa-editorial-flight", "flights", "flight", theme,
                    "EK202 · Mum", "JFK → DXB", "ETA 7:30 PM GST · Sep 15 · Updated 7:05 PM",
                    "En route", "/journal?section=flights", "full", 0L,
                    new BubbleWidgetSnapshot.Flight(now - 2 * 3_600_000L,
                        now + 6 * 3_600_000L, now - 60_000L), true,
                    new BubbleWidgetFlightMap(new BubbleWidgetFlightMap.Point(106.222, 51.115),
                        new BubbleWidgetFlightMap.Point(235.364, 65.833),
                        new BubbleWidgetFlightMap.Point(170.793, 27.869),
                        new BubbleWidgetFlightMap.Point(138.5075, 43.3174),
                        -6.8, "estimated", 25.0, false));
            default:
                throw new AssertionError("Unknown synthetic card kind: " + kind);
        }
    }

    /** A fully synthetic landscape, with a warm cottage window as the focal point. */
    private static Bitmap syntheticPhoto() {
        Bitmap bitmap = Bitmap.createBitmap(640, 400, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new LinearGradient(0, 0, 0, 400,
            new int[] {Color.rgb(173, 197, 202), Color.rgb(231, 210, 167), Color.rgb(94, 124, 102)},
            null, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, 640, 400, paint);
        paint.setShader(null);
        paint.setColor(Color.rgb(249, 227, 171));
        canvas.drawCircle(458, 85, 35, paint);

        Path farHills = new Path();
        farHills.moveTo(0, 231);
        farHills.cubicTo(106, 121, 160, 147, 271, 211);
        farHills.cubicTo(404, 107, 482, 150, 640, 220);
        farHills.lineTo(640, 400);
        farHills.lineTo(0, 400);
        farHills.close();
        paint.setColor(Color.rgb(104, 136, 124));
        canvas.drawPath(farHills, paint);

        Path nearHills = new Path();
        nearHills.moveTo(0, 284);
        nearHills.cubicTo(122, 224, 255, 259, 384, 295);
        nearHills.cubicTo(466, 317, 557, 211, 640, 251);
        nearHills.lineTo(640, 400);
        nearHills.lineTo(0, 400);
        nearHills.close();
        paint.setColor(Color.rgb(62, 101, 85));
        canvas.drawPath(nearHills, paint);

        paint.setColor(Color.rgb(220, 195, 148));
        canvas.drawRoundRect(215, 211, 371, 317, 3, 3, paint);
        Path roof = new Path();
        roof.moveTo(199, 219);
        roof.lineTo(292, 150);
        roof.lineTo(386, 219);
        roof.close();
        paint.setColor(Color.rgb(109, 68, 54));
        canvas.drawPath(roof, paint);
        paint.setColor(Color.rgb(235, 215, 177));
        canvas.drawRect(327, 158, 343, 188, paint);
        paint.setColor(Color.rgb(71, 88, 79));
        canvas.drawRoundRect(278, 250, 310, 317, 3, 3, paint);
        paint.setColor(Color.rgb(248, 213, 131));
        canvas.drawRoundRect(231, 239, 262, 272, 2, 2, paint);
        canvas.drawRoundRect(326, 239, 357, 272, 2, 2, paint);
        paint.setColor(Color.rgb(103, 88, 65));
        paint.setStrokeWidth(3);
        for (int left : new int[] {231, 326}) {
            canvas.drawLine(left + 15, 239, left + 15, 272, paint);
            canvas.drawLine(left, 255, left + 31, 255, paint);
        }

        Path path = new Path();
        path.moveTo(282, 317);
        path.cubicTo(289, 344, 366, 356, 388, 400);
        path.lineTo(449, 400);
        path.cubicTo(402, 352, 310, 337, 308, 317);
        path.close();
        paint.setColor(Color.rgb(185, 168, 126));
        canvas.drawPath(path, paint);
        paint.setColor(Color.rgb(49, 74, 61));
        canvas.drawRoundRect(489, 219, 501, 338, 4, 4, paint);
        paint.setColor(Color.rgb(44, 86, 67));
        canvas.drawOval(443, 160, 549, 270, paint);
        canvas.drawOval(473, 128, 546, 233, paint);
        paint.setColor(Color.rgb(79, 119, 81));
        canvas.drawOval(432, 311, 506, 352, paint);
        canvas.drawOval(146, 301, 227, 344, paint);
        paint.setColor(Color.argb(110, 211, 202, 144));
        paint.setStrokeWidth(2);
        for (int x = 28; x < 625; x += 37) {
            int y = 351 + (x % 5) * 7;
            canvas.drawLine(x, y, x + 3, y - 10, paint);
        }
        return bitmap;
    }

    private static void assertSizes(boolean photo, int orientation) {
        for (int[] dimensions : HOST_SIZES_DP) {
            Fixture fixture = new Fixture(orientation);
            try {
                onMain(() -> {
                    fixture.create(dimensions[0], dimensions[1]);
                    fixture.render(photo ? 2 : 0);
                });
                settle(fixture);
                onMain(() -> {
                    fixture.assertFillsHost();
                    fixture.assertFooter();
                });
            } finally {
                onMain(fixture::close);
            }
        }
    }

    private static boolean containsAnimator(View view) {
        if (view instanceof AdapterViewAnimator) return true;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                if (containsAnimator(group.getChildAt(i))) return true;
            }
        }
        return false;
    }

    private static BubbleWidgetSnapshot deck(
        long generatedAt, String privacy, BubbleWidgetSnapshot.Page... pages
    ) {
        return new BubbleWidgetSnapshot(generatedAt, 0L, "today", "midnight",
            "OUR FAMILY", "Family plans", "4:53 PM · Road trip", null,
            "/journal?tab=plans", privacy, Collections.emptyList(), Arrays.asList(pages));
    }

    private static BubbleWidgetSnapshot.Page page(int position) {
        boolean photo = position == 2;
        return new BubbleWidgetSnapshot.Page("qa-page-" + position,
            photo ? "photos" : "tasks", photo ? "memory" : "today", "midnight",
            photo ? "FROM YOUR JOURNAL" : "TODAY'S TASK",
            photo ? "A day by the sea" : position == 0 ? "Bring camping gear" : "Bring wood",
            photo ? "A family memory"
                : (position == 0 ? "4:53 PM" : "5:30 PM") + " · Road trip",
            null, photo ? "/journal?photo=qa-sea" : "/journal?plan=qa-trip&task=" + position,
            "full");
    }

    private static void settle(Fixture fixture) {
        // The detached host has no async executor: RemoteViews apply synchronously.
        // Measure it directly instead of waiting for unrelated app work to become idle.
        onMain(fixture::layout);
    }

    private static void onMain(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
            return;
        }
        FutureTask<Void> task = new FutureTask<>(() -> {
            action.run();
            return null;
        });
        assertTrue("The main looper must accept the detached widget action",
            new Handler(Looper.getMainLooper()).post(task));
        try {
            task.get(10, TimeUnit.SECONDS);
        } catch (TimeoutException error) {
            task.cancel(false);
            throw new AssertionError("Detached widget action exceeded 10 seconds on the main looper", error);
        } catch (InterruptedException error) {
            task.cancel(false);
            Thread.currentThread().interrupt();
            throw new AssertionError("Interrupted while applying the detached widget", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Error) throw (Error) cause;
            if (cause instanceof RuntimeException) throw (RuntimeException) cause;
            throw new AssertionError("Detached widget action failed", cause);
        }
    }

    private static final class Fixture {
        final Context context;
        final int orientation;
        final float density;
        final long now = System.currentTimeMillis();
        final BubbleWidgetSnapshot.Page[] pages = {page(0), page(1), page(2)};
        Bitmap thumbnail;
        AppWidgetHostView host;
        BubbleWidgetSnapshot snapshot;
        Bundle options;
        int widthDp;
        int heightDp;
        int selected;

        Fixture(int orientation) {
            this(orientation,1f);
        }

        Fixture(int orientation,float fontScale) {
            Context app = ApplicationProvider.getApplicationContext();
            Configuration config = new Configuration(app.getResources().getConfiguration());
            config.orientation = orientation;
            config.fontScale=fontScale;
            this.context = app.createConfigurationContext(config);
            this.orientation = orientation;
            this.density = context.getResources().getDisplayMetrics().density;
        }

        void create(int width, int height) {
            widthDp = width;
            heightDp = height;
            options = optionsFor(width, height);
            thumbnail = syntheticPhoto();
            snapshot = deck(now, "full", pages);
            host = new AppWidgetHostView(context);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) host.setExecutor(null);
            host.setPadding(0, 0, 0, 0);
            render(0);
        }

        void render(int position) {
            selected = position;
            Map<String, Bitmap> images = new LinkedHashMap<>();
            // Deliberately include an image for non-photo cards too. Only
            // authorized photo/recap kinds may ever display these bitmaps.
            for (BubbleWidgetSnapshot.Page page : pages) images.put(page.id, thumbnail);
            BubbleWidgetStore.Entry entry = new BubbleWidgetStore.Entry(snapshot, thumbnail, images);
            RemoteViews complete = BubbleWidgetRenderer.renderSelected(
                context, TEST_WIDGET_ID, entry, options, position, now);
            host.updateAppWidget(complete);
            layout();
        }

        void resize(int width, int height) {
            widthDp = width;
            heightDp = height;
            options = optionsFor(width, height);
            render(selected);
        }

        Bundle optionsFor(int width, int height) {
            Bundle values = new Bundle();
            if (orientation == Configuration.ORIENTATION_LANDSCAPE) {
                values.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, Math.max(70, width / 2));
                values.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width);
                values.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height);
                values.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, height + 180);
            } else {
                values.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width);
                values.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width + 180);
                values.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, Math.max(60, height / 2));
                values.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, height);
            }
            return values;
        }

        void layout() {
            int width = px(widthDp);
            int height = px(heightDp);
            host.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
            host.layout(0, 0, width, height);
        }

        View view(int id) {
            View view = host.findViewById(id);
            assertNotNull("The complete widget must contain view " + id, view);
            return view;
        }

        String text(int id) {
            return ((TextView) view(id)).getText().toString();
        }

        Rect bounds(View view) {
            Rect result = new Rect(0, 0, view.getWidth(), view.getHeight());
            host.offsetDescendantRectToMyCoords(view, result);
            return result;
        }

        void assertFillsHost() {
            String shape = widthDp + "x" + heightDp + "dp";
            for (int id : new int[] {R.id.bubble_widget_shell, R.id.bubble_widget_page_container,
                    R.id.bubble_widget_root, R.id.bubble_widget_card}) {
                View surface = view(id);
                assertEquals(shape + ": full width, view=" + id, px(widthDp), surface.getWidth());
                assertEquals(shape + ": full height, view=" + id, px(heightDp), surface.getHeight());
                assertEquals(shape + ": no perspective offset, view=" + id,
                    new Rect(0, 0, px(widthDp), px(heightDp)), bounds(surface));
            }
            View thumbnailView = host.findViewById(R.id.bubble_widget_thumbnail);
            View content = view(thumbnailView == null
                ? R.id.bubble_widget_text_content : R.id.bubble_widget_media_scrim);
            assertEquals(px(widthDp), content.getWidth());
            assertEquals(px(heightDp), content.getHeight());
            assertTrue("Card text must remain inset", content.getPaddingLeft() >= px(8));
            assertTrue("Card text must remain inset", content.getPaddingTop() >= px(8));
            View header = view(R.id.bubble_widget_eyebrow);
            if (header.getVisibility() == View.VISIBLE && header.getHeight() > 0) {
                assertTrue("Header must not clip through its top padding",
                    bounds(header).top >= content.getPaddingTop());
                assertTrue("Header must not clip through its left padding",
                    bounds(header).left >= content.getPaddingLeft());
            }
            assertEquals("Counter must belong to the footer only", View.GONE,
                view(R.id.bubble_widget_page_position).getVisibility());
            if (thumbnailView != null) {
                View frame = view(R.id.bubble_widget_photo_frame);
                View caption = view(R.id.bubble_widget_photo_caption);
                assertTrue("The inset photo must have visible height", frame.getHeight() > px(2));
                assertTrue("The inset photo must have side margins", frame.getWidth() < px(widthDp));
                int contentWidth = frame.getWidth() - frame.getPaddingLeft() - frame.getPaddingRight();
                int contentHeight = frame.getHeight() - frame.getPaddingTop() - frame.getPaddingBottom();
                assertEquals(contentWidth, thumbnailView.getWidth());
                assertEquals(contentHeight, thumbnailView.getHeight());
                assertEquals(contentWidth, caption.getWidth());
                assertEquals(contentHeight, caption.getHeight());
                if (view(R.id.bubble_widget_navigation).getVisibility() == View.VISIBLE) {
                    assertTrue("Photo must end above the separate footer",
                        bounds(frame).bottom <= bounds(view(R.id.bubble_widget_navigation)).top);
                }
            }
        }

        void assertFooter() {
            View footer = view(R.id.bubble_widget_navigation);
            if (footer.getVisibility() != View.VISIBLE) return;
            View previous = view(R.id.bubble_widget_previous);
            View next = view(R.id.bubble_widget_next);
            assertTrue("Chevron should be a vector image, not a font glyph", previous instanceof ImageView);
            assertTrue("Chevron should be a vector image, not a font glyph", next instanceof ImageView);
            assertNotNull(((ImageView) previous).getDrawable());
            assertNotNull(((ImageView) next).getDrawable());
            assertTrue(previous.isClickable());
            assertTrue(next.isClickable());
            Rect previousBounds = bounds(previous);
            Rect nextBounds = bounds(next);
            assertFalse("Touch targets must not overlap", Rect.intersects(previousBounds, nextBounds));
            if (widthDp >= 150) {
                for (View button : new View[] {previous, next}) {
                    assertTrue("Buttons need at least 48dp touch width", button.getWidth() >= px(48));
                    assertTrue("Buttons need at least 48dp touch height", button.getHeight() >= px(48));
                    Rect buttonBounds = bounds(button);
                    assertTrue("Button must be inset from the left edge", buttonBounds.left >= px(8));
                    assertTrue("Button must be inset from the right edge", buttonBounds.right <= px(widthDp - 8));
                    assertTrue("Button must be inset from the bottom edge", buttonBounds.bottom <= px(heightDp - 8));
                }
                Rect counter = bounds(view(R.id.bubble_widget_navigation_position));
                assertFalse(Rect.intersects(counter, previousBounds));
                assertFalse(Rect.intersects(counter, nextBounds));
            }
            View title = view(R.id.bubble_widget_title);
            assertTrue("Title must never overlap navigation",
                bounds(title).bottom <= bounds(footer).top);
        }

        void assertDarkGradient(String theme) {
            GradientDrawable background = (GradientDrawable) view(R.id.bubble_widget_card).getBackground();
            int[] colors = background.getColors();
            assertNotNull("The card should use a gradient background", colors);
            assertTrue("The gradient needs at least two color stops", colors.length >= 2);
            int expected = "forest".equals(theme) ? Color.rgb(11, 61, 51)
                : "midnight".equals(theme) ? Color.rgb(8, 22, 53) : Color.rgb(45, 10, 33);
            boolean containsBase = false;
            boolean containsDifferentTone = false;
            for (int color : colors) {
                containsBase |= color == expected;
                containsDifferentTone |= color != colors[0];
            }
            assertTrue("The gradient must preserve the existing dark " + theme + " base", containsBase);
            assertTrue("The gradient should include distinct tones", containsDifferentTone);
        }

        void assertVisibleContentAboveFooter() {
            View footer = view(R.id.bubble_widget_navigation);
            Rect cardBounds = bounds(view(R.id.bubble_widget_card));
            int contentBottom = footer.getVisibility() == View.VISIBLE
                ? bounds(footer).top : cardBounds.bottom;
            for (int id : new int[] {R.id.bubble_widget_eyebrow, R.id.bubble_widget_title,
                R.id.bubble_widget_time, R.id.bubble_widget_subtitle, R.id.bubble_widget_badge,
                R.id.bubble_widget_flight_route, R.id.bubble_widget_flight_origin,
                R.id.bubble_widget_flight_destination, R.id.bubble_widget_flight_status}) {
                View content = host.findViewById(id);
                if (content == null || !hasVisibleAncestors(content)) continue;
                String label = widthDp + "x" + heightDp + "dp, view=" + id;
                Rect contentBounds = bounds(content);
                assertTrue(label + ": visible content must have width", content.getWidth() > 0);
                assertTrue(label + ": visible content must have height", content.getHeight() > 0);
                assertTrue(label + ": visible content must stay inside the card",
                    cardBounds.contains(contentBounds));
                assertTrue(label + ": visible content must stay above navigation",
                    contentBounds.bottom <= contentBottom);
                if (content instanceof TextView) {
                    TextView text = (TextView) content;
                    assertNotNull(label + ": visible text must have a layout", text.getLayout());
                    assertTrue(label + ": text lines must not be vertically clipped",
                        text.getLayout().getHeight() <= text.getHeight()
                            - text.getCompoundPaddingTop() - text.getCompoundPaddingBottom());
                    View parent = (View) text.getParent();
                    assertTrue(label + ": text must fit vertically within its parent",
                        contentBounds.top >= bounds(parent).top + parent.getPaddingTop()
                            && contentBounds.bottom <= bounds(parent).bottom - parent.getPaddingBottom());
                }
            }
        }

        boolean hasVisibleAncestors(View view) {
            View current = view;
            while (true) {
                if (current.getVisibility() != View.VISIBLE) return false;
                if (!(current.getParent() instanceof View)) return true;
                current = (View) current.getParent();
            }
        }

        void savePreview(String filename) {
            Bitmap preview = Bitmap.createBitmap(host.getWidth(), host.getHeight(), Bitmap.Config.ARGB_8888);
            try {
                host.draw(new Canvas(preview));
                File directory = new File(context.getCacheDir(), "widget-layout-qa");
                assertTrue(directory.isDirectory() || directory.mkdirs());
                try (FileOutputStream output = new FileOutputStream(new File(directory, filename))) {
                    assertTrue(preview.compress(Bitmap.CompressFormat.PNG, 100, output));
                }
            } catch (IOException error) {
                throw new AssertionError("Could not save synthetic widget preview", error);
            } finally {
                preview.recycle();
            }
        }

        int px(int dp) { return Math.round(dp * density); }

        void close() {
            if (host != null) host.removeAllViews();
            if (thumbnail != null && !thumbnail.isRecycled()) thumbnail.recycle();
        }
    }

    private static final class IsolatedPreferencesContext extends ContextWrapper {
        private final String prefix = "widget_layout_qa_" + UUID.randomUUID() + "_";
        private final Set<String> names = new LinkedHashSet<>();

        IsolatedPreferencesContext(Context base) { super(base); }
        @Override public Context getApplicationContext() { return this; }

        @Override
        public SharedPreferences getSharedPreferences(String name, int mode) {
            String isolatedName = prefix + name;
            names.add(isolatedName);
            return getBaseContext().getSharedPreferences(isolatedName, mode);
        }

        void close() {
            for (String name : names) {
                assertTrue("Remove only the temporary QA preferences",
                    getBaseContext().deleteSharedPreferences(name));
            }
        }
    }
}
