package com.simerfamily.kinsphere.widget;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Rotates a pre-shuffled, authorized photo pool without moving other swipe slots. */
final class BubbleWidgetPhotoRotation {
    private static final long HOUR_MILLIS = 60L * 60L * 1000L;

    private BubbleWidgetPhotoRotation() {}

    /**
     * The returned page owns both its route and image ID. The collection host must
     * retain the original snapshot page ID for each slot so a parked planner does
     * not move when the images change. No new media is fetched outside the app.
     */
    static List<BubbleWidgetSnapshot.Page> pagesForDisplay(
        BubbleWidgetSnapshot snapshot,
        long nowMillis
    ) {
        if (
            snapshot == null ||
            !"full".equals(snapshot.privacy)
        ) {
            return Collections.emptyList();
        }
        snapshot = snapshot.forDisplay(nowMillis);
        if (!"full".equals(snapshot.privacy)) return Collections.emptyList();
        List<Integer> photoSlots = photoSlots(snapshot);
        if (photoSlots.size() < 2) {
            return snapshot.pages;
        }
        long elapsedHours = Math.max(
            0L,
            Math.floorDiv(nowMillis, HOUR_MILLIS) -
                Math.floorDiv(snapshot.generatedAtMillis, HOUR_MILLIS)
        );
        int offset = (int) (elapsedHours % photoSlots.size());
        if (offset == 0) {
            return snapshot.pages;
        }
        List<BubbleWidgetSnapshot.Page> result = new ArrayList<>(snapshot.pages);
        for (int index = 0; index < photoSlots.size(); index += 1) {
            int sourceSlot = photoSlots.get((index + offset) % photoSlots.size());
            result.set(photoSlots.get(index), snapshot.pages.get(sourceSlot));
        }
        return Collections.unmodifiableList(result);
    }

    /** Zero means no photo refresh is needed; midnight expiry is scheduled separately. */
    static long nextRefreshAtMillis(BubbleWidgetSnapshot snapshot, long nowMillis) {
        if (
            snapshot == null ||
            !snapshot.isCurrentLocalDay(nowMillis) ||
            photoSlots(snapshot.forDisplay(nowMillis)).size() < 2
        ) {
            return 0L;
        }
        return (Math.floorDiv(nowMillis, HOUR_MILLIS) + 1L) * HOUR_MILLIS;
    }

    private static List<Integer> photoSlots(BubbleWidgetSnapshot snapshot) {
        List<Integer> result = new ArrayList<>();
        if (!"full".equals(snapshot.privacy)) {
            return result;
        }
        for (int index = 0; index < snapshot.pages.size(); index += 1) {
            BubbleWidgetSnapshot.Page page = snapshot.pages.get(index);
            if (
                "photos".equals(page.group) &&
                "memory".equals(page.kind) &&
                page.mayShowThumbnail()
            ) {
                result.add(index);
            }
        }
        return result;
    }
}
