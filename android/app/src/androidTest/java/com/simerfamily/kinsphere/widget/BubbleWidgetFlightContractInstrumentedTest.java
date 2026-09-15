package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Android JSON parsing; entirely synthetic, without persisted app data. */
@RunWith(AndroidJUnit4.class)
public final class BubbleWidgetFlightContractInstrumentedTest {
    @Test public void additiveV1FieldsRoundTripForCardPageAndSchedule() throws Exception {
        JSONObject json = snapshot();
        JSONObject page = new JSONObject(json.toString());
        page.remove("version"); page.remove("generatedAt");
        page.put("id", "flight-a").put("group", "flights");
        json.put("pages", new JSONArray().put(page));
        JSONObject scheduled = new JSONObject(page.toString());
        scheduled.remove("id"); scheduled.remove("group");
        scheduled.put("effectiveAt", "2026-09-14T09:00:00.000Z");
        json.put("schedule", new JSONArray().put(scheduled));
        BubbleWidgetSnapshot parsed = BubbleWidgetSnapshot.parse(json.toString());
        BubbleWidgetSnapshot restored = BubbleWidgetSnapshot.parse(parsed.toStorageJson());
        assertEquals("flight", restored.kind);
        assertEquals("flights", restored.pages.get(0).group);
        assertEquals(parsed.flight.arrivalAtMillis, restored.flight.arrivalAtMillis);
        assertEquals(parsed.expiresAtMillis, restored.pages.get(0).expiresAtMillis);
        assertNotNull(restored.schedule.get(0).flight);
        assertEquals("/journal?section=flights", restored.pages.get(0).route);
    }

    @Test public void hiddenCardsStripAllFlightMetadataEvenWhenMalformed() throws Exception {
        JSONObject json = snapshot().put("privacy", "hidden");
        json.put("flight", "not a flight").put("expiresAt", "not a date");
        BubbleWidgetSnapshot parsed = BubbleWidgetSnapshot.parse(json.toString());
        assertNull(parsed.flight);
        assertEquals(0L, parsed.expiresAtMillis);
        assertFalse(parsed.toStorageJson().contains("expiresAt"));
        assertFalse(new JSONObject(parsed.toStorageJson()).has("flight"));
    }

    @Test public void rejectsUnboundedExpiryAndMalformedFlightDates() throws Exception {
        reject(snapshot().put("expiresAt", "2026-09-17T08:00:00.000Z"));
        reject(snapshot().put("expiresAt", "2026-09-14T07:59:00.000Z"));
        JSONObject reversed = snapshot();
        reversed.getJSONObject("flight").put("arrivalAt", "2026-09-14T08:00:00.000Z");
        reject(reversed);
        JSONObject missing = snapshot();
        missing.getJSONObject("flight").remove("updatedAt");
        reject(missing);
        JSONObject extra = snapshot();
        extra.getJSONObject("flight").put("apiKey", "not-allowed");
        reject(extra);
        reject(snapshot().put("kind", "memory"));
    }

    @Test public void hiddenDeckCannotExposeFlightPages() throws Exception {
        JSONObject json = snapshot();
        JSONObject page = new JSONObject(json.toString());
        page.remove("version"); page.remove("generatedAt");
        page.put("id", "flight-a").put("group", "flights");
        reject(json.put("privacy", "hidden").put("pages", new JSONArray().put(page)));
    }

    @Test public void retainedMapRoundTripsAndDoesNotNeedTimetable() throws Exception {
        JSONObject json = snapshot();
        json.remove("expiresAt"); json.remove("flight");
        json.put("retainedFlight",true).put("flightMap", map("cancelled"));
        BubbleWidgetSnapshot parsed = BubbleWidgetSnapshot.parse(json.toString());
        BubbleWidgetSnapshot restored = BubbleWidgetSnapshot.parse(parsed.toStorageJson());
        assertTrue(restored.retainedFlight);
        assertNull(restored.flight);
        assertEquals("cancelled",restored.flightMap.mode);
        assertEquals("flight", restored.forDisplay(parsed.generatedAtMillis + 90L*24*3_600_000).kind);
        assertFalse(restored.flightMap.showsPlane());
    }

    @Test public void hiddenSnapshotStripsRetainedMapFieldsRatherThanPersistingThem() throws Exception {
        JSONObject json = snapshot().put("privacy","hidden").put("retainedFlight",true)
            .put("flightMap", map("live"));
        BubbleWidgetSnapshot parsed = BubbleWidgetSnapshot.parse(json.toString());
        assertFalse(parsed.retainedFlight);
        assertNull(parsed.flightMap);
        JSONObject stored = new JSONObject(parsed.toStorageJson());
        assertFalse(stored.has("retainedFlight")); assertFalse(stored.has("flightMap"));
    }

    @Test public void validatesRetainedScopeFiniteMapsAndProgressMode() throws Exception {
        reject(snapshot().put("retainedFlight",false));
        reject(snapshot().put("kind","memory").put("retainedFlight",true));
        JSONObject outOfBounds = map("scheduled");
        outOfBounds.getJSONObject("marker").put("x",721);
        reject(snapshot().put("flightMap",outOfBounds));
        reject(snapshot().put("flightMap",map("secret-provider-mode")));
        reject(snapshot().put("flightMap",map("live").put("progress",101)));
        reject(snapshot().put("flightMap",map("live").put("apiKey","forbidden")));
        reject(snapshot().put("flightMap",map("live").put("advanceWithTime","true")));
    }

    @Test public void acceptsOneHundredFlightsPlusTwelveOtherCardsButNoMore() throws Exception {
        JSONObject json = snapshot();
        JSONArray pages = new JSONArray();
        for (int index=0; index<112; index++) {
            JSONObject page = new JSONObject(json.toString());
            page.remove("version"); page.remove("generatedAt"); page.remove("expiresAt");
            page.remove("flight");
            page.put("id","page-"+index).put("subtitle",repeat('x',320)).put("title",repeat('t',260));
            if (index<100) page.put("group","flights").put("retainedFlight",true).put("flightMap",map("scheduled"));
            else page.put("group","tasks").put("kind","today");
            pages.put(page);
        }
        json.put("pages",pages);
        assertTrue(json.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>64*1024);
        assertEquals(112,BubbleWidgetSnapshot.parse(json.toString()).pages.size());
        pages.put(new JSONObject(pages.getJSONObject(0).toString()).put("id","overflow"));
        reject(json);
    }

    private static JSONObject map(String mode) throws Exception {
        return new JSONObject().put("start",new JSONObject().put("x",106.222).put("y",51.115))
            .put("end",new JSONObject().put("x",235.364).put("y",65.833))
            .put("control",new JSONObject().put("x",170.793).put("y",27.869))
            .put("marker",new JSONObject().put("x",138.5075).put("y",43.3174))
            .put("rotation",-6.8).put("mode",mode).put("progress",25).put("advanceWithTime",false);
    }

    private static String repeat(char value,int count) {
        char[] chars = new char[count]; java.util.Arrays.fill(chars,value); return new String(chars);
    }

    private static JSONObject snapshot() throws Exception {
        return new JSONObject().put("version", 1).put("generatedAt", "2026-09-14T08:00:00.000Z")
            .put("kind", "flight").put("theme", "forest").put("eyebrow", "EK202")
            .put("title", "JFK → DXB").put("subtitle", "ETA 7:30 PM GST · Estimated")
            .put("badge", "Scheduled").put("route", "/journal?section=flights").put("privacy", "full")
            .put("expiresAt", "2026-09-15T08:00:00.000Z")
            .put("flight", new JSONObject().put("departureAt", "2026-09-14T09:00:00.000Z")
                .put("arrivalAt", "2026-09-14T21:00:00.000Z")
                .put("updatedAt", "2026-09-14T07:59:00.000Z"));
    }

    private static void reject(JSONObject json) {
        try {
            BubbleWidgetSnapshot.parse(json.toString());
            fail("Expected invalid widget contract to be rejected");
        } catch (IllegalArgumentException expected) { /* Fail closed. */ }
    }
}
