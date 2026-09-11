package com.simerfamily.kinsphere.widget;

import android.graphics.Bitmap;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;

/** Receives bounded widget state from the shared Bubble web application. */
@CapacitorPlugin(name = "BubbleWidget")
public final class BubbleWidgetPlugin extends Plugin {

    @PluginMethod
    public void update(PluginCall call) {
        String rawSnapshot = call.getString("snapshot");
        String rawThumbnail = call.getString("thumbnailBase64");
        final BubbleWidgetSnapshot snapshot;
        try {
            snapshot = BubbleWidgetSnapshot.parse(rawSnapshot);
        } catch (IllegalArgumentException exception) {
            call.reject(exception.getMessage(), "INVALID_WIDGET_SNAPSHOT", exception);
            return;
        }

        if (
            rawThumbnail != null &&
            rawThumbnail.length() > BubbleWidgetImages.MAX_BASE64_CHARACTERS
        ) {
            call.reject("thumbnailBase64 is too large.", "INVALID_WIDGET_THUMBNAIL");
            return;
        }

        Bitmap thumbnail = null;
        try {
            if (snapshot.mayShowThumbnail() && rawThumbnail != null) {
                thumbnail = BubbleWidgetImages.decodeThumbnail(rawThumbnail);
            }
            BubbleWidgetStore.save(getContext(), snapshot, thumbnail);
            BubbleWidgetScheduler.replace(getContext(), snapshot);
            BubbleWidgetProvider.updateAll(getContext());

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
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            BubbleWidgetStore.clear(getContext());
            BubbleWidgetScheduler.cancel(getContext());
            BubbleWidgetProvider.updateAll(getContext());
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
