#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <simd/simd.h>

NS_ASSUME_NONNULL_BEGIN

/** The two calibrated Cardboard eyes. */
typedef NS_ENUM(NSInteger, BubbleCardboardEye) {
    BubbleCardboardEyeLeft = 0,
    BubbleCardboardEyeRight = 1,
};

/**
 A small Objective-C++ boundary around Google's C Cardboard SDK.

 Keeping SDK ownership here makes the Swift renderer deal only in Metal objects
 and simd matrices. It also gives every retained Objective-C pointer passed to
 the C API an obvious, balanced lifetime.
 */
@interface BubbleCardboardSession : NSObject {
@private
    void *_nativeState;
}

- (nullable instancetype)initWithDevice:(id<MTLDevice>)device
                        colorPixelFormat:(MTLPixelFormat)colorPixelFormat;

/** True only when the user has scanned and saved a headset QR profile. */
+ (BOOL)hasSavedViewerProfile;

/** Opens Google's native QR scanner and stores a successful headset profile. */
+ (void)scanViewerProfile;

/** The SDK increments this whenever a newly scanned profile is saved. */
+ (NSInteger)viewerProfileVersion;

/** Starts and stops the SDK sensor pipeline with the containing view. */
- (void)resumeTracking;
- (void)pauseTracking;

/**
 Rebuilds projections and distortion meshes when pixels or the QR profile change.

 If no QR profile has been saved, Google's Cardboard V1 profile is used for the
 current session. This mirrors Android's usable "standard viewer" fallback.
 */
- (BOOL)prepareForDisplayWidth:(NSInteger)width height:(NSInteger)height;

/** Predicted head pose in the landscape-right presentation used by the app. */
- (matrix_float4x4)predictedHeadPose;

/** Profile-derived transforms. They intentionally remain different per eye. */
- (matrix_float4x4)eyeFromHeadMatrixForEye:(BubbleCardboardEye)eye;
- (matrix_float4x4)projectionMatrixForEye:(BubbleCardboardEye)eye;

/**
 Warps the side-by-side eye atlas into the current drawable using Google's
 headset-specific Metal distortion mesh. The encoder must still be active.
 */
- (void)renderEyeTexture:(id<MTLTexture>)eyeTexture
          commandEncoder:(id<MTLRenderCommandEncoder>)commandEncoder
             screenWidth:(NSInteger)screenWidth
            screenHeight:(NSInteger)screenHeight;

/** Releases renderer, lens, and sensor resources. Safe to call more than once. */
- (void)invalidate;

@end

NS_ASSUME_NONNULL_END
