# Google Cardboard runtime for iOS

This directory pins the native iOS viewer to the same Google Cardboard release
used by Bubble's Android viewer:

- Cardboard SDK: **v1.34.0**
- Upstream commit: `4775db6e0a92fdc8bd102a818d741f2bde372876`
- Protobuf-C++: **3.18.0**

The source release was built from Google's `GfxPluginCardboard` Xcode target.
The final relocatable archives force-load the complete Cardboard library while
allowing the Apple linker to retain only the Protobuf objects it actually uses.
This keeps the checked-in XCFramework under 5 MB without changing the runtime.
The simulator slice contains both arm64 and x86_64.

The corresponding QR scanner resources live at
`App/Resources/GoogleCardboard/sdk.bundle`. Do not omit that bundle: its
`resolutions.csv` data is part of the physical screen calibration.

## Integrity

```text
ddfc344bf9e1139cc1c4d70a0002e17bf3823082730fc7eca63de50814ff119e  ios-arm64/libGoogleCardboard.a
ea5a3294587140c7553b4124b1a6caf9174ae7e9ef2f609fb86af2baad436367  ios-arm64_x86_64-simulator/libGoogleCardboard-universal.a
0b8cce32859b014062fbf7d975716201ea3eb9652a38e89e2477718d30ca56a3  include/cardboard.h
```

Cardboard is licensed under Apache 2.0; see `LICENSE`. The pinned Protobuf
license is retained separately in `PROTOBUF_LICENSE`.

Upstream sources and integration guide:

- https://github.com/googlevr/cardboard/tree/v1.34.0
- https://developers.google.com/cardboard/develop/ios/quickstart
