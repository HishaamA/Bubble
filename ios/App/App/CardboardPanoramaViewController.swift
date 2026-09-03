import Metal
import MetalKit
import UIKit
import simd

/// Stable failures produced while constructing or calibrating the Metal viewer.
private enum CardboardNativeViewerError: LocalizedError {
    case metalUnavailable
    case cardboardUnavailable
    case shaderUnavailable
    case pipelineCreationFailed(Error)
    case vertexBufferUnavailable

    /// Converts internal setup errors into concise bridge-safe guidance.
    var errorDescription: String? {
        switch self {
        case .metalUnavailable:
            return "Metal is unavailable on this device."
        case .cardboardUnavailable:
            return "Google Cardboard could not start on this device."
        case .shaderUnavailable:
            return "The Cardboard panorama shaders are unavailable."
        case .pipelineCreationFailed:
            return "The Cardboard panorama renderer could not be created."
        case .vertexBufferUnavailable:
            return "The Cardboard panorama geometry could not be created."
        }
    }
}

/** Matrices consumed once for each eye in the off-screen panorama pass. */
private struct CardboardMetalUniforms {
    var inverseProjection: simd_float4x4
    var inverseModelView: simd_float4x4
}

/**
 Draws a monoscopic equirectangular photo through Google's calibrated pipeline.

 There are intentionally two render passes:
 1. Reconstruct a panorama ray for each eye into a shared side-by-side texture.
 2. Ask Cardboard to warp that texture for the scanned phone/headset profile.

 The old iOS viewer skipped step two and used one hard-coded FOV for every
 headset. That is why straight lines and faces stretched at the lens edges.
 */
private final class CardboardMetalPanoramaRenderer: NSObject, MTKViewDelegate {
    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct VertexOutput {
        float4 position [[position]];
        float2 clipPosition;
    };

    struct CardboardUniforms {
        float4x4 inverseProjection;
        float4x4 inverseModelView;
    };

    vertex VertexOutput cardboardVertex(
        uint vertexID [[vertex_id]],
        const device float2 *positions [[buffer(0)]]
    ) {
        VertexOutput output;
        const float2 position = positions[vertexID];
        output.position = float4(position, 0.0, 1.0);
        output.clipPosition = position;
        return output;
    }

    fragment float4 cardboardFragment(
        VertexOutput input [[stage_in]],
        constant CardboardUniforms &uniforms [[buffer(0)]],
        texture2d<float> panorama [[texture(0)]]
    ) {
        constexpr sampler panoramaSampler(
            filter::linear,
            s_address::clamp_to_edge,
            t_address::clamp_to_edge
        );
        constexpr float pi = 3.14159265358979323846;

        // This is the same ray reconstruction used by the Android renderer.
        // Projection asymmetry is preserved per eye, while translation is
        // removed on the CPU because a single 360 photo has no stereo depth.
        float4 eyeRay = uniforms.inverseProjection
            * float4(input.clipPosition, 1.0, 1.0);
        float3 panoramaRay = normalize((uniforms.inverseModelView
            * float4(normalize(eyeRay.xyz), 0.0)).xyz);
        float yaw = atan2(panoramaRay.x, -panoramaRay.z);
        float pitch = asin(clamp(panoramaRay.y, -1.0, 1.0));
        float2 panoramaUV = float2(
            fract(0.5 + yaw / (2.0 * pi)),
            0.5 - pitch / pi
        );
        return panorama.sample(panoramaSampler, panoramaUV);
    }
    """

    var onFailure: ((String) -> Void)?

    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let pipelineState: MTLRenderPipelineState
    private let vertexBuffer: MTLBuffer
    private let textureLoader: MTKTextureLoader
    private let cardboardSession: BubbleCardboardSession
    private let initialModelMatrix: simd_float4x4
    private let resourceLock = NSLock()
    // Google Cardboard's C handles are not documented as thread-safe. Drawing,
    // tracking changes, and teardown therefore share one serialized owner.
    private let sessionLock = NSLock()

    private var panoramaTexture: MTLTexture?
    private var eyeTexture: MTLTexture?
    private var eyeTextureWidth = 0
    private var eyeTextureHeight = 0
    private var released = false
    private var reportedCalibrationFailure = false

    /// Creates the immutable Metal pipeline and calibrated Cardboard owner.
    init(
        device: MTLDevice,
        colorPixelFormat: MTLPixelFormat,
        cardboardSession: BubbleCardboardSession,
        initialYawDegrees: Float,
        initialPitchDegrees: Float
    ) throws {
        guard let commandQueue = device.makeCommandQueue() else {
            throw CardboardNativeViewerError.metalUnavailable
        }
        let library = try device.makeLibrary(source: Self.shaderSource, options: nil)
        guard let vertexFunction = library.makeFunction(name: "cardboardVertex"),
              let fragmentFunction = library.makeFunction(name: "cardboardFragment") else {
            throw CardboardNativeViewerError.shaderUnavailable
        }

        let pipelineDescriptor = MTLRenderPipelineDescriptor()
        pipelineDescriptor.label = "Bubble calibrated Cardboard panorama"
        pipelineDescriptor.vertexFunction = vertexFunction
        pipelineDescriptor.fragmentFunction = fragmentFunction
        pipelineDescriptor.colorAttachments[0].pixelFormat = colorPixelFormat

        do {
            pipelineState = try device.makeRenderPipelineState(
                descriptor: pipelineDescriptor
            )
        } catch {
            throw CardboardNativeViewerError.pipelineCreationFailed(error)
        }

        let vertices: [SIMD2<Float>] = [
            SIMD2<Float>(-1, -1),
            SIMD2<Float>(1, -1),
            SIMD2<Float>(-1, 1),
            SIMD2<Float>(1, 1)
        ]
        let vertexByteCount = vertices.count * MemoryLayout<SIMD2<Float>>.stride
        guard let vertexBuffer = vertices.withUnsafeBytes({ bytes -> MTLBuffer? in
            guard let baseAddress = bytes.baseAddress else { return nil }
            return device.makeBuffer(
                bytes: baseAddress,
                length: vertexByteCount,
                options: .storageModeShared
            )
        }) else {
            throw CardboardNativeViewerError.vertexBufferUnavailable
        }

        self.device = device
        self.commandQueue = commandQueue
        self.vertexBuffer = vertexBuffer
        self.cardboardSession = cardboardSession
        textureLoader = MTKTextureLoader(device: device)

        // Android builds Rx(-pitch) * Ry(+yaw). The shader later applies the
        // inverse model-view matrix, keeping the supplied scene center intact.
        let pitch = Self.rotationX(-initialPitchDegrees * .pi / 180)
        let yaw = Self.rotationY(initialYawDegrees * .pi / 180)
        initialModelMatrix = pitch * yaw
        super.init()
    }

    /// Loads the staged panorama asynchronously and ignores a late result after
    /// the renderer has been released.
    func loadPanorama(
        at url: URL,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        let options: [MTKTextureLoader.Option: Any] = [
            .SRGB: false,
            .textureUsage: NSNumber(value: MTLTextureUsage.shaderRead.rawValue),
            .textureStorageMode: NSNumber(value: MTLStorageMode.private.rawValue),
            .origin: MTKTextureLoader.Origin.topLeft
        ]
        textureLoader.newTexture(URL: url, options: options) { [weak self] texture, error in
            guard let self else { return }
            if let texture {
                self.resourceLock.lock()
                if !self.released {
                    self.panoramaTexture = texture
                }
                let accepted = !self.released
                self.resourceLock.unlock()
                if accepted { completion(.success(())) }
                return
            }
            completion(.failure(error ?? CardboardNativeViewerError.shaderUnavailable))
        }
    }

    /// Stops future frames, releases Metal textures, and then invalidates the
    /// Cardboard C handles after any in-flight draw completes.
    func releaseResources() {
        resourceLock.lock()
        guard !released else {
            resourceLock.unlock()
            return
        }
        released = true
        panoramaTexture = nil
        eyeTexture = nil
        resourceLock.unlock()
        sessionLock.lock()
        cardboardSession.invalidate()
        sessionLock.unlock()
    }

    /// Resumes head tracking unless teardown has already claimed the renderer.
    func resumeTracking() {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        resourceLock.lock()
        let isReleased = released
        resourceLock.unlock()
        guard !isReleased else { return }
        cardboardSession.resumeTracking()
    }

    /// Pauses head tracking without racing the Metal draw callback.
    func pauseTracking() {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        cardboardSession.pauseTracking()
    }

    /// Drops the eye atlas after drawable geometry changes.
    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        // The next frame recreates the atlas and the Cardboard calibration
        // together, so they can never disagree about the physical pixel size.
        resourceLock.lock()
        eyeTexture = nil
        eyeTextureWidth = 0
        eyeTextureHeight = 0
        resourceLock.unlock()
    }

    /// Draws both panorama eyes and submits Google's lens-distortion pass as one
    /// serialized interaction with the native Cardboard session.
    func draw(in view: MTKView) {
        sessionLock.lock()
        defer { sessionLock.unlock() }

        resourceLock.lock()
        let isReleased = released
        let panorama = panoramaTexture
        resourceLock.unlock()

        guard !isReleased,
              let drawable = view.currentDrawable,
              let finalPassDescriptor = view.currentRenderPassDescriptor,
              let commandBuffer = commandQueue.makeCommandBuffer() else {
            return
        }

        let width = max(Int(view.drawableSize.width.rounded()), 2)
        let height = max(Int(view.drawableSize.height.rounded()), 2)
        // UIKit may hand MTKView one portrait-sized frame while the full-screen
        // presentation rotates. Never calibrate Cardboard against that
        // transient geometry; its optical model expects the final landscape
        // display dimensions.
        guard width > height else {
            encodeBlackFrame(
                descriptor: finalPassDescriptor,
                commandBuffer: commandBuffer
            )
            commandBuffer.present(drawable)
            commandBuffer.commit()
            return
        }

        // Texture loading is asynchronous. A blank loading frame is normal and
        // must not be reported as a failed Cardboard calibration.
        guard let panorama else {
            encodeBlackFrame(
                descriptor: finalPassDescriptor,
                commandBuffer: commandBuffer
            )
            commandBuffer.present(drawable)
            commandBuffer.commit()
            return
        }

        guard cardboardSession.prepare(forDisplayWidth: width, height: height),
              let eyeAtlas = makeOrReuseEyeTexture(width: width, height: height),
              renderPanoramaEyes(
                panorama: panorama,
                eyeAtlas: eyeAtlas,
                commandBuffer: commandBuffer,
                width: width,
                height: height
              ) else {
            encodeBlackFrame(
                descriptor: finalPassDescriptor,
                commandBuffer: commandBuffer
            )
            commandBuffer.present(drawable)
            commandBuffer.commit()
            reportCalibrationFailureOnce()
            return
        }

        // The second encoder is the missing step from the previous iOS build:
        // Cardboard bends each eye using the selected headset's real mesh.
        finalPassDescriptor.colorAttachments[0].loadAction = .clear
        finalPassDescriptor.colorAttachments[0].storeAction = .store
        finalPassDescriptor.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
        guard let distortionEncoder = commandBuffer.makeRenderCommandEncoder(
            descriptor: finalPassDescriptor
        ) else {
            // Do not strand the drawable if Metal declines the final encoder.
            // Committing the otherwise valid off-screen work lets MTKView
            // recover normally on the following frame.
            commandBuffer.present(drawable)
            commandBuffer.commit()
            reportCalibrationFailureOnce()
            return
        }
        cardboardSession.renderEyeTexture(
            eyeAtlas,
            commandEncoder: distortionEncoder,
            screenWidth: width,
            screenHeight: height
        )
        distortionEncoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
        reportedCalibrationFailure = false
    }

    /// Reuses the side-by-side eye atlas until the physical drawable size changes.
    private func makeOrReuseEyeTexture(width: Int, height: Int) -> MTLTexture? {
        resourceLock.lock()
        defer { resourceLock.unlock() }
        if let eyeTexture,
           eyeTextureWidth == width,
           eyeTextureHeight == height {
            return eyeTexture
        }

        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm,
            width: width,
            height: height,
            mipmapped: false
        )
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .private
        descriptor.resourceOptions = .storageModePrivate
        let texture = device.makeTexture(descriptor: descriptor)
        texture?.label = "Bubble Cardboard side-by-side eye atlas"
        eyeTexture = texture
        eyeTextureWidth = width
        eyeTextureHeight = height
        return texture
    }

    /// Reconstructs one calibrated ray field per eye into the shared atlas.
    private func renderPanoramaEyes(
        panorama: MTLTexture,
        eyeAtlas: MTLTexture,
        commandBuffer: MTLCommandBuffer,
        width: Int,
        height: Int
    ) -> Bool {
        let descriptor = MTLRenderPassDescriptor()
        descriptor.colorAttachments[0].texture = eyeAtlas
        descriptor.colorAttachments[0].loadAction = .clear
        descriptor.colorAttachments[0].storeAction = .store
        descriptor.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
            return false
        }

        encoder.setRenderPipelineState(pipelineState)
        encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
        encoder.setFragmentTexture(panorama, index: 0)

        // One predicted pose is shared by both eye draws, matching Android's
        // onNewFrame/onDrawEye contract and avoiding a tiny temporal mismatch.
        let headPose = cardboardSession.predictedHeadPose()
        let leftWidth = width / 2
        let eyeWidths = [leftWidth, width - leftWidth]
        let eyeOrigins = [0, leftWidth]
        let eyes: [BubbleCardboardEye] = [.left, .right]

        for index in 0..<2 {
            var eyeView = cardboardSession.eyeFromHeadMatrix(for: eyes[index]) * headPose
            // The two eye projections remain calibrated and asymmetric. Only
            // translation is removed, because this input is one mono photo.
            eyeView.columns.3.x = 0
            eyeView.columns.3.y = 0
            eyeView.columns.3.z = 0
            eyeView.columns.3.w = 1

            let modelView = eyeView * initialModelMatrix
            let projection = cardboardSession.projectionMatrix(for: eyes[index])
            guard Self.isInvertible(modelView), Self.isInvertible(projection) else {
                encoder.endEncoding()
                return false
            }
            var uniforms = CardboardMetalUniforms(
                inverseProjection: simd_inverse(projection),
                inverseModelView: simd_inverse(modelView)
            )

            encoder.setViewport(
                MTLViewport(
                    originX: Double(eyeOrigins[index]),
                    originY: 0,
                    width: Double(eyeWidths[index]),
                    height: Double(height),
                    znear: 0,
                    zfar: 1
                )
            )
            encoder.setScissorRect(
                MTLScissorRect(
                    x: eyeOrigins[index],
                    y: 0,
                    width: eyeWidths[index],
                    height: height
                )
            )
            encoder.setFragmentBytes(
                &uniforms,
                length: MemoryLayout<CardboardMetalUniforms>.stride,
                index: 0
            )
            encoder.drawPrimitives(
                type: .triangleStrip,
                vertexStart: 0,
                vertexCount: 4
            )
        }

        encoder.endEncoding()
        return true
    }

    /// Clears transitional or failed frames while preserving MTKView cadence.
    private func encodeBlackFrame(
        descriptor: MTLRenderPassDescriptor,
        commandBuffer: MTLCommandBuffer
    ) {
        descriptor.colorAttachments[0].loadAction = .clear
        descriptor.colorAttachments[0].storeAction = .store
        descriptor.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
        let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor)
        encoder?.endEncoding()
    }

    /// Coalesces repeated renderer failures into one UI dismissal request.
    private func reportCalibrationFailureOnce() {
        guard !reportedCalibrationFailure else { return }
        reportedCalibrationFailure = true
        DispatchQueue.main.async { [weak self] in
            self?.onFailure?("This phone could not prepare the calibrated VR view.")
        }
    }

    /// Rejects non-finite or singular Cardboard matrices before inversion.
    private static func isInvertible(_ matrix: simd_float4x4) -> Bool {
        let values = [matrix.columns.0, matrix.columns.1, matrix.columns.2, matrix.columns.3]
        guard values.allSatisfy({ column in
            column.x.isFinite && column.y.isFinite &&
                column.z.isFinite && column.w.isFinite
        }) else {
            return false
        }
        let determinant = simd_determinant(matrix)
        return determinant.isFinite && abs(determinant) > 0.000_000_1
    }

    /// Builds the initial panorama pitch transform.
    private static func rotationX(_ radians: Float) -> simd_float4x4 {
        let cosine = cos(radians)
        let sine = sin(radians)
        return simd_float4x4(columns: (
            SIMD4<Float>(1, 0, 0, 0),
            SIMD4<Float>(0, cosine, sine, 0),
            SIMD4<Float>(0, -sine, cosine, 0),
            SIMD4<Float>(0, 0, 0, 1)
        ))
    }

    /// Builds the initial panorama yaw transform.
    private static func rotationY(_ radians: Float) -> simd_float4x4 {
        let cosine = cos(radians)
        let sine = sin(radians)
        return simd_float4x4(columns: (
            SIMD4<Float>(cosine, 0, -sine, 0),
            SIMD4<Float>(0, 1, 0, 0),
            SIMD4<Float>(sine, 0, cosine, 0),
            SIMD4<Float>(0, 0, 0, 1)
        ))
    }
}

/** Native Google Cardboard panorama viewer for iOS. */
final class CardboardPanoramaViewController: UIViewController {
    /// Requests host orientation restoration before the native screen closes.
    var onWillDismiss: (() -> Void)?
    /// Releases plugin ownership after every native resource is gone.
    var onDismiss: (() -> Void)?

    private let panoramaURL: URL
    private let panoramaTitle: String
    private let metalView: MTKView
    private let panoramaRenderer: CardboardMetalPanoramaRenderer
    private let alignmentMarker = UIView()
    private let statusLabel = UILabel()
    private var notificationTokens: [NSObjectProtocol] = []
    private var previousIdleTimerDisabled: Bool?
    private var previousScreenBrightness: CGFloat?
    private var orientationRetryWorkItem: DispatchWorkItem?
    private var closing = false
    private var willDismissNotified = false
    private var lifecycleFinished = false
    private var setupPromptScheduled = false
    private var fatalFailureScheduled = false

    private lazy var closeButton: UIButton = makeControlButton(
        systemName: "xmark",
        accessibilityLabel: "Close Cardboard view",
        action: #selector(closeViewer)
    )
    private lazy var settingsButton: UIButton = makeControlButton(
        systemName: "gearshape",
        accessibilityLabel: "Scan Cardboard headset QR code",
        action: #selector(scanViewerProfile)
    )

    /// Creates the calibrated Metal pipeline before presentation can begin.
    init(
        panoramaURL: URL,
        title: String,
        initialYawDegrees: Float,
        initialPitchDegrees: Float
    ) throws {
        // Cardboard's bundled physical-screen table is calibrated for iPhone.
        // On iPad the SDK falls back to an incorrect phone DPI, so native VR is
        // unavailable there instead of presenting a distorted optical view.
        guard UIDevice.current.userInterfaceIdiom == .phone else {
            throw CardboardNativeViewerError.cardboardUnavailable
        }
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw CardboardNativeViewerError.metalUnavailable
        }
        let pixelFormat = MTLPixelFormat.bgra8Unorm
        guard let session = BubbleCardboardSession(
            device: device,
            colorPixelFormat: pixelFormat
        ) else {
            throw CardboardNativeViewerError.cardboardUnavailable
        }
        let renderer = try CardboardMetalPanoramaRenderer(
            device: device,
            colorPixelFormat: pixelFormat,
            cardboardSession: session,
            initialYawDegrees: initialYawDegrees,
            initialPitchDegrees: initialPitchDegrees
        )

        self.panoramaURL = panoramaURL
        panoramaTitle = title
        panoramaRenderer = renderer
        metalView = MTKView(frame: .zero, device: device)
        metalView.colorPixelFormat = pixelFormat
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    /// Storyboard construction is intentionally unavailable for this controller.
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        closing ? .portrait : .landscapeRight
    }

    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        closing ? .portrait : .landscapeRight
    }

    // The one-item supported mask still locks the headset handedness, while
    // allowing UIKit to complete the requested portrait-to-landscape turn.
    override var shouldAutorotate: Bool { true }
    override var prefersStatusBarHidden: Bool { true }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .fade }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    /// Installs rendering, controls, lifecycle observers, and texture loading.
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.accessibilityViewIsModal = true
        view.accessibilityLabel = "\(panoramaTitle), Cardboard panorama"

        configureMetalView()
        configureOverlay()
        observeApplicationLifecycle()
        panoramaRenderer.onFailure = { [weak self] message in
            self?.dismissAfterFatalFailure(message)
        }
        loadPanoramaTexture()
    }

    /// Preserves system display settings before applying headset-friendly values.
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if previousIdleTimerDisabled == nil {
            previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
        }
        if previousScreenBrightness == nil {
            previousScreenBrightness = UIScreen.main.brightness
        }
        UIApplication.shared.isIdleTimerDisabled = true
        UIScreen.main.brightness = 1
    }

    /// Defers optical calibration until the final landscape pixels are available.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        resumeRenderingWhenLandscapeIsReady()
        scheduleViewerSetupIfNeeded()
    }

    /// Pauses sensors and display refresh for dismissal or QR-scanner coverage.
    override func viewWillDisappear(_ animated: Bool) {
        pauseRendering()
        super.viewWillDisappear(animated)
    }

    /// Finishes ownership only for a real dismissal, not the SDK's QR scanner.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Google's QR scanner temporarily covers this controller. Do not tear
        // down the staged panorama merely because that scanner is on screen.
        if closing || isBeingDismissed || presentingViewController == nil {
            finishLifecycle()
        }
    }

    /// Removes the staged panorama if lifecycle teardown could not run first.
    deinit {
        try? FileManager.default.removeItem(at: panoramaURL)
    }

    /// Pins a native-resolution Metal surface across the full controller.
    private func configureMetalView() {
        metalView.translatesAutoresizingMaskIntoConstraints = false
        metalView.backgroundColor = .black
        metalView.clearColor = MTLClearColorMake(0, 0, 0, 1)
        metalView.framebufferOnly = true
        metalView.autoResizeDrawable = true
        // Lens calibration is based on physical pixels, not UIKit points.
        metalView.contentScaleFactor = UIScreen.main.nativeScale
        metalView.enableSetNeedsDisplay = false
        metalView.isPaused = true
        metalView.preferredFramesPerSecond = min(
            max(UIScreen.main.maximumFramesPerSecond, 60),
            120
        )
        metalView.delegate = panoramaRenderer
        view.addSubview(metalView)
        NSLayoutConstraint.activate([
            metalView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            metalView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            metalView.topAnchor.constraint(equalTo: view.topAnchor),
            metalView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    /// Adds only controls that remain useful before the phone enters the headset.
    private func configureOverlay() {
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        settingsButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(closeButton)
        view.addSubview(settingsButton)

        // This small physical-centre cue mirrors Cardboard's Android overlay.
        // It helps the user align the phone in the headset without drawing
        // fake, unwarped reticles over either eye.
        alignmentMarker.translatesAutoresizingMaskIntoConstraints = false
        alignmentMarker.backgroundColor = UIColor(white: 1, alpha: 0.84)
        alignmentMarker.layer.cornerRadius = 1
        alignmentMarker.isUserInteractionEnabled = false
        view.addSubview(alignmentMarker)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.textColor = UIColor(white: 1, alpha: 0.9)
        statusLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        statusLabel.alpha = 0
        statusLabel.accessibilityTraits = .staticText
        view.addSubview(statusLabel)

        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.leadingAnchor,
                constant: 16
            ),
            closeButton.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor,
                constant: 10
            ),
            closeButton.widthAnchor.constraint(equalToConstant: 48),
            closeButton.heightAnchor.constraint(equalToConstant: 48),

            settingsButton.trailingAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.trailingAnchor,
                constant: -16
            ),
            settingsButton.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor,
                constant: 10
            ),
            settingsButton.widthAnchor.constraint(equalToConstant: 48),
            settingsButton.heightAnchor.constraint(equalToConstant: 48),

            alignmentMarker.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            alignmentMarker.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            alignmentMarker.widthAnchor.constraint(equalToConstant: 2),
            alignmentMarker.heightAnchor.constraint(equalToConstant: 68),

            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.bottomAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.bottomAnchor,
                constant: -8
            ),
            statusLabel.widthAnchor.constraint(
                lessThanOrEqualTo: view.widthAnchor,
                multiplier: 0.42
            )
        ])
    }

    /// Builds one consistently styled and VoiceOver-labelled overlay control.
    private func makeControlButton(
        systemName: String,
        accessibilityLabel: String,
        action: Selector
    ) -> UIButton {
        let button = UIButton(type: .system)
        button.tintColor = .white
        button.backgroundColor = UIColor(white: 0, alpha: 0.62)
        button.layer.cornerRadius = 24
        button.layer.borderWidth = 1
        button.layer.borderColor = UIColor(white: 1, alpha: 0.22).cgColor
        button.setImage(
            UIImage(systemName: systemName)?.withConfiguration(
                UIImage.SymbolConfiguration(pointSize: 19, weight: .semibold)
            ),
            for: .normal
        )
        button.accessibilityLabel = accessibilityLabel
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    /// Loads the staged image and converts a decode failure into a clean dismissal.
    private func loadPanoramaTexture() {
        showStatus("Preparing \(panoramaTitle)")
        panoramaRenderer.loadPanorama(at: panoramaURL) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, !self.lifecycleFinished else { return }
                switch result {
                case .success:
                    UIView.animate(withDuration: 0.2) {
                        self.statusLabel.alpha = 0
                    }
                case .failure:
                    self.dismissAfterFatalFailure("This 360 image could not be opened.")
                }
            }
        }
    }

    /// Offers one headset-profile prompt when no saved QR calibration exists.
    private func scheduleViewerSetupIfNeeded() {
        guard !setupPromptScheduled,
              !fatalFailureScheduled,
              !BubbleCardboardSession.hasSavedViewerProfile() else {
            return
        }
        setupPromptScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self,
                  self.viewIfLoaded?.window != nil,
                  !self.closing,
                  !self.fatalFailureScheduled,
                  self.presentedViewController == nil else {
                return
            }
            let alert = UIAlertController(
                title: "Set up your VR headset",
                message: "Scan the QR code printed on your headset to match its lenses and prevent double vision. You only need to do this once.",
                preferredStyle: .alert
            )
            alert.addAction(
                UIAlertAction(title: "Scan headset QR", style: .default) { [weak self] _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        self?.openViewerScanner()
                    }
                }
            )
            alert.addAction(UIAlertAction(title: "Use standard viewer", style: .cancel))
            self.present(alert, animated: true)
        }
    }

    /// Mirrors Android's pause/resume behavior for app interruptions.
    private func observeApplicationLifecycle() {
        let center = NotificationCenter.default
        notificationTokens.append(
            center.addObserver(
                // Mirrors Android Activity.onPause for interruptions that make
                // the app inactive without necessarily backgrounding it.
                forName: UIApplication.willResignActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.pauseRendering()
            }
        )
        notificationTokens.append(
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self,
                      self.viewIfLoaded?.window != nil,
                      self.presentedViewController == nil,
                      !self.closing else {
                    return
                }
                self.resumeRenderingWhenLandscapeIsReady()
            }
        )
    }

    /// Waits for stable landscape geometry with a bounded retry window before
    /// starting sensors and the display link.
    private func resumeRenderingWhenLandscapeIsReady(attempt: Int = 0) {
        guard !closing, !lifecycleFinished else { return }
        orientationRetryWorkItem?.cancel()
        orientationRetryWorkItem = nil

        view.layoutIfNeeded()
        let interfaceOrientation = view.window?.windowScene?.interfaceOrientation
        let hasLandscapeGeometry = view.bounds.width > view.bounds.height
        guard interfaceOrientation == .landscapeRight, hasLandscapeGeometry else {
            // Scene geometry updates are asynchronous on modern iOS. Wait for
            // the fixed Cardboard orientation rather than calibrating optics
            // against a transient portrait drawable.
            guard attempt < 40 else {
                dismissAfterFatalFailure("Cardboard could not enter landscape on this phone.")
                return
            }
            let retry = DispatchWorkItem { [weak self] in
                self?.resumeRenderingWhenLandscapeIsReady(attempt: attempt + 1)
            }
            orientationRetryWorkItem = retry
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: retry)
            return
        }

        panoramaRenderer.resumeTracking()
        metalView.isPaused = false
    }

    /// Cancels orientation retries and pauses both display and sensor work.
    private func pauseRendering() {
        orientationRetryWorkItem?.cancel()
        orientationRetryWorkItem = nil
        metalView.isPaused = true
        panoramaRenderer.pauseTracking()
    }

    /// Displays and announces short setup or failure guidance.
    private func showStatus(_ message: String) {
        statusLabel.text = message
        statusLabel.alpha = 1
        statusLabel.accessibilityValue = message
    }

    /// Opens Google's scanner from the explicit settings control.
    @objc private func scanViewerProfile() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        openViewerScanner()
    }

    /// Starts the SDK-owned QR flow only while this controller is visible.
    private func openViewerScanner() {
        guard !closing, viewIfLoaded?.window != nil else { return }
        // The SDK presents its scanner asynchronously. UIKit's disappearance
        // callbacks pause a real scanner presentation; staying active here
        // prevents a denied or cancelled permission alert from freezing VR.
        BubbleCardboardSession.scanViewerProfile()
    }

    /// Announces one fatal renderer error and then returns to the unchanged app.
    private func dismissAfterFatalFailure(_ message: String) {
        guard !closing, !lifecycleFinished, !fatalFailureScheduled else { return }
        fatalFailureScheduled = true
        showStatus(message)
        UIAccessibility.post(notification: .announcement, argument: message)
        pauseRendering()

        // Android closes its VR Activity on a fatal renderer error. Briefly
        // expose the reason, then reveal the unchanged screen below on iOS too.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self, !self.closing, !self.lifecycleFinished else { return }
            self.closeViewer()
        }
    }

    /// Coordinates portrait restoration, a black cover, and one-shot dismissal.
    @objc private func closeViewer() {
        guard !closing else { return }
        closing = true
        pauseRendering()
        notifyWillDismiss()
        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }

        UIView.animate(withDuration: 0.12) { [weak self] in
            guard let self else { return }
            self.metalView.alpha = 0
            self.closeButton.alpha = 0
            self.settingsButton.alpha = 0
            self.alignmentMarker.alpha = 0
            self.statusLabel.alpha = 0
        }

        // Keep the black cover up while the Capacitor host restores portrait.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.24) { [weak self] in
            guard let self else { return }
            if self.presentingViewController != nil {
                self.dismiss(animated: false)
            } else {
                self.finishLifecycle()
            }
        }
    }

    /// Sends the host-orientation callback at most once.
    private func notifyWillDismiss() {
        guard !willDismissNotified else { return }
        willDismissNotified = true
        let completion = onWillDismiss
        onWillDismiss = nil
        completion?()
    }

    /// Releases observers, renderer state, display overrides, and the staged file.
    private func finishLifecycle() {
        guard !lifecycleFinished else { return }
        lifecycleFinished = true
        pauseRendering()
        panoramaRenderer.releaseResources()

        let center = NotificationCenter.default
        for token in notificationTokens { center.removeObserver(token) }
        notificationTokens.removeAll()

        if let previousIdleTimerDisabled {
            UIApplication.shared.isIdleTimerDisabled = previousIdleTimerDisabled
        }
        self.previousIdleTimerDisabled = nil
        if let previousScreenBrightness {
            UIScreen.main.brightness = previousScreenBrightness
        }
        self.previousScreenBrightness = nil
        try? FileManager.default.removeItem(at: panoramaURL)

        let completion = onDismiss
        onDismiss = nil
        completion?()
    }
}
