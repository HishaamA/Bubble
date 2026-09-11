package com.simerfamily.kinsphere.widget;

import android.graphics.Bitmap;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;

/** Receives bounded widget state from the shared Bubble web application. */
@CapacitorPlugin(name = "BubbleWidget")
public final class BubbleWidgetPlugin extends Plugin {

    private static final int MAX_PAGE_THUMBNAILS = 8;

    @PluginMethod
    public void update(PluginCall call) {
        String rawSnapshot = call.getString("snapshot");
        String rawThumbnail = call.getString("thumbnailBase64");
        final BubbleWidgetSnapshot snapshot;
        try {
            snapshot = BubbleWidgetSnapshot.parse(rawSnapshot);
            if (
                !snapshot.pages.isEmpty() &&
                !snapshot.isCurrentLocalDay(System.currentTimeMillis())
            ) {
                throw new IllegalArgumentException(
                    "pages require a snapshot generated on the current local day."
                );
            }
        } catch (IllegalArgumentException exception) {
            call.reject(exception.getMessage(), "INVALID_WIDGET_SNAPSHOT", exception);
            return;
        }

        if (
            snapshot.mayShowThumbnail() &&
            rawThumbnail != null &&
            rawThumbnail.length() > BubbleWidgetImages.MAX_BASE64_CHARACTERS
        ) {
            call.reject("thumbnailBase64 is too large.", "INVALID_WIDGET_THUMBNAIL");
            return;
        }

        final Map<String, String> encodedPageThumbnails;
        try {
            encodedPageThumbnails = readPageThumbnails(call, snapshot);
        } catch (IllegalArgumentException exception) {
            call.reject(exception.getMessage(), "INVALID_WIDGET_THUMBNAIL", exception);
            return;
        }

        Bitmap thumbnail = null;
        Map<String, Bitmap> pageThumbnails = new LinkedHashMap<>();
        try {
            if (snapshot.mayShowThumbnail() && rawThumbnail != null) {
                thumbnail = BubbleWidgetImages.decodeThumbnail(rawThumbnail);
            }
            for (Map.Entry<String, String> entry : encodedPageThumbnails.entrySet()) {
                pageThumbnails.put(
                    entry.getKey(),
                    BubbleWidgetImages.decodeThumbnail(entry.getValue())
                );
            }
            BubbleWidgetStore.save(getContext(), snapshot, thumbnail, pageThumbnails);
            BubbleWidgetScheduler.replace(getContext(), snapshot);
            if ("hidden".equals(snapshot.privacy)) {
                BubbleWidgetProvider.showPrivateFallback(getContext());
            } else {
                BubbleWidgetProvider.updateAll(getContext());
            }

            JSObject result = new JSObject();
            result.put("updated", true);
            call.resolve(result);
        } catch (IllegalArgumentException exception) {
            call.reject(exception.getMessage(), "INVALID_WIDGET_THUMBNAIL", exception);
        } catch (IOException exception) {
            // save() has already installed a durable hidden boundary. Replace
            // the launcher's cached RemoteViews too, so it cannot keep showing
            // the previous family card while reporting this failed update.
            BubbleWidgetScheduler.cancel(getContext());
            BubbleWidgetProvider.showPrivateFallback(getContext());
            call.reject("The widget could not be stored.", "WIDGET_STORAGE_FAILED", exception);
        } finally {
            if (thumbnail != null && !thumbnail.isRecycled()) {
                thumbnail.recycle();
            }
            for (Bitmap pageThumbnail : pageThumbnails.values()) {
                if (pageThumbnail != null && !pageThumbnail.isRecycled()) {
                    pageThumbnail.recycle();
                }
            }
        }
    }

    private static Map<String, String> readPageThumbnails(
        PluginCall call,
        BubbleWidgetSnapshot snapshot
    ) {
        // A privacy opt-out must not be blocked by stale or malformed media fields.
        if ("hidden".equals(snapshot.privacy)) {
            return new LinkedHashMap<>();
        }
        Object raw = call.getData().opt("pageThumbnails");
        if (raw == null || raw == JSONObject.NULL) {
            return new LinkedHashMap<>();
        }
        if (!(raw instanceof JSONObject)) {
            throw new IllegalArgumentException("pageThumbnails must be an object.");
        }

        JSONObject object = (JSONObject) raw;
        if (object.length() > MAX_PAGE_THUMBNAILS) {
            throw new IllegalArgumentException("pageThumbnails has too many images.");
        }
        Map<String, String> result = new LinkedHashMap<>();
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String pageId = keys.next();
            BubbleWidgetSnapshot.Page page = snapshot.findPage(pageId);
            Object value = object.opt(pageId);
            if (
                page == null ||
                !page.mayShowThumbnail() ||
                !(value instanceof String)
            ) {
                throw new IllegalArgumentException(
                    "pageThumbnails contains an unsupported page image."
                );
            }
            String encoded = (String) value;
            if (
                encoded.isEmpty() ||
                encoded.length() > BubbleWidgetImages.MAX_BASE64_CHARACTERS
            ) {
                throw new IllegalArgumentException(
                    "pageThumbnails contains an image with an unsupported size."
                );
            }
            result.put(pageId, encoded);
        }
        return result;
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            BubbleWidgetStore.clear(getContext());
            BubbleWidgetScheduler.cancel(getContext());
            BubbleWidgetProvider.showPrivateFallback(getContext());
            JSObject result = new JSObject();
            result.put("cleared", true);
            call.resolve(result);
        } catch (IOException exception) {
            // Even if disk cleanup fails, replace every visible launcher surface
            // with a non-sensitive fallback before reporting the error.
            BubbleWidgetScheduler.cancel(getContext());
            BubbleWidgetProvider.showPrivateFallback(getContext());
            call.reject("The widget cache could not be fully cleared.", "WIDGET_CLEAR_FAILED", exception);
        }
    }
}
