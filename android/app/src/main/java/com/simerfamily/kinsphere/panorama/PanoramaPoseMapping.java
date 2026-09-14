package com.simerfamily.kinsphere.panorama;

/** Rigid coordinate mappings; re-anchoring must not move already captured directions. */
final class PanoramaPoseMapping {
    private PanoramaPoseMapping() {}

    static PanoramaPose identity() {
        return PanoramaPose.fromCameraTransform(new float[] {
            1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1
        });
    }

    static PanoramaPose compose(PanoramaPose mapping, PanoramaPose pose) {
        float[] result = new float[16];
        for (int column = 0; column < 4; column++) {
            for (int row = 0; row < 4; row++) {
                for (int k = 0; k < 4; k++) {
                    result[column * 4 + row] += mapping.transform[k * 4 + row] * pose.transform[column * 4 + k];
                }
            }
        }
        return PanoramaPose.fromCameraTransform(result);
    }

    static PanoramaPose between(PanoramaPose from, PanoramaPose to) {
        // to * inverse(from), including translation in the same rigid reference.
        PanoramaPose inverse = PanoramaPose.relativeToAnchor(identity().transform, from.transform);
        return compose(to, inverse);
    }
}
