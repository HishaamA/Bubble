package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;

import java.util.Arrays;
import java.util.Calendar;
import java.util.TimeZone;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Pure JVM coverage for suspended-app schedule selection and day expiry. */
public final class BubbleWidgetSnapshotTest {

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
    public void appliesTextScheduleWithoutReusingCurrentMediaIdentity() {
        BubbleWidgetSnapshot snapshot = snapshot();

        assertSame(snapshot, snapshot.forDisplay(at(16, 30, 11)));

        BubbleWidgetSnapshot capture = snapshot.forDisplay(at(18, 0, 11));
        assertNotSame(snapshot, capture);
        assertEquals("capture", capture.kind);
        assertEquals("A little moment?", capture.title);

        BubbleWidgetSnapshot empty = snapshot.forDisplay(at(22, 0, 11));
        assertNotSame(snapshot, empty);
        assertEquals("empty", empty.kind);
    }

    @Test
    public void choosesTheNextFutureScheduleBoundaryAfterAnEarlierOnePasses() {
        BubbleWidgetSnapshot snapshot = snapshot();

        assertEquals(at(17, 0, 11), snapshot.nextTransitionAtMillis(at(16, 30, 11)));
        assertEquals(at(21, 0, 11), snapshot.nextTransitionAtMillis(at(18, 0, 11)));
    }

    @Test
    public void expiresTheEntireScheduleAfterLocalMidnight() {
        BubbleWidgetSnapshot snapshot = snapshot();
        BubbleWidgetSnapshot display = snapshot.forDisplay(at(0, 1, 12));

        assertEquals("hidden", display.privacy);
        assertEquals("capture", display.kind);
        assertEquals("A little moment?", display.title);
        assertEquals(0L, snapshot.nextTransitionAtMillis(at(0, 1, 12)));
    }

    private static BubbleWidgetSnapshot snapshot() {
        return new BubbleWidgetSnapshot(
            at(16, 0, 11),
            at(17, 0, 11),
            "memory",
            "plum",
            "FROM YOUR FAMILY",
            "Sunday dinner",
            "Shared by Mum",
            null,
            "/journal/photo/weekly/photo",
            "full",
            Arrays.asList(
                new BubbleWidgetSnapshot.ScheduledCard(
                    at(17, 0, 11),
                    "capture",
                    "plum",
                    "THIS WEEK",
                    "A little moment?",
                    "Add a photo",
                    null,
                    "/capsule?contribute=weekly",
                    "full"
                ),
                new BubbleWidgetSnapshot.ScheduledCard(
                    at(21, 0, 11),
                    "empty",
                    "plum",
                    "BUBBLE",
                    "Nothing pressing today",
                    "Open Bubble",
                    null,
                    "/",
                    "full"
                )
            )
        );
    }

    private static long at(int hour, int minute, int day) {
        Calendar calendar = Calendar.getInstance();
        calendar.clear();
        calendar.set(2026, Calendar.SEPTEMBER, day, hour, minute, 0);
        return calendar.getTimeInMillis();
    }
}
