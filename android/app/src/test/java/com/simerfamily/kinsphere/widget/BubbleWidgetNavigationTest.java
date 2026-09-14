package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;
import java.util.TimeZone;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Absolute slot selection must remain deterministic across every widget repaint. */
public final class BubbleWidgetNavigationTest {
    private TimeZone originalTimeZone;

    @Before
    public void useDubaiTime() {
        originalTimeZone = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Dubai"));
    }

    @After
    public void restoreTimeZone() {
        TimeZone.setDefault(originalTimeZone);
    }

    @Test
    public void emptyAndMissingSelectionsStartAtTheFirstCard() {
        assertEquals(0, select(null, null, 1));
        assertEquals(0, select(Collections.emptyList(), "removed", -1));
        assertEquals(0, select(pages(), null, 0));
        assertEquals(0, select(pages(), "removed", 0));
    }

    @Test
    public void nextMovesAcrossTasksAndPhotosWithoutOpeningAnything() {
        List<BubbleWidgetSnapshot.Page> pages = pages();
        assertEquals(1, select(pages, "task-a", 1));
        assertEquals(2, select(pages, "task-b", 1));
        assertEquals(3, select(pages, "photo-a", 1));
    }

    @Test
    public void nextWrapsFromLastToFirst() {
        assertEquals(0, select(pages(), "photo-b", 1));
    }

    @Test
    public void previousWrapsFromFirstToLast() {
        assertEquals(3, select(pages(), "task-a", -1));
        assertEquals(1, select(pages(), "photo-a", -1));
    }

    @Test
    public void repeatedRepaintsDoNotAdvanceOrResetSelection() {
        List<BubbleWidgetSnapshot.Page> pages = pages();
        String selected = "photo-a";
        for (int repaint = 0; repaint < 20; repaint += 1) {
            int index = select(pages, selected, 0);
            assertEquals(2, index);
            selected = pages.get(index).id;
        }
    }

    @Test
    public void exactStableIdWinsWhenTheDeckIsReorderedOrGrows() {
        List<BubbleWidgetSnapshot.Page> changed = Arrays.asList(
            page("new-task", "tasks"),
            page("photo-a", "photos"),
            page("task-b", "tasks")
        );
        assertEquals(1, select(changed, "photo-a", 0));
        assertEquals(2, select(changed, "photo-a", 1));
    }

    @Test
    public void removedSelectionAndSingleCardDeckAreBounded() {
        List<BubbleWidgetSnapshot.Page> single = Collections.singletonList(page("remaining", "tasks"));
        assertEquals(0, select(single, "removed", 0));
        assertEquals(0, select(single, "remaining", 1));
        assertEquals(0, select(single, "remaining", -1));
    }

    @Test
    public void independentWidgetSelectionsDoNotAffectEachOther() {
        List<BubbleWidgetSnapshot.Page> pages = pages();
        String firstWidget = pages.get(select(pages, "task-a", 1)).id;
        String secondWidget = pages.get(select(pages, "photo-a", -1)).id;
        assertEquals("task-b", firstWidget);
        assertEquals("task-b", secondWidget);
        firstWidget = pages.get(select(pages, firstWidget, 1)).id;
        assertEquals("photo-a", firstWidget);
        assertEquals(1, select(pages, secondWidget, 0));
    }

    @Test
    public void directionIsOnlyOneStepAndCannotOverflow() {
        assertEquals(1, select(pages(), "task-a", Integer.MAX_VALUE));
        assertEquals(3, select(pages(), "task-a", Integer.MIN_VALUE));
    }

    @Test
    public void photoRotationReplacesPayloadButKeepsTheOriginalSlotSelected() {
        BubbleWidgetSnapshot source = snapshot("full", pages());
        List<BubbleWidgetSnapshot.Page> rotated =
            BubbleWidgetPhotoRotation.pagesForDisplay(source, at(17, 0, 13));
        int selected = select(source.pages, "photo-a", 0);
        assertEquals(2, selected);
        assertEquals("photo-b", rotated.get(selected).id);
        assertEquals("photo-a", source.pages.get(selected).id);
        assertEquals(3, select(source.pages, "photo-a", 1));
    }

    @Test
    public void browsingRequiresCurrentAuthorizedMultipleCards() {
        long now = at(16, 45, 13);
        assertTrue(BubbleWidgetNavigation.canBrowse(snapshot("full", pages()), now));
        assertFalse(BubbleWidgetNavigation.canBrowse(null, now));
        assertFalse(BubbleWidgetNavigation.canBrowse(snapshot("hidden", pages()), now));
        assertFalse(BubbleWidgetNavigation.canBrowse(snapshot("full", Collections.emptyList()), now));
        assertFalse(BubbleWidgetNavigation.canBrowse(
            snapshot("full", Collections.singletonList(page("task", "tasks"))), now
        ));
        assertFalse(BubbleWidgetNavigation.canBrowse(snapshot("full", pages()), at(0, 0, 14)));
    }

    @Test
    public void anActiveHiddenScheduleDisablesBrowsingEvenWithRetainedPages() {
        BubbleWidgetSnapshot source = snapshot("full", pages());
        BubbleWidgetSnapshot scheduled = new BubbleWidgetSnapshot(
            source.generatedAtMillis, 0L, source.kind, source.theme, source.eyebrow,
            source.title, null, null, source.route, source.privacy,
            Collections.singletonList(new BubbleWidgetSnapshot.ScheduledCard(
                at(17, 0, 13), "capture", "plum", "BUBBLE", "A little moment?",
                null, null, "/journal", "hidden"
            )), source.pages
        );
        assertTrue(BubbleWidgetNavigation.canBrowse(scheduled, at(16, 59, 13)));
        assertFalse(BubbleWidgetNavigation.canBrowse(scheduled, at(17, 0, 13)));
    }

    private static int select(List<BubbleWidgetSnapshot.Page> pages, String selectedId, int direction) {
        return BubbleWidgetNavigation.resolvePosition(pages, selectedId, direction);
    }

    private static List<BubbleWidgetSnapshot.Page> pages() {
        return Arrays.asList(
            page("task-a", "tasks"), page("task-b", "tasks"),
            page("photo-a", "photos"), page("photo-b", "photos")
        );
    }

    private static BubbleWidgetSnapshot.Page page(String id, String group) {
        return new BubbleWidgetSnapshot.Page(
            id, group, "photos".equals(group) ? "memory" : "today", "plum", "BUBBLE",
            id, null, null, "/journal", "full"
        );
    }

    private static BubbleWidgetSnapshot snapshot(String privacy, List<BubbleWidgetSnapshot.Page> pages) {
        return new BubbleWidgetSnapshot(
            at(16, 30, 13), 0L, "memory", "plum", "BUBBLE", "Family photo",
            null, null, "/journal", privacy, Collections.emptyList(), pages
        );
    }

    private static long at(int hour, int minute, int day) {
        Calendar calendar = Calendar.getInstance();
        calendar.clear();
        calendar.set(2026, Calendar.SEPTEMBER, day, hour, minute, 0);
        return calendar.getTimeInMillis();
    }
}
