package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.*;
import org.junit.Test;

/** Ticket styling parses only the stable route label, never guesses airport time zones. */
public final class BubbleWidgetFlightTicketTextTest {
    @Test public void acceptsThreeAndFourCharacterAirportCodes() {
        assertArrayEquals(new String[]{"JFK","DXB"},BubbleWidgetRenderer.flightRouteCodes("JFK → DXB"));
        assertArrayEquals(new String[]{"KJFK","OMDB"},BubbleWidgetRenderer.flightRouteCodes(" KJFK → OMDB "));
        assertArrayEquals(new String[]{"A12","B345"},BubbleWidgetRenderer.flightRouteCodes("A12→B345"));
    }
    @Test public void unknownTitlesUseTheUnmodifiedFallback() {
        assertNull(BubbleWidgetRenderer.flightRouteCodes("Journey home"));
        assertNull(BubbleWidgetRenderer.flightRouteCodes("New York → Dubai"));
        assertNull(BubbleWidgetRenderer.flightRouteCodes(null));
        assertNull(BubbleWidgetRenderer.flightRouteCodes("JFK → DXB → LHR"));
    }
    @Test public void compactLabelsDoNotMisrepresentCachedDataAsLive() {
        assertEquals("Last reported",BubbleWidgetRenderer.compactMapLabel("live"));
        assertEquals("Estimated route",BubbleWidgetRenderer.compactMapLabel("estimated"));
        assertEquals("Scheduled route",BubbleWidgetRenderer.compactMapLabel("scheduled"));
        assertEquals("Cancelled · route only",BubbleWidgetRenderer.compactMapLabel("cancelled"));
        assertEquals("Arrived at destination",BubbleWidgetRenderer.compactMapLabel("arrived"));
    }
}
