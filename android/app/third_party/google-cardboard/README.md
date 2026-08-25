# Google Cardboard SDK

KinSphere's Android VR viewer uses the official Google Cardboard SDK v1.34.0,
commit `4775db6e0a92fdc8bd102a818d741f2bde372876`.

The pinned AAR contains the Java viewer API, QR profile scanner, resources,
`libGfxPluginCardboard.so`, and `libcardboard_sdk_jni.so` for ARM32 and ARM64.
It was built from the tagged source with release minification disabled so the
public Java API remains available, the Java JNI bridge added to the SDK CMake
target, and the library minimum SDK aligned with KinSphere's API 24 minimum.

Pinned AAR SHA-256:
`0F27796D59D75C3FFE88CFFAAD0CAEA255CB60044634D643ACA19E5F9EE572C8`

Upstream: https://github.com/googlevr/cardboard/tree/v1.34.0

The matching JNI bridge and public header are retained under
`app/src/main/cpp/cardboard_sdk` for audit and reproducible rebuilds. The app
currently consumes the self-contained AAR and does not compile that source
snapshot directly.

The upstream Apache 2.0 license is included in this directory.
