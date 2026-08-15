package com.simerfamily.kinsphere;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.simerfamily.kinsphere.cardboard.CardboardOrientationPlugin;
import com.simerfamily.kinsphere.capsule.CapsuleRecapPlugin;
import com.simerfamily.kinsphere.debug.DebugAccessPlugin;
import com.simerfamily.kinsphere.panorama.PanoramaCapturePlugin;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(CardboardOrientationPlugin.class);
        registerPlugin(CapsuleRecapPlugin.class);
        registerPlugin(DebugAccessPlugin.class);
        registerPlugin(PanoramaCapturePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
