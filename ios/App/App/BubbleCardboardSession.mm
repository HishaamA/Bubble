#import "BubbleCardboardSession.h"

#import <UIKit/UIKit.h>

#include <climits>
#include <cmath>
#include <cstring>
#include <time.h>

#include "cardboard.h"

namespace {

constexpr int64_t kPredictionLeadTimeNanoseconds = 50'000'000;
constexpr float kNearPlane = 0.1f;
constexpr float kFarPlane = 100.0f;

// Owns every opaque Cardboard handle plus the calibrated transforms copied for
// Swift. The containing renderer serializes access to this state.
struct BubbleCardboardState {
    __strong id<MTLDevice> device;
    MTLPixelFormat colorPixelFormat;
    CardboardHeadTracker *headTracker = nullptr;
    CardboardLensDistortion *lensDistortion = nullptr;
    CardboardDistortionRenderer *distortionRenderer = nullptr;
    matrix_float4x4 eyeFromHead[2];
    matrix_float4x4 projection[2];
    int displayWidth = 0;
    int displayHeight = 0;
    int profileVersion = -1;
    bool tracking = false;
    bool ready = false;

    // Retains the Metal device for as long as native Cardboard handles need it.
    BubbleCardboardState(id<MTLDevice> metalDevice, MTLPixelFormat pixelFormat)
        : device(metalDevice), colorPixelFormat(pixelFormat) {}
};

// Supplies safe transforms while calibration or tracking is unavailable.
matrix_float4x4 IdentityMatrix() {
    return matrix_identity_float4x4;
}

// Cardboard and simd both expose column-major 4×4 arrays, so a checked byte copy
// avoids a hand-written transpose or indexing convention mismatch.
matrix_float4x4 MatrixFromCardboardArray(const float values[16]) {
    matrix_float4x4 matrix;
    static_assert(sizeof(matrix) == sizeof(float) * 16,
                  "A Cardboard matrix must map to four simd float columns.");
    std::memcpy(&matrix, values, sizeof(matrix));
    return matrix;
}

// Converts the SDK's normalized quaternion and translation into simd columns.
matrix_float4x4 PoseMatrix(const float position[3], const float orientation[4]) {
    float x = orientation[0];
    float y = orientation[1];
    float z = orientation[2];
    float w = orientation[3];
    const float length = std::sqrt(x * x + y * y + z * z + w * w);
    if (!std::isfinite(length) || length < 0.000001f) {
        return IdentityMatrix();
    }

    x /= length;
    y /= length;
    z /= length;
    w /= length;

    const float xx = x * x;
    const float yy = y * y;
    const float zz = z * z;
    const float xy = x * y;
    const float xz = x * z;
    const float yz = y * z;
    const float wx = w * x;
    const float wy = w * y;
    const float wz = w * z;

    // simd matrices are column-major, which is also the Cardboard matrix
    // convention. Translation * rotation therefore places position in c3.
    return (matrix_float4x4){
        (vector_float4){1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0},
        (vector_float4){2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0},
        (vector_float4){2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0},
        (vector_float4){position[0], position[1], position[2], 1},
    };
}

// Tears down optics in dependency order while retaining the reusable tracker.
void DestroyOptics(BubbleCardboardState *state) {
    if (state->distortionRenderer != nullptr) {
        CardboardDistortionRenderer_destroy(state->distortionRenderer);
        state->distortionRenderer = nullptr;
    }
    if (state->lensDistortion != nullptr) {
        CardboardLensDistortion_destroy(state->lensDistortion);
        state->lensDistortion = nullptr;
    }
    state->ready = false;
    state->displayWidth = 0;
    state->displayHeight = 0;
    state->profileVersion = -1;
}

}  // namespace

@implementation BubbleCardboardSession

- (nullable instancetype)initWithDevice:(id<MTLDevice>)device
                        colorPixelFormat:(MTLPixelFormat)colorPixelFormat {
    self = [super init];
    if (self == nil) return nil;

    auto *state = new BubbleCardboardState(device, colorPixelFormat);
    state->headTracker = CardboardHeadTracker_create();
    if (state->headTracker == nullptr) {
        delete state;
        return nil;
    }
    state->eyeFromHead[0] = IdentityMatrix();
    state->eyeFromHead[1] = IdentityMatrix();
    state->projection[0] = IdentityMatrix();
    state->projection[1] = IdentityMatrix();
    _nativeState = state;
    return self;
}

- (void)dealloc {
    [self invalidate];
    auto *state = static_cast<BubbleCardboardState *>(_nativeState);
    delete state;
    _nativeState = nullptr;
}

+ (BOOL)hasSavedViewerProfile {
    uint8_t *parameters = nullptr;
    int size = 0;
    CardboardQrCode_getSavedDeviceParams(&parameters, &size);
    const BOOL hasProfile = parameters != nullptr && size > 0;
    if (parameters != nullptr) {
        CardboardQrCode_destroy(parameters);
    }
    return hasProfile;
}

+ (void)scanViewerProfile {
    NSAssert(NSThread.isMainThread, @"The Cardboard QR scanner must open on the main thread.");
    CardboardQrCode_scanQrCodeAndSaveDeviceParams();
}

+ (NSInteger)viewerProfileVersion {
    return CardboardQrCode_getDeviceParamsChangedCount();
}

- (void)resumeTracking {
    auto *state = static_cast<BubbleCardboardState *>(_nativeState);
    if (state == nullptr || state->headTracker == nullptr || state->tracking) return;
    CardboardHeadTracker_resume(state->headTracker);
    state->tracking = true;
}

- (void)pauseTracking {
    auto *state = static_cast<BubbleCardboardState *>(_nativeState);
    if (state == nullptr || state->headTracker == nullptr || !state->tracking) return;
    CardboardHeadTracker_pause(state->headTracker);
    state->tracking = false;
}

- (BOOL)prepareForDisplayWidth:(NSInteger)width height:(NSInteger)height {
    auto *state = static_cast<BubbleCardboardState *>(_nativeState);
    if (state == nullptr || width < 2 || height < 2 || width > INT_MAX || height > INT_MAX) {
        return NO;
    }

    // Reuse optics only while both physical pixels and the saved QR profile match.
    const int profileVersion = CardboardQrCode_getDeviceParamsChangedCount();
    if (state->ready && state->displayWidth == width && state->displayHeight == height &&
        state->profileVersion == profileVersion) {
        return YES;
    }

    DestroyOptics(state);

    uint8_t *parameters = nullptr;
    int parameterSize = 0;
    CardboardQrCode_getSavedDeviceParams(&parameters, &parameterSize);
    if (parameters == nullptr || parameterSize <= 0) {
        if (parameters != nullptr) {
            CardboardQrCode_destroy(parameters);
        }
        parameters = nullptr;
        parameterSize = 0;
        // Android's CardboardView remains usable without a saved QR code. The
        // SDK's own V1 profile is the closest identical iOS fallback.
        CardboardQrCode_getCardboardV1DeviceParams(&parameters, &parameterSize);
    }

    if (parameters == nullptr || parameterSize <= 0) {
        if (parameters != nullptr) {
            CardboardQrCode_destroy(parameters);
        }
        return NO;
    }

    state->lensDistortion = CardboardLensDistortion_create(
        parameters,
        parameterSize,
        static_cast<int>(width),
        static_cast<int>(height)
    );
    // Both saved and built-in parameter APIs return caller-owned memory.
    CardboardQrCode_destroy(parameters);
    if (state->lensDistortion == nullptr) return NO;

    // The C ABI represents Objective-C objects as integers. Balance each bridge
    // retain immediately after the SDK constructor has copied what it needs.
    CFTypeRef retainedDevice = CFBridgingRetain(state->device);
    const CardboardMetalDistortionRendererConfig rendererConfig = {
        reinterpret_cast<uint64_t>(retainedDevice),
        static_cast<uint64_t>(state->colorPixelFormat),
        static_cast<uint64_t>(MTLPixelFormatInvalid),
        static_cast<uint64_t>(MTLPixelFormatInvalid),
    };
    state->distortionRenderer = CardboardMetalDistortionRenderer_create(&rendererConfig);
    (void)CFBridgingRelease(retainedDevice);
    if (state->distortionRenderer == nullptr) {
        DestroyOptics(state);
        return NO;
    }

    for (NSInteger index = 0; index < 2; ++index) {
        const CardboardEye eye = index == 0 ? kLeft : kRight;
        float eyeMatrix[16];
        float projectionMatrix[16];
        CardboardLensDistortion_getEyeFromHeadMatrix(
            state->lensDistortion,
            eye,
            eyeMatrix
        );
        CardboardLensDistortion_getProjectionMatrix(
            state->lensDistortion,
            eye,
            kNearPlane,
            kFarPlane,
            projectionMatrix
        );
        state->eyeFromHead[index] = MatrixFromCardboardArray(eyeMatrix);
        state->projection[index] = MatrixFromCardboardArray(projectionMatrix);

        CardboardMesh mesh = {};
        CardboardLensDistortion_getDistortionMesh(state->lensDistortion, eye, &mesh);
        if (mesh.n_indices <= 0 || mesh.n_vertices <= 0) {
            DestroyOptics(state);
            return NO;
        }
        // The Metal renderer copies mesh data into its own MTLBuffers, so the
        // lens object can retain ownership of the source arrays.
        CardboardDistortionRenderer_setMesh(state->distortionRenderer, &mesh, eye);
    }

    state->displayWidth = static_cast<int>(width);
    state->displayHeight = static_cast<int>(height);
    state->profileVersion = profileVersion;
    state->ready = true;
    return YES;
}

- (matrix_float4x4)predictedHeadPose {
    auto *state = static_cast<BubbleCardboardState *>(_nativeState);
    if (state == nullptr || state->headTracker == nullptr) return IdentityMatrix();

    float position[3] = {0, 0, 0};
    float orientation[4] = {0, 0, 0, 1};
    const int64_t targetTime = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) +
        kPredictionLeadTimeNanoseconds;
    CardboardHeadTracker_getPose(
        state->headTracker,
        targetTime,
        // UIInterfaceOrientation.landscapeRight corresponds to the physical
        // UIDevice landscape-left pose used by Google's official iOS sample.
        kLandscapeLeft,
        position,
        orientation
    );
    return PoseMatrix(position, orientation);
}

- (matrix_float4x4)eyeFromHeadMatrixForEye:(BubbleCardboardEye)eye {
    auto *state = static_cast<BubbleCardboardState *>(_nativeState);
    if (state == nullptr || !state->ready) return IdentityMatrix();
    return state->eyeFromHead[eye == BubbleCardboardEyeRight ? 1 : 0];
}

- (matrix_float4x4)projectionMatrixForEye:(BubbleCardboardEye)eye {
    auto *state = static_cast<BubbleCardboardState *>(_nativeState);
    if (state == nullptr || !state->ready) return IdentityMatrix();
    return state->projection[eye == BubbleCardboardEyeRight ? 1 : 0];
}

- (void)renderEyeTexture:(id<MTLTexture>)eyeTexture
          commandEncoder:(id<MTLRenderCommandEncoder>)commandEncoder
             screenWidth:(NSInteger)screenWidth
            screenHeight:(NSInteger)screenHeight {
    auto *state = static_cast<BubbleCardboardState *>(_nativeState);
    if (state == nullptr || !state->ready || state->distortionRenderer == nullptr) return;

    // The renderer consumes the active Metal objects during this call; temporary
    // retains make their ABI lifetime explicit without leaking them per frame.
    CFTypeRef retainedTexture = CFBridgingRetain(eyeTexture);
    CardboardEyeTextureDescription leftEye = {
        reinterpret_cast<uint64_t>(retainedTexture), 0.0f, 0.5f, 1.0f, 0.0f,
    };
    CardboardEyeTextureDescription rightEye = {
        reinterpret_cast<uint64_t>(retainedTexture), 0.5f, 1.0f, 1.0f, 0.0f,
    };

    CFTypeRef retainedEncoder = CFBridgingRetain(commandEncoder);
    CardboardMetalDistortionRendererTargetConfig targetConfig = {
        reinterpret_cast<uint64_t>(retainedEncoder),
        static_cast<int>(screenWidth),
        static_cast<int>(screenHeight),
    };
    CardboardDistortionRenderer_renderEyeToDisplay(
        state->distortionRenderer,
        reinterpret_cast<uint64_t>(&targetConfig),
        0,
        0,
        static_cast<int>(screenWidth),
        static_cast<int>(screenHeight),
        &leftEye,
        &rightEye
    );
    (void)CFBridgingRelease(retainedEncoder);
    (void)CFBridgingRelease(retainedTexture);
}

- (void)invalidate {
    auto *state = static_cast<BubbleCardboardState *>(_nativeState);
    if (state == nullptr) return;
    [self pauseTracking];
    DestroyOptics(state);
    if (state->headTracker != nullptr) {
        CardboardHeadTracker_destroy(state->headTracker);
        state->headTracker = nullptr;
    }
}

@end
