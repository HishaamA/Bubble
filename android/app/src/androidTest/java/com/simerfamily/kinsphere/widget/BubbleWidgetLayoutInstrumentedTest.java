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
import android.graphics.Rect;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterViewAnimator;
import android.widget.ImageView;
import android.widget.RemoteViews;
import android.widget.TextView;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
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
import org.junit.Test;
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
    private static final int TEST_WIDGET_ID = 900001;
    private static final int[][] HOST_SIZES_DP = {
        {110, 110}, {320, 220}, {160, 360}, {420, 140}
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
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        onMain(fixture::layout);
    }

    private static void onMain(Runnable action) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(action);
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
            Context app = ApplicationProvider.getApplicationContext();
            Configuration config = new Configuration(app.getResources().getConfiguration());
            config.orientation = orientation;
            this.context = app.createConfigurationContext(config);
            this.orientation = orientation;
            this.density = context.getResources().getDisplayMetrics().density;
        }

        void create(int width, int height) {
            widthDp = width;
            heightDp = height;
            options = optionsFor(width, height);
            thumbnail = Bitmap.createBitmap(96, 64, Bitmap.Config.ARGB_8888);
            for (int y = 0; y < thumbnail.getHeight(); y++) {
                for (int x = 0; x < thumbnail.getWidth(); x++) {
                    boolean tile = ((x / 16) + (y / 16)) % 2 == 0;
                    thumbnail.setPixel(x, y, Color.rgb(40 + x,
                        85 + y + (tile ? 25 : 0), 150 + y));
                }
            }
            snapshot = deck(now, "full", pages);
            host = new AppWidgetHostView(context);
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
