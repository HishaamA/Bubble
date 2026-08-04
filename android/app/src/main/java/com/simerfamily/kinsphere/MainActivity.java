package com.simerfamily.kinsphere;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.simerfamily.kinsphere.panorama.PanoramaCapturePlugin;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PanoramaCapturePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
