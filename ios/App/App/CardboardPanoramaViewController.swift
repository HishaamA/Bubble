import CoreMotion
import Metal
import MetalKit
import QuartzCore
import UIKit
import simd

private enum CardboardNativeViewerError: LocalizedError {
    case metalUnavailable
    case shaderUnavailable
    case pipelineCreationFailed(Error)
    case vertexBufferUnavailable

    var errorDescription: String? {
        switch self {
        case .metalUnavailable:
            return "Metal is unavailable on this device."
        case .shaderUnavailable:
            return "The Cardboard panorama shaders are unavailable."
        case .pipelineCreationFailed:
            return "The Cardboard panorama renderer could not be created."
        case .vertexBufferUnavailable:
            return "The Cardboard panorama geometry could not be created."
        }
    }
}

private enum CardboardLensLayout {
    static let widthFraction: CGFloat = 0.43
    static let heightFraction: CGFloat = 0.88
    static let horizontalFieldOfViewDegrees: Float = 88

    static func frames(in size: CGSize) -> [CGRect] {
        guard size.width > 1, size.height > 1 else { return [.zero, .zero] }

        let halfWidth = size.width / 2
        let horizontalInset = max(8, size.width * 0.018)
        let eyeWidth = min(size.width * widthFraction, halfWidth - horizontalInset * 2)
        let eyeHeight = min(size.height * heightFraction, size.height - 8)
        let eyeY = (size.height - eyeHeight) / 2
        let leftCenterX = size.width * 0.25
        let rightCenterX = size.width * 0.75

        return [
            CGRect(
                x: leftCenterX - eyeWidth / 2,
                y: eyeY,
                width: eyeWidth,
                height: eyeHeight
            ),
            CGRect(
                x: rightCenterX - eyeWidth / 2,
                y: eyeY,
                width: eyeWidth,
                height: eyeHeight
            )
        ]
    }
}

private final class CardboardMotionController {
    private let motionManager = CMMotionManager()
    private let motionQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "com.simerfamily.kinsphere.cardboard-motion"
        queue.qualityOfService = .userInteractive
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private let stateLock = NSLock()
    private let initialView: simd_quatf

    private var interfaceOrientation: UIInterfaceOrientation = .landscapeRight
    private var anchorDevicePose: simd_quatf?
    private var anchorView: simd_quatf
    private var latestDevicePose: simd_quatf?
    private var filteredView: simd_quatf
    private var previousRawPose: simd_quatf?
    private var previousTimestamp: TimeInterval?
    private var rebaseOnNextSample = true
    private var running = false

    init(initialYawDegrees: Float, initialPitchDegrees: Float) {
        let yaw = simd_quatf(
            angle: -initialYawDegrees * .pi / 180,
            axis: SIMD3<Float>(0, 1, 0)
        )
        let pitch = simd_quatf(
            angle: initialPitchDegrees * .pi / 180,
            axis: SIMD3<Float>(1, 0, 0)
        )
        initialView = Self.normalized(yaw * pitch)
        anchorView = initialView
        filteredView = initialView
    }

    var isAvailable: Bool {
        motionManager.isDeviceMotionAvailable
    }

    @discardableResult
    func start(interfaceOrientation: UIInterfaceOrientation) -> Bool {
        guard motionManager.isDeviceMotionAvailable else { return false }

        stateLock.lock()
        self.interfaceOrientation = Self.usableOrientation(interfaceOrientation)
        if running {
            stateLock.unlock()
            return true
        }
        running = true
        anchorView = filteredView
        anchorDevicePose = nil
        latestDevicePose = nil
        previousRawPose = nil
        previousTimestamp = nil
        rebaseOnNextSample = true
        stateLock.unlock()

        motionManager.deviceMotionUpdateInterval = 1.0 / 100.0
        motionManager.showsDeviceMovementDisplay = true
        motionManager.startDeviceMotionUpdates(
            using: .xArbitraryZVertical,
            to: motionQueue
        ) { [weak self] motion, _ in
            guard let self, let motion else { return }
            self.ingest(motion)
        }
        return true
    }

    func pause() {
        motionManager.stopDeviceMotionUpdates()
        stateLock.lock()
        running = false
        anchorView = filteredView
        anchorDevicePose = nil
        latestDevicePose = nil
        previousRawPose = nil
        previousTimestamp = nil
        rebaseOnNextSample = true
        stateLock.unlock()
    }

    func updateInterfaceOrientation(_ orientation: UIInterfaceOrientation) {
        stateLock.lock()
        let nextOrientation = Self.usableOrientation(orientation)
        if nextOrientation != interfaceOrientation {
            interfaceOrientation = nextOrientation
            anchorView = filteredView
            rebaseOnNextSample = true
        }
        stateLock.unlock()
    }

    func recenter() {
        stateLock.lock()
        filteredView = initialView
        anchorView = initialView
        anchorDevicePose = latestDevicePose
        previousRawPose = latestDevicePose
        previousTimestamp = nil
        rebaseOnNextSample = latestDevicePose == nil
        stateLock.unlock()
    }

    func currentPose() -> simd_quatf {
        stateLock.lock()
        let pose = filteredView
        stateLock.unlock()
        return pose
    }

    private func ingest(_ motion: CMDeviceMotion) {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard running else { return }

        let rawPose = Self.correctedPose(
            motion.attitude.quaternion,
            interfaceOrientation: interfaceOrientation
        )
        latestDevicePose = rawPose

        if anchorDevicePose == nil || rebaseOnNextSample {
            anchorDevicePose = rawPose
            anchorView = filteredView
            previousRawPose = rawPose
            previousTimestamp = motion.timestamp
            rebaseOnNextSample = false
            return
        }
        guard let anchorDevicePose else { return }

        let elapsed = previousTimestamp.map { motion.timestamp - $0 } ?? (1.0 / 60.0)
        let deltaTime = Float(min(max(elapsed, 1.0 / 240.0), 1.0 / 20.0))
        let worldDelta = Self.normalized(rawPose * anchorDevicePose.inverse)
        var target = Self.normalized(worldDelta * anchorView)
        if simd_dot(target.vector, filteredView.vector) < 0 {
            target = simd_quatf(vector: -target.vector)
        }

        let previousRawPose = self.previousRawPose ?? rawPose
        let rawDot = min(max(abs(simd_dot(previousRawPose.vector, rawPose.vector)), 0), 1)
        let rawDistance = 2 * acos(rawDot)
        let angularSpeed = rawDistance / max(deltaTime, 0.001)

        // Use more smoothing while the phone is nearly still and become more
        // responsive during a deliberate head turn. Both eyes consume this one
        // filtered quaternion from the same display frame.
        let motionWeight = min(max((angularSpeed - 0.03) / 0.55, 0), 1)
        let timeConstant = 0.030 + (0.008 - 0.030) * motionWeight
        let response = 1 - exp(-deltaTime / timeConstant)
        let targetDot = min(max(abs(simd_dot(filteredView.vector, target.vector)), 0), 1)
        let targetDistance = 2 * acos(targetDot)
        if targetDistance > 0.0012 {
            filteredView = Self.normalized(simd_slerp(filteredView, target, response))
        }

        self.previousRawPose = rawPose
        previousTimestamp = motion.timestamp
    }

    private static func correctedPose(
        _ quaternion: CMQuaternion,
        interfaceOrientation: UIInterfaceOrientation
    ) -> simd_quatf {
        let device = normalized(
            simd_quatf(
                ix: Float(quaternion.x),
                iy: Float(quaternion.y),
                iz: Float(quaternion.z),
                r: Float(quaternion.w)
            )
        )
        let cameraCorrection = simd_quatf(
            angle: -.pi / 2,
            axis: SIMD3<Float>(1, 0, 0)
        )
        let screenAngle: Float
        switch interfaceOrientation {
        case .landscapeLeft:
            screenAngle = .pi / 2
        case .landscapeRight:
            screenAngle = -.pi / 2
        case .portraitUpsideDown:
            screenAngle = .pi
        default:
            screenAngle = 0
        }
        let screenCorrection = simd_quatf(
            angle: -screenAngle,
            axis: SIMD3<Float>(0, 0, 1)
        )
        return normalized(device * cameraCorrection * screenCorrection)
    }

    private static func usableOrientation(
        _ orientation: UIInterfaceOrientation
    ) -> UIInterfaceOrientation {
        switch orientation {
        case .landscapeLeft, .landscapeRight, .portrait, .portraitUpsideDown:
            return orientation
        default:
            return .landscapeRight
        }
    }

    private static func normalized(_ quaternion: simd_quatf) -> simd_quatf {
        let length = simd_length(quaternion.vector)
        guard length.isFinite, length > 0.000_001 else {
            return simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))
        }
        return simd_quatf(vector: quaternion.vector / length)
    }
}

private struct CardboardMetalUniforms {
    var cameraRotation: simd_float3x3
    var tanHalfHorizontalFieldOfView: Float
    var eyeAspect: Float
    var opticalCenter: Float
    var padding: Float = 0
}

private final class CardboardMetalPanoramaRenderer: NSObject, MTKViewDelegate {
    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct VertexOutput {
        float4 position [[position]];
        float2 localPosition;
    };

    struct CardboardUniforms {
        float3x3 cameraRotation;
        float tanHalfHorizontalFieldOfView;
        float eyeAspect;
        float opticalCenter;
        float padding;
    };

    vertex VertexOutput cardboardVertex(
        uint vertexID [[vertex_id]],
        const device float2 *positions [[buffer(0)]]
    ) {
        VertexOutput output;
        float2 position = positions[vertexID];
        output.position = float4(position, 0.0, 1.0);
        output.localPosition = position;
        return output;
    }

    fragment float4 cardboardFragment(
        VertexOutput input [[stage_in]],
        constant CardboardUniforms &uniforms [[buffer(0)]],
        texture2d<float> panorama [[texture(0)]]
    ) {
        constexpr sampler panoramaSampler(
            filter::linear,
            s_address::repeat,
            t_address::clamp_to_edge
        );
        constexpr float pi = 3.14159265358979323846;

        // A rounded rectangle is used as a neutral Cardboard lens silhouette.
        // It deliberately avoids pretending to be a viewer-specific distortion
        // profile while still keeping the image away from the physical lens edge.
        float cornerRadius = 0.19;
        float2 rounded = abs(input.localPosition) - float2(1.0 - cornerRadius);
        float lensDistance = length(max(rounded, float2(0.0)))
            + min(max(rounded.x, rounded.y), 0.0)
            - cornerRadius;
        float lensMask = 1.0 - smoothstep(-0.012, 0.008, lensDistance);

        float2 centered = float2(
            input.localPosition.x - uniforms.opticalCenter,
            input.localPosition.y
        );
        float3 cameraRay = normalize(float3(
            centered.x * uniforms.tanHalfHorizontalFieldOfView,
            centered.y * uniforms.tanHalfHorizontalFieldOfView
                / max(uniforms.eyeAspect, 0.001),
            -1.0
        ));
        float3 worldRay = normalize(uniforms.cameraRotation * cameraRay);
        float yaw = atan2(worldRay.x, -worldRay.z);
        float pitch = asin(clamp(worldRay.y, -1.0, 1.0));
        float2 panoramaUV = float2(
            fract(0.5 + yaw / (2.0 * pi)),
            0.5 - pitch / pi
        );
        float3 color = panorama.sample(panoramaSampler, panoramaUV).rgb;
        float edgeShade = 1.0 - 0.22 * smoothstep(-0.16, 0.0, lensDistance);
        return float4(color * edgeShade * lensMask, 1.0);
    }
    """

    private let commandQueue: MTLCommandQueue
    private let pipelineState: MTLRenderPipelineState
    private let vertexBuffer: MTLBuffer
    private let textureLoader: MTKTextureLoader
    private let poseProvider: () -> simd_quatf
    private let textureLock = NSLock()
    private var panoramaTexture: MTLTexture?
    private var released = false

    init(
        device: MTLDevice,
        colorPixelFormat: MTLPixelFormat,
        poseProvider: @escaping () -> simd_quatf
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
        pipelineDescriptor.label = "Bubble Cardboard panorama"
        pipelineDescriptor.vertexFunction = vertexFunction
        pipelineDescriptor.fragmentFunction = fragmentFunction
        pipelineDescriptor.colorAttachments[0].pixelFormat = colorPixelFormat

        do {
            pipelineState = try device.makeRenderPipelineState(descriptor: pipelineDescriptor)
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

        self.commandQueue = commandQueue
        self.vertexBuffer = vertexBuffer
        textureLoader = MTKTextureLoader(device: device)
        self.poseProvider = poseProvider
        super.init()
    }

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
                self.textureLock.lock()
                if !self.released {
                    self.panoramaTexture = texture
                }
                let accepted = !self.released
                self.textureLock.unlock()
                if accepted {
                    completion(.success(()))
                }
                return
            }
            completion(.failure(error ?? CardboardNativeViewerError.shaderUnavailable))
        }
    }

    func releaseResources() {
        textureLock.lock()
        released = true
        panoramaTexture = nil
        textureLock.unlock()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard !released,
              let renderPassDescriptor = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(
                descriptor: renderPassDescriptor
              ) else {
            return
        }

        textureLock.lock()
        let texture = panoramaTexture
        textureLock.unlock()

        if let texture {
            // Read the pose exactly once. Both eye draws below therefore use the
            // same sensor sample and the same command buffer.
            let sharedHeadPose = poseProvider()
            let sharedCameraRotation = simd_float3x3(sharedHeadPose)
            let eyeFrames = CardboardLensLayout.frames(in: view.drawableSize)
            let tangent = tan(
                CardboardLensLayout.horizontalFieldOfViewDegrees * .pi / 360
            )

            encoder.setRenderPipelineState(pipelineState)
            encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
            encoder.setFragmentTexture(texture, index: 0)

            for frame in eyeFrames where frame.width > 0 && frame.height > 0 {
                encoder.setViewport(
                    MTLViewport(
                        originX: Double(frame.minX),
                        originY: Double(frame.minY),
                        width: Double(frame.width),
                        height: Double(frame.height),
                        znear: 0,
                        zfar: 1
                    )
                )
                var uniforms = CardboardMetalUniforms(
                    cameraRotation: sharedCameraRotation,
                    tanHalfHorizontalFieldOfView: tangent,
                    eyeAspect: Float(frame.width / max(frame.height, 1)),
                    // The panorama is monoscopic. Matching optical centers keep
                    // both eyes on the same ray and avoid artificial disparity.
                    opticalCenter: 0
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
        }

        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }
}

private final class CardboardLensGuideView: UIView {
    override class var layerClass: AnyClass { CAShapeLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        let shapeLayer = layer as? CAShapeLayer
        shapeLayer?.fillColor = UIColor.clear.cgColor
        shapeLayer?.strokeColor = UIColor(white: 1, alpha: 0.16).cgColor
        shapeLayer?.lineWidth = 1
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let radius = min(bounds.width, bounds.height) * 0.095
        (layer as? CAShapeLayer)?.path = UIBezierPath(
            roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
            cornerRadius: radius
        ).cgPath
    }
}

private final class CardboardReticleView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        context.setStrokeColor(UIColor(white: 1, alpha: 0.84).cgColor)
        context.setLineWidth(1.2)
        context.strokeEllipse(
            in: CGRect(x: center.x - 5, y: center.y - 5, width: 10, height: 10)
        )
        context.move(to: CGPoint(x: center.x - 10, y: center.y))
        context.addLine(to: CGPoint(x: center.x - 7, y: center.y))
        context.move(to: CGPoint(x: center.x + 7, y: center.y))
        context.addLine(to: CGPoint(x: center.x + 10, y: center.y))
        context.move(to: CGPoint(x: center.x, y: center.y - 10))
        context.addLine(to: CGPoint(x: center.x, y: center.y - 7))
        context.move(to: CGPoint(x: center.x, y: center.y + 7))
        context.addLine(to: CGPoint(x: center.x, y: center.y + 10))
        context.strokePath()
    }
}

/** Native, monoscopic two-eye Cardboard panorama viewer for iOS. */
final class CardboardPanoramaViewController: UIViewController {
    var onWillDismiss: (() -> Void)?
    var onDismiss: (() -> Void)?

    private let panoramaURL: URL
    private let panoramaTitle: String
    private let metalView: MTKView
    private let motionController: CardboardMotionController
    private let panoramaRenderer: CardboardMetalPanoramaRenderer
    private let lensGuides = [CardboardLensGuideView(), CardboardLensGuideView()]
    private let reticles = [CardboardReticleView(), CardboardReticleView()]
    private let centerDivider = UIView()
    private let statusLabel = UILabel()
    private var notificationTokens: [NSObjectProtocol] = []
    private var previousIdleTimerDisabled: Bool?
    private var previousScreenBrightness: CGFloat?
    private weak var presentationScene: UIWindowScene?
    private var closing = false
    private var willDismissNotified = false
    private var lifecycleFinished = false

    private lazy var closeButton: UIButton = makeControlButton(
        systemName: "xmark",
        accessibilityLabel: "Close Cardboard view",
        action: #selector(closeViewer)
    )
    private lazy var recenterButton: UIButton = makeControlButton(
        systemName: "scope",
        accessibilityLabel: "Recenter Cardboard view",
        action: #selector(recenterViewer)
    )

    init(
        panoramaURL: URL,
        title: String,
        initialYawDegrees: Float,
        initialPitchDegrees: Float
    ) throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw CardboardNativeViewerError.metalUnavailable
        }
        let motionController = CardboardMotionController(
            initialYawDegrees: initialYawDegrees,
            initialPitchDegrees: initialPitchDegrees
        )
        let pixelFormat = MTLPixelFormat.bgra8Unorm
        let renderer = try CardboardMetalPanoramaRenderer(
            device: device,
            colorPixelFormat: pixelFormat,
            poseProvider: { [weak motionController] in
                motionController?.currentPose()
                    ?? simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))
            }
        )

        self.panoramaURL = panoramaURL
        panoramaTitle = title
        self.motionController = motionController
        panoramaRenderer = renderer
        metalView = MTKView(frame: .zero, device: device)
        metalView.colorPixelFormat = pixelFormat
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        closing ? .portrait : .landscape
    }

    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        closing ? .portrait : .landscapeRight
    }

    override var shouldAutorotate: Bool { true }
    override var prefersStatusBarHidden: Bool { true }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .fade }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.accessibilityViewIsModal = true
        view.accessibilityLabel = "\(panoramaTitle), Cardboard panorama"

        configureMetalView()
        configureOverlay()
        observeApplicationLifecycle()
        loadPanoramaTexture()
    }

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

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        presentationScene = view.window?.windowScene
        resumeRendering()
    }

    override func viewWillDisappear(_ animated: Bool) {
        pauseRendering()
        super.viewWillDisappear(animated)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        finishLifecycle()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let frames = CardboardLensLayout.frames(in: view.bounds.size)
        for index in 0..<min(frames.count, lensGuides.count) {
            lensGuides[index].frame = frames[index]
            let reticleSize = CGSize(width: 28, height: 28)
            reticles[index].frame = CGRect(
                x: frames[index].midX - reticleSize.width / 2,
                y: frames[index].midY - reticleSize.height / 2,
                width: reticleSize.width,
                height: reticleSize.height
            )
            reticles[index].setNeedsDisplay()
        }
    }

    override func viewWillTransition(
        to size: CGSize,
        with coordinator: UIViewControllerTransitionCoordinator
    ) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            guard let self else { return }
            self.motionController.updateInterfaceOrientation(
                self.currentInterfaceOrientation()
            )
        }
    }

    deinit {
        try? FileManager.default.removeItem(at: panoramaURL)
    }

    private func configureMetalView() {
        metalView.translatesAutoresizingMaskIntoConstraints = false
        metalView.backgroundColor = .black
        metalView.clearColor = MTLClearColorMake(0, 0, 0, 1)
        metalView.framebufferOnly = true
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

    private func configureOverlay() {
        for guide in lensGuides { view.addSubview(guide) }
        for reticle in reticles { view.addSubview(reticle) }

        centerDivider.translatesAutoresizingMaskIntoConstraints = false
        centerDivider.backgroundColor = UIColor(white: 1, alpha: 0.45)
        centerDivider.isUserInteractionEnabled = false
        view.addSubview(centerDivider)

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        recenterButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(closeButton)
        view.addSubview(recenterButton)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.textColor = UIColor(white: 1, alpha: 0.76)
        statusLabel.font = .systemFont(ofSize: 13, weight: .medium)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        statusLabel.alpha = 0
        statusLabel.accessibilityTraits = .staticText
        view.addSubview(statusLabel)

        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.leadingAnchor,
                constant: 18
            ),
            closeButton.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor,
                constant: 12
            ),
            closeButton.widthAnchor.constraint(equalToConstant: 48),
            closeButton.heightAnchor.constraint(equalToConstant: 48),

            recenterButton.trailingAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.trailingAnchor,
                constant: -18
            ),
            recenterButton.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor,
                constant: 12
            ),
            recenterButton.widthAnchor.constraint(equalToConstant: 48),
            recenterButton.heightAnchor.constraint(equalToConstant: 48),

            centerDivider.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            centerDivider.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            centerDivider.widthAnchor.constraint(equalToConstant: 1),
            centerDivider.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 0.78),

            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.bottomAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.bottomAnchor,
                constant: -8
            ),
            statusLabel.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.42)
        ])
    }

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

    private func loadPanoramaTexture() {
        statusLabel.text = "Preparing \(panoramaTitle)"
        statusLabel.alpha = 1
        panoramaRenderer.loadPanorama(at: panoramaURL) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, !self.lifecycleFinished else { return }
                switch result {
                case .success:
                    UIView.animate(withDuration: 0.2) {
                        self.statusLabel.alpha = 0
                    }
                case .failure:
                    self.statusLabel.text = "This 360 image could not be opened."
                    self.statusLabel.alpha = 1
                    self.pauseRendering()
                }
            }
        }
    }

    private func observeApplicationLifecycle() {
        let center = NotificationCenter.default
        notificationTokens.append(
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
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
                guard let self, self.viewIfLoaded?.window != nil, !self.closing else { return }
                self.resumeRendering()
            }
        )
    }

    private func resumeRendering() {
        guard !closing, !lifecycleFinished else { return }
        let motionStarted = motionController.start(
            interfaceOrientation: currentInterfaceOrientation()
        )
        metalView.isPaused = false
        if !motionStarted {
            statusLabel.text = "Motion tracking is unavailable on this phone."
            statusLabel.alpha = 1
        }
    }

    private func pauseRendering() {
        metalView.isPaused = true
        motionController.pause()
    }

    @objc private func recenterViewer() {
        motionController.recenter()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

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
            self.recenterButton.alpha = 0
            self.centerDivider.alpha = 0
            self.lensGuides.forEach { $0.alpha = 0 }
            self.reticles.forEach { $0.alpha = 0 }
        }

        // Let React return to the bubbles and UIKit restore portrait behind
        // this black cover before revealing the app again.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.24) { [weak self] in
            guard let self else { return }
            if self.presentingViewController != nil {
                self.dismiss(animated: false)
            } else {
                self.finishLifecycle()
            }
        }
    }

    private func notifyWillDismiss() {
        guard !willDismissNotified else { return }
        willDismissNotified = true
        let completion = onWillDismiss
        onWillDismiss = nil
        completion?()
    }

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

    private func currentInterfaceOrientation() -> UIInterfaceOrientation {
        view.window?.windowScene?.interfaceOrientation
            ?? presentationScene?.interfaceOrientation
            ?? .landscapeRight
    }

}
