import ARKit
import CoreImage
import ImageIO
import SceneKit
import UIKit
import simd

final class PanoramaCaptureViewController: UIViewController, ARSessionDelegate {
    var onCompletion: ((PanoramaCaptureOutcome) -> Void)?
    var captureDirectoryURL: URL { directoryURL }

    private struct CaptureTarget {
        let yaw: Float
        let pitch: Float
        let direction: SIMD3<Float>
        var isCaptured = false
    }

    private struct FrameSnapshot {
        let captureIndex: Int
        let targetIndex: Int
        let targetYaw: Float
        let targetPitch: Float
        let pixelBuffer: CVPixelBuffer
        let cameraTransform: simd_float4x4
        let cameraIntrinsics: simd_float3x3
        let calibrationResolution: CGSize
        let frameTimestamp: TimeInterval
        let capturedDate: Date
        let yaw: Float
        let pitch: Float
        let roll: Float
        let interfaceOrientation: UIInterfaceOrientation
        let sharpnessScore: Float
    }

    private enum CaptureFileError: LocalizedError {
        case jpegEncodingFailed

        var errorDescription: String? {
            switch self {
            case .jpegEncodingFailed:
                return "The AR camera frame could not be encoded as JPEG."
            }
        }
    }

    private let options: PanoramaCaptureOptions
    private let sessionId: String
    private let directoryURL: URL
    private let sceneView = ARSCNView(frame: .zero)
    private let targetFieldNode = SCNNode()
    private let stateQueue = DispatchQueue(label: "com.kinsphere.panorama.state", qos: .userInitiated)
    private let imageQueue = DispatchQueue(label: "com.kinsphere.panorama.image", qos: .userInitiated)
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let lifecycleLock = NSLock()
    private let orientationLock = NSLock()
    private let maximumCaptureOriginDistance: Float = 0.12
    private let autofocusSettlingDelay: TimeInterval = 0.22

    private let headerMaterial = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let cancelButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let progressLabel = UILabel()
    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let reticleView = UIView()
    private let steadyTrackLayer = CAShapeLayer()
    private let steadyProgressLayer = CAShapeLayer()
    private let guidanceMaterial = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let guidanceLabel = UILabel()
    private let directionArrowMaterial = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterialDark))
    private let directionArrowImageView = UIImageView()

    private var targets: [CaptureTarget] = []
    private var targetNodes: [SCNNode] = []
    private var capturedFrames: [[String: Any]] = []
    private var isSavingFrame = false
    private var captureCooldownUntil: TimeInterval = 0
    private var alignedTargetIndex: Int?
    private var steadyStartTimestamp: TimeInterval?
    private var previousCameraTransform: simd_float4x4?
    private var previousFrameTimestamp: TimeInterval?
    private var smoothedAngularSpeed = Float.greatestFiniteMagnitude
    private var smoothedLinearSpeed = Float.greatestFiniteMagnitude
    private var instantaneousAngularSpeed = Float.greatestFiniteMagnitude
    private var instantaneousLinearSpeed = Float.greatestFiniteMagnitude
    private var consecutiveUnsteadyFrames = 0
    private var steadyAnchorTransform: simd_float4x4?
    private var bestStableSnapshot: FrameSnapshot?
    private var bestStableSharpness = -Float.greatestFiniteMagnitude
    private var captureOriginPosition: SIMD3<Float>?
    private var lastGuidanceDirection: SIMD2<Float>?
    private var lastGuidanceTimestamp: TimeInterval = 0
    private var didEnd = false
    private var didStartSession = false
    private var previousIdleTimerState = false
    private var captureOrientation: UIInterfaceOrientation = .portrait
    private var isOrientationTransitioning = false
    private var targetFieldIsAnchored = false

    // Main-thread-only presentation state.
    private var displayedTargetIndex: Int?
    private var capturedTargetIndices = Set<Int>()
    private var displayedGuidanceDirection: CGVector?

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var shouldAutorotate: Bool { false }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    init(options: PanoramaCaptureOptions) throws {
        self.options = options
        sessionId = UUID().uuidString.lowercased()

        let cacheRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        directoryURL = cacheRoot
            .appendingPathComponent("PanoramaCaptures", isDirectory: true)
            .appendingPathComponent(sessionId, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)

        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        isModalInPresentation = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        configureScene()
        configureInterface()
        configureTargets()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !didStartSession else { return }
        didStartSession = true

        updateCaptureOrientation(
            view.window?.windowScene?.interfaceOrientation ?? .portrait,
            isTransitioning: false
        )
        previousIdleTimerState = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        runSession(resetTracking: true)
    }

    override func viewWillTransition(
        to size: CGSize,
        with coordinator: UIViewControllerTransitionCoordinator
    ) {
        updateCaptureOrientation(currentOrientationState().orientation, isTransitioning: true)
        super.viewWillTransition(to: size, with: coordinator)

        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            guard let self else { return }
            let orientation = self.view.window?.windowScene?.interfaceOrientation ?? .portrait
            self.updateCaptureOrientation(orientation, isTransitioning: false)
            self.stateQueue.async { [weak self] in
                self?.resetSteadiness()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sceneView.session.pause()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !hasEnded {
            complete(.cancelled)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let ringBounds = reticleView.bounds.insetBy(dx: 4, dy: 4)
        let path = UIBezierPath(ovalIn: ringBounds).cgPath
        steadyTrackLayer.frame = reticleView.bounds
        steadyTrackLayer.path = path
        steadyProgressLayer.frame = reticleView.bounds
        steadyProgressLayer.path = path
        positionDirectionArrow()
    }

    deinit {
        sceneView.session.pause()
    }

    private func configureScene() {
        view.backgroundColor = .black
        sceneView.translatesAutoresizingMaskIntoConstraints = false
        sceneView.scene = SCNScene()
        sceneView.scene.rootNode.addChildNode(targetFieldNode)
        sceneView.automaticallyUpdatesLighting = true
        sceneView.session.delegate = self
        sceneView.session.delegateQueue = stateQueue
        view.addSubview(sceneView)

        NSLayoutConstraint.activate([
            sceneView.topAnchor.constraint(equalTo: view.topAnchor),
            sceneView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sceneView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            sceneView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    private func configureInterface() {
        headerMaterial.translatesAutoresizingMaskIntoConstraints = false
        headerMaterial.layer.cornerRadius = 18
        headerMaterial.layer.cornerCurve = .continuous
        headerMaterial.clipsToBounds = true
        view.addSubview(headerMaterial)

        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.setTitleColor(.white, for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        cancelButton.accessibilityHint = "Stops the guided panorama capture"
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = "\(options.mode.displayName) Panorama"
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        titleLabel.textAlignment = .center

        progressLabel.translatesAutoresizingMaskIntoConstraints = false
        progressLabel.textColor = .white
        progressLabel.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        progressLabel.textAlignment = .right

        let headerContent = headerMaterial.contentView
        headerContent.addSubview(cancelButton)
        headerContent.addSubview(titleLabel)
        headerContent.addSubview(progressLabel)

        progressView.translatesAutoresizingMaskIntoConstraints = false
        progressView.progressTintColor = .white
        progressView.trackTintColor = UIColor.white.withAlphaComponent(0.22)
        progressView.layer.cornerRadius = 1.5
        progressView.clipsToBounds = true
        headerContent.addSubview(progressView)

        reticleView.translatesAutoresizingMaskIntoConstraints = false
        reticleView.isUserInteractionEnabled = false
        steadyTrackLayer.fillColor = UIColor.clear.cgColor
        steadyTrackLayer.strokeColor = UIColor.white.withAlphaComponent(0.35).cgColor
        steadyTrackLayer.lineWidth = 3
        steadyProgressLayer.fillColor = UIColor.clear.cgColor
        steadyProgressLayer.strokeColor = UIColor.white.cgColor
        steadyProgressLayer.lineWidth = 4
        steadyProgressLayer.lineCap = .round
        steadyProgressLayer.strokeEnd = 0
        steadyProgressLayer.transform = CATransform3DMakeRotation(-.pi / 2, 0, 0, 1)
        reticleView.layer.addSublayer(steadyTrackLayer)
        reticleView.layer.addSublayer(steadyProgressLayer)
        view.addSubview(reticleView)

        let centerDot = UIView()
        centerDot.translatesAutoresizingMaskIntoConstraints = false
        centerDot.backgroundColor = UIColor.white.withAlphaComponent(0.9)
        centerDot.layer.cornerRadius = 2
        reticleView.addSubview(centerDot)

        guidanceMaterial.translatesAutoresizingMaskIntoConstraints = false
        guidanceMaterial.layer.cornerRadius = 18
        guidanceMaterial.layer.cornerCurve = .continuous
        guidanceMaterial.clipsToBounds = true
        view.addSubview(guidanceMaterial)

        guidanceLabel.translatesAutoresizingMaskIntoConstraints = false
        guidanceLabel.text = "Move slowly to place a dot in the circle"
        guidanceLabel.textColor = .white
        guidanceLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        guidanceLabel.textAlignment = .center
        guidanceLabel.numberOfLines = 2
        guidanceMaterial.contentView.addSubview(guidanceLabel)

        directionArrowMaterial.frame = CGRect(x: 0, y: 0, width: 56, height: 56)
        directionArrowMaterial.layer.cornerRadius = 28
        directionArrowMaterial.layer.cornerCurve = .continuous
        directionArrowMaterial.layer.borderWidth = 1
        directionArrowMaterial.layer.borderColor = UIColor.white.withAlphaComponent(0.24).cgColor
        directionArrowMaterial.clipsToBounds = true
        directionArrowMaterial.isUserInteractionEnabled = false
        directionArrowMaterial.isAccessibilityElement = false
        directionArrowMaterial.accessibilityElementsHidden = true
        directionArrowMaterial.alpha = 0
        directionArrowMaterial.isHidden = true
        view.addSubview(directionArrowMaterial)

        directionArrowImageView.translatesAutoresizingMaskIntoConstraints = false
        directionArrowImageView.image = UIImage(
            systemName: "arrow.up",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 24, weight: .semibold)
        )
        directionArrowImageView.tintColor = UIColor(
            red: 0.88,
            green: 0.71,
            blue: 0.47,
            alpha: 1
        )
        directionArrowImageView.contentMode = .center
        directionArrowMaterial.contentView.addSubview(directionArrowImageView)

        NSLayoutConstraint.activate([
            headerMaterial.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            headerMaterial.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            headerMaterial.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -14),
            headerMaterial.heightAnchor.constraint(equalToConstant: 62),

            cancelButton.leadingAnchor.constraint(equalTo: headerContent.leadingAnchor, constant: 14),
            cancelButton.topAnchor.constraint(equalTo: headerContent.topAnchor, constant: 8),
            cancelButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 62),
            cancelButton.heightAnchor.constraint(equalToConstant: 36),

            titleLabel.centerXAnchor.constraint(equalTo: headerContent.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: cancelButton.centerYAnchor),
            titleLabel.leadingAnchor.constraint(greaterThanOrEqualTo: cancelButton.trailingAnchor, constant: 6),

            progressLabel.trailingAnchor.constraint(equalTo: headerContent.trailingAnchor, constant: -14),
            progressLabel.centerYAnchor.constraint(equalTo: cancelButton.centerYAnchor),
            progressLabel.leadingAnchor.constraint(greaterThanOrEqualTo: titleLabel.trailingAnchor, constant: 6),
            progressLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 56),

            progressView.leadingAnchor.constraint(equalTo: headerContent.leadingAnchor, constant: 14),
            progressView.trailingAnchor.constraint(equalTo: headerContent.trailingAnchor, constant: -14),
            progressView.bottomAnchor.constraint(equalTo: headerContent.bottomAnchor, constant: -9),
            progressView.heightAnchor.constraint(equalToConstant: 3),

            reticleView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            reticleView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            reticleView.widthAnchor.constraint(equalToConstant: 84),
            reticleView.heightAnchor.constraint(equalTo: reticleView.widthAnchor),

            centerDot.centerXAnchor.constraint(equalTo: reticleView.centerXAnchor),
            centerDot.centerYAnchor.constraint(equalTo: reticleView.centerYAnchor),
            centerDot.widthAnchor.constraint(equalToConstant: 4),
            centerDot.heightAnchor.constraint(equalTo: centerDot.widthAnchor),

            guidanceMaterial.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            guidanceMaterial.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
            guidanceMaterial.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            guidanceMaterial.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -22),

            guidanceLabel.topAnchor.constraint(equalTo: guidanceMaterial.contentView.topAnchor, constant: 13),
            guidanceLabel.leadingAnchor.constraint(equalTo: guidanceMaterial.contentView.leadingAnchor, constant: 20),
            guidanceLabel.trailingAnchor.constraint(equalTo: guidanceMaterial.contentView.trailingAnchor, constant: -20),
            guidanceLabel.bottomAnchor.constraint(equalTo: guidanceMaterial.contentView.bottomAnchor, constant: -13),
            guidanceLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 330),

            directionArrowImageView.centerXAnchor.constraint(equalTo: directionArrowMaterial.contentView.centerXAnchor),
            directionArrowImageView.centerYAnchor.constraint(equalTo: directionArrowMaterial.contentView.centerYAnchor),
            directionArrowImageView.widthAnchor.constraint(equalToConstant: 32),
            directionArrowImageView.heightAnchor.constraint(equalTo: directionArrowImageView.widthAnchor)
        ])
    }

    private func configureTargets() {
        // Keep the guides on a large, user-centred angular shell. Their capture
        // direction must not change when the phone translates a few centimetres;
        // the old three-metre world points could bunch together through parallax.
        let radius: Float = 8.0
        targets = Self.targetAngles(for: options.mode).map { yaw, pitch in
            let cosPitch = cos(pitch)
            let direction = SIMD3<Float>(
                sin(yaw) * cosPitch,
                sin(pitch),
                -cos(yaw) * cosPitch
            )

            let sphere = SCNSphere(radius: 0.11)
            sphere.segmentCount = 24
            let material = SCNMaterial()
            material.lightingModel = .constant
            material.diffuse.contents = UIColor.white.withAlphaComponent(0.92)
            material.emission.contents = UIColor.white.withAlphaComponent(0.35)
            sphere.materials = [material]

            let node = SCNNode(geometry: sphere)
            node.simdPosition = direction * (radius - 0.05)
            node.opacity = 0.78

            // A dark outer shell sits slightly behind the white target. This
            // reads as a crisp halo against both bright windows and dark rooms.
            let haloSphere = SCNSphere(radius: 0.18)
            haloSphere.segmentCount = 24
            let haloMaterial = SCNMaterial()
            haloMaterial.lightingModel = .constant
            haloMaterial.diffuse.contents = UIColor.black.withAlphaComponent(0.82)
            haloMaterial.emission.contents = UIColor.black.withAlphaComponent(0.64)
            haloSphere.materials = [haloMaterial]
            let haloNode = SCNNode(geometry: haloSphere)
            haloNode.simdPosition = direction * 0.08
            node.addChildNode(haloNode)

            targetFieldNode.addChildNode(node)
            targetNodes.append(node)

            return CaptureTarget(
                yaw: yaw,
                pitch: pitch,
                direction: direction
            )
        }

        progressLabel.text = "0 / \(targets.count)"
        progressView.progress = 0
    }

    private static func targetAngles(for mode: PanoramaCaptureOptions.Mode) -> [(Float, Float)] {
        // Rings are staggered so each frame owns a distinct spherical arc.
        // Standard intentionally totals 34 views and spans +82° through -82°:
        // one ceiling, 5/7/8/7/5 around the room, and one floor view.
        var degrees: [(yaw: Float, pitch: Float)] = [(0, 82)]

        func appendRing(pitch: Float, count: Int, offset: Float) {
            let step = 360 / Float(count)
            for index in 0..<count {
                degrees.append((offset + Float(index) * step, pitch))
            }
        }

        switch mode {
        case .quick:
            appendRing(pitch: 45, count: 4, offset: 45)
            appendRing(pitch: 0, count: 8, offset: 0)
            appendRing(pitch: -45, count: 4, offset: 45)
        case .standard:
            appendRing(pitch: 55, count: 5, offset: 36)
            appendRing(pitch: 27, count: 7, offset: 0)
            appendRing(pitch: 0, count: 8, offset: 22.5)
            appendRing(pitch: -27, count: 7, offset: 360 / 14)
            appendRing(pitch: -55, count: 5, offset: 0)
        case .detailed:
            appendRing(pitch: 60, count: 6, offset: 30)
            appendRing(pitch: 30, count: 10, offset: 0)
            appendRing(pitch: 0, count: 12, offset: 15)
            appendRing(pitch: -30, count: 10, offset: 0)
            appendRing(pitch: -60, count: 6, offset: 30)
        }

        degrees.append((0, -82))
        return degrees.map { (degreesToRadians($0.yaw), degreesToRadians($0.pitch)) }
    }

    private static func degreesToRadians(_ degrees: Float) -> Float {
        degrees * .pi / 180
    }

    private func runSession(resetTracking: Bool) {
        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.isLightEstimationEnabled = true
        configuration.isAutoFocusEnabled = true

        if let bestFormat = ARWorldTrackingConfiguration.supportedVideoFormats.max(by: { left, right in
            let leftPixels = left.imageResolution.width * left.imageResolution.height
            let rightPixels = right.imageResolution.width * right.imageResolution.height
            if leftPixels == rightPixels {
                return left.framesPerSecond < right.framesPerSecond
            }
            return leftPixels < rightPixels
        }) {
            configuration.videoFormat = bestFormat
        }

        let runOptions: ARSession.RunOptions = resetTracking ? [.resetTracking, .removeExistingAnchors] : []
        sceneView.session.run(configuration, options: runOptions)
    }

    // MARK: - AR session processing

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard !hasEnded else { return }

        let orientationState = currentOrientationState()
        let transform = simd_inverse(frame.camera.viewMatrix(for: orientationState.orientation))
        anchorTargetFieldIfNeeded(to: transform)
        let motionIsSteady = updateMotion(transform: transform, timestamp: frame.timestamp)
        let pivotDistance = distanceFromCaptureOrigin(to: transform)
        let trackingMessage = trackingMessage(for: frame.camera.trackingState)
        let trackingIsNormal: Bool
        if case .normal = frame.camera.trackingState {
            trackingIsNormal = true
        } else {
            trackingIsNormal = false
        }

        guard let candidate = closestUncapturedTarget(to: transform) else {
            publishGuidance(
                timestamp: frame.timestamp,
                targetIndex: nil,
                angularDistance: 0,
                steadyProgress: 0,
                trackingMessage: trackingMessage,
                trackingIsNormal: trackingIsNormal,
                direction: nil,
                pivotDistance: pivotDistance
            )
            return
        }

        var steadyProgress: Float = 0
        let isAligned = candidate.angle <= options.alignmentRadians
        let remainingTargetCount = targets.reduce(into: 0) { count, target in
            if !target.isCaptured { count += 1 }
        }
        let direction = remainingTargetCount <= 6 &&
            !isAligned &&
            pivotDistance <= maximumCaptureOriginDistance &&
            !orientationState.isTransitioning
            ? guidanceDirection(
                to: targets[candidate.index].direction,
                cameraTransform: transform
            )
            : nil
        if motionIsSteady {
            consecutiveUnsteadyFrames = 0
        } else {
            consecutiveUnsteadyFrames += 1
        }
        let canGraceBriefTremor = steadyStartTimestamp != nil &&
            consecutiveUnsteadyFrames <= 2
        let canCapture = trackingIsNormal &&
            isAligned &&
            (motionIsSteady || canGraceBriefTremor) &&
            !isSavingFrame &&
            !orientationState.isTransitioning &&
            pivotDistance <= maximumCaptureOriginDistance &&
            frame.timestamp >= captureCooldownUntil

        if canCapture {
            if alignedTargetIndex != candidate.index || steadyStartTimestamp == nil {
                startStableWindow(
                    targetIndex: candidate.index,
                    transform: transform,
                    timestamp: frame.timestamp
                )
            } else if motionIsSteady && !steadyWindowIsWithinBounds(transform) {
                // Slow drift can look "steady" frame-to-frame while still
                // creating parallax. Start a fresh hold around the new pose.
                startStableWindow(
                    targetIndex: candidate.index,
                    transform: transform,
                    timestamp: frame.timestamp
                )
            }

            if let steadyStartTimestamp {
                let elapsed = max(0, frame.timestamp - steadyStartTimestamp)
                steadyProgress = min(1, Float(elapsed / options.steadyDuration))
                if motionIsSteady, elapsed >= autofocusSettlingDelay {
                    // Give autofocus and auto-exposure a moment to settle, then
                    // keep the sharpest synchronized AR frame from the hold.
                    considerStableFrame(
                        frame: frame,
                        cameraTransform: transform,
                        interfaceOrientation: orientationState.orientation,
                        targetIndex: candidate.index
                    )
                }
                if motionIsSteady,
                   elapsed >= options.steadyDuration,
                   let snapshot = bestStableSnapshot {
                    beginCapture(
                        snapshot: snapshot,
                        targetIndex: candidate.index
                    )
                    steadyProgress = 0
                }
            }
        } else {
            alignedTargetIndex = isAligned ? candidate.index : nil
            steadyStartTimestamp = nil
            steadyAnchorTransform = nil
            bestStableSnapshot = nil
            bestStableSharpness = -Float.greatestFiniteMagnitude
            consecutiveUnsteadyFrames = 0
        }

        publishGuidance(
            timestamp: frame.timestamp,
            targetIndex: candidate.index,
            angularDistance: candidate.angle,
            steadyProgress: steadyProgress,
            trackingMessage: trackingMessage,
            trackingIsNormal: trackingIsNormal,
            direction: direction,
            pivotDistance: pivotDistance
        )
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            self?.complete(.failure(
                message: "The AR capture session stopped: \(error.localizedDescription)",
                code: "CAPTURE_FAILED"
            ))
        }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        DispatchQueue.main.async { [weak self] in
            self?.guidanceLabel.text = "Capture paused"
            self?.steadyProgressLayer.strokeEnd = 0
            self?.updateDirectionArrow(nil, isVisible: false)
        }
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        // Resetting ARKit establishes a new world coordinate frame. Mixing
        // frames captured before and after that reset creates a torn sphere,
        // so require a clean retake once any image has already been accepted.
        guard capturedFrames.isEmpty else {
            DispatchQueue.main.async { [weak self] in
                self?.complete(.failure(
                    message: "The camera session was interrupted. Retake the panorama so every view stays aligned.",
                    code: "CAPTURE_INTERRUPTED_RESTART_REQUIRED"
                ))
            }
            return
        }

        targetFieldIsAnchored = false
        captureOriginPosition = nil
        resetSteadiness()

        DispatchQueue.main.async { [weak self] in
            self?.targetFieldNode.simdPosition = .zero
            self?.guidanceLabel.text = "Move slowly to resume"
            self?.runSession(resetTracking: true)
        }
    }

    private func anchorTargetFieldIfNeeded(to cameraTransform: simd_float4x4) {
        guard !targetFieldIsAnchored else { return }
        targetFieldIsAnchored = true
        let cameraPosition = SIMD3<Float>(
            cameraTransform.columns.3.x,
            cameraTransform.columns.3.y,
            cameraTransform.columns.3.z
        )
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.hasEnded else { return }
            self.targetFieldNode.simdPosition = cameraPosition
        }
    }

    private func anchorCaptureOriginIfNeeded(to cameraTransform: simd_float4x4) {
        guard captureOriginPosition == nil else { return }
        captureOriginPosition = SIMD3<Float>(
            cameraTransform.columns.3.x,
            cameraTransform.columns.3.y,
            cameraTransform.columns.3.z
        )
    }

    private func closestUncapturedTarget(to cameraTransform: simd_float4x4) -> (index: Int, angle: Float)? {
        let forward = simd_normalize(SIMD3<Float>(
            -cameraTransform.columns.2.x,
            -cameraTransform.columns.2.y,
            -cameraTransform.columns.2.z
        ))

        var closestIndex: Int?
        var closestAngle = Float.greatestFiniteMagnitude

        for (index, target) in targets.enumerated() where !target.isCaptured {
            let cosine = min(max(simd_dot(forward, target.direction), -1), 1)
            let angle = acos(cosine)
            if angle < closestAngle {
                closestAngle = angle
                closestIndex = index
            }
        }

        guard let closestIndex else { return nil }
        return (closestIndex, closestAngle)
    }

    private func updateMotion(transform: simd_float4x4, timestamp: TimeInterval) -> Bool {
        defer {
            previousCameraTransform = transform
            previousFrameTimestamp = timestamp
        }

        guard let previousTransform = previousCameraTransform,
              let previousTimestamp = previousFrameTimestamp else {
            return false
        }

        let deltaTime = timestamp - previousTimestamp
        guard deltaTime > 0.000_1, deltaTime < 0.25 else {
            smoothedAngularSpeed = .greatestFiniteMagnitude
            smoothedLinearSpeed = .greatestFiniteMagnitude
            instantaneousAngularSpeed = .greatestFiniteMagnitude
            instantaneousLinearSpeed = .greatestFiniteMagnitude
            return false
        }

        let previousRotation = rotationQuaternion(from: previousTransform)
        let currentRotation = rotationQuaternion(from: transform)
        let quaternionDot = min(max(abs(simd_dot(previousRotation.vector, currentRotation.vector)), 0), 1)
        let angularDelta = 2 * acos(Double(quaternionDot))
        let angularSpeed = Float(angularDelta / deltaTime)

        let previousPosition = SIMD3<Float>(
            previousTransform.columns.3.x,
            previousTransform.columns.3.y,
            previousTransform.columns.3.z
        )
        let currentPosition = SIMD3<Float>(
            transform.columns.3.x,
            transform.columns.3.y,
            transform.columns.3.z
        )
        let linearSpeed = simd_distance(previousPosition, currentPosition) / Float(deltaTime)
        instantaneousAngularSpeed = angularSpeed
        instantaneousLinearSpeed = linearSpeed

        let hasHardSpike = angularSpeed >= 0.18 || linearSpeed >= 0.12
        if !hasHardSpike {
            if smoothedAngularSpeed.isFinite {
                smoothedAngularSpeed = 0.78 * smoothedAngularSpeed + 0.22 * angularSpeed
                smoothedLinearSpeed = 0.78 * smoothedLinearSpeed + 0.22 * linearSpeed
            } else {
                smoothedAngularSpeed = angularSpeed
                smoothedLinearSpeed = linearSpeed
            }
        }

        // A raw ceiling catches shutter jolts without letting one noisy pose
        // poison the moving average. The session gives two frames of grace so
        // ordinary hand tremor does not restart the whole hold.
        return !hasHardSpike &&
            instantaneousAngularSpeed < 0.11 &&
            instantaneousLinearSpeed < 0.065 &&
            smoothedAngularSpeed < 0.12 &&
            smoothedLinearSpeed < 0.08
    }

    private func distanceFromCaptureOrigin(to transform: simd_float4x4) -> Float {
        guard let captureOriginPosition else { return 0 }
        let currentPosition = SIMD3<Float>(
            transform.columns.3.x,
            transform.columns.3.y,
            transform.columns.3.z
        )
        return simd_distance(captureOriginPosition, currentPosition)
    }

    private func guidanceDirection(
        to targetDirection: SIMD3<Float>,
        cameraTransform: simd_float4x4
    ) -> SIMD2<Float> {
        let cameraRight = simd_normalize(SIMD3<Float>(
            cameraTransform.columns.0.x,
            cameraTransform.columns.0.y,
            cameraTransform.columns.0.z
        ))
        let cameraUp = simd_normalize(SIMD3<Float>(
            cameraTransform.columns.1.x,
            cameraTransform.columns.1.y,
            cameraTransform.columns.1.z
        ))
        let cameraForward = simd_normalize(SIMD3<Float>(
            -cameraTransform.columns.2.x,
            -cameraTransform.columns.2.y,
            -cameraTransform.columns.2.z
        ))

        let right = simd_dot(targetDirection, cameraRight)
        let up = simd_dot(targetDirection, cameraUp)
        let forward = simd_dot(targetDirection, cameraForward)
        let horizontalBearing = atan2(right, forward)
        let verticalBearing = atan2(up, hypot(right, forward))
        var screenDirection = SIMD2<Float>(horizontalBearing, -verticalBearing)

        if simd_length_squared(screenDirection) < 0.000_001 {
            screenDirection = lastGuidanceDirection ?? SIMD2<Float>(1, 0)
        } else {
            screenDirection = simd_normalize(screenDirection)
        }
        lastGuidanceDirection = screenDirection
        return screenDirection
    }

    private func startStableWindow(
        targetIndex: Int,
        transform: simd_float4x4,
        timestamp: TimeInterval
    ) {
        // The user's first aligned hold defines the optical pivot. Anchoring at
        // session startup would incorrectly use the phone's lower/resting
        // position before it has been raised to capture height.
        anchorCaptureOriginIfNeeded(to: transform)
        alignedTargetIndex = targetIndex
        steadyStartTimestamp = timestamp
        steadyAnchorTransform = transform
        bestStableSnapshot = nil
        bestStableSharpness = -Float.greatestFiniteMagnitude
    }

    private func steadyWindowIsWithinBounds(_ transform: simd_float4x4) -> Bool {
        guard let steadyAnchorTransform else { return true }
        let anchorRotation = rotationQuaternion(from: steadyAnchorTransform)
        let currentRotation = rotationQuaternion(from: transform)
        let quaternionDot = min(
            max(abs(simd_dot(anchorRotation.vector, currentRotation.vector)), 0),
            1
        )
        let angularDrift = Float(2 * acos(Double(quaternionDot)))
        let anchorPosition = SIMD3<Float>(
            steadyAnchorTransform.columns.3.x,
            steadyAnchorTransform.columns.3.y,
            steadyAnchorTransform.columns.3.z
        )
        let currentPosition = SIMD3<Float>(
            transform.columns.3.x,
            transform.columns.3.y,
            transform.columns.3.z
        )
        let linearDrift = simd_distance(anchorPosition, currentPosition)
        return angularDrift <= 0.052 && linearDrift <= 0.03
    }

    private func considerStableFrame(
        frame: ARFrame,
        cameraTransform: simd_float4x4,
        interfaceOrientation: UIInterfaceOrientation,
        targetIndex: Int
    ) {
        let sharpness = lumaSharpnessScore(frame.capturedImage)
        guard sharpness > bestStableSharpness else { return }
        bestStableSharpness = sharpness
        bestStableSnapshot = makeSnapshot(
            frame: frame,
            cameraTransform: cameraTransform,
            interfaceOrientation: interfaceOrientation,
            targetIndex: targetIndex,
            sharpnessScore: sharpness
        )
    }

    private func makeSnapshot(
        frame: ARFrame,
        cameraTransform: simd_float4x4,
        interfaceOrientation: UIInterfaceOrientation,
        targetIndex: Int,
        sharpnessScore: Float
    ) -> FrameSnapshot {
        let forward = simd_normalize(SIMD3<Float>(
            -cameraTransform.columns.2.x,
            -cameraTransform.columns.2.y,
            -cameraTransform.columns.2.z
        ))
        let yaw = atan2(forward.x, -forward.z)
        let pitch = asin(min(max(forward.y, -1), 1))
        let roll = cameraRoll(
            transform: cameraTransform,
            yaw: yaw,
            pitch: pitch
        )
        let target = targets[targetIndex]

        return FrameSnapshot(
            captureIndex: capturedFrames.count,
            targetIndex: targetIndex,
            targetYaw: target.yaw,
            targetPitch: target.pitch,
            pixelBuffer: frame.capturedImage,
            cameraTransform: cameraTransform,
            cameraIntrinsics: frame.camera.intrinsics,
            calibrationResolution: frame.camera.imageResolution,
            frameTimestamp: frame.timestamp,
            capturedDate: Date(),
            yaw: yaw,
            pitch: pitch,
            roll: roll,
            interfaceOrientation: interfaceOrientation,
            sharpnessScore: sharpnessScore
        )
    }

    private func lumaSharpnessScore(_ pixelBuffer: CVPixelBuffer) -> Float {
        guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else {
            return 0
        }
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let planeCount = CVPixelBufferGetPlaneCount(pixelBuffer)
        guard planeCount > 0,
              let baseAddress = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else {
            return 0
        }

        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let step = max(4, min(width, height) / 180)
        guard width > step * 2, height > step * 2 else { return 0 }

        let bytes = baseAddress.assumingMemoryBound(to: UInt8.self)
        var edgeEnergy: UInt64 = 0
        var sampleCount: UInt64 = 0
        for y in stride(from: step, to: height - step, by: step) {
            let row = bytes.advanced(by: y * bytesPerRow)
            let upper = bytes.advanced(by: (y - 1) * bytesPerRow)
            let lower = bytes.advanced(by: (y + 1) * bytesPerRow)
            for x in stride(from: step, to: width - step, by: step) {
                let centre = Int(row[x])
                let horizontal = abs(centre * 2 - Int(row[x - 1]) - Int(row[x + 1]))
                let vertical = abs(centre * 2 - Int(upper[x]) - Int(lower[x]))
                edgeEnergy += UInt64(horizontal + vertical)
                sampleCount += 1
            }
        }
        guard sampleCount > 0 else { return 0 }
        return Float(edgeEnergy) / Float(sampleCount)
    }

    private func beginCapture(
        snapshot: FrameSnapshot,
        targetIndex: Int
    ) {
        guard !isSavingFrame, !targets[targetIndex].isCaptured else { return }

        isSavingFrame = true
        steadyStartTimestamp = nil
        alignedTargetIndex = nil
        captureCooldownUntil = snapshot.frameTimestamp + 0.45
        steadyAnchorTransform = nil
        bestStableSnapshot = nil
        bestStableSharpness = -Float.greatestFiniteMagnitude

        imageQueue.async { [weak self] in
            guard let self, !self.hasEnded else { return }

            do {
                let encodedFrame = try self.encode(snapshot: snapshot)
                self.stateQueue.async { [weak self] in
                    self?.finishSaving(encodedFrame, targetIndex: targetIndex)
                }
            } catch {
                DispatchQueue.main.async { [weak self] in
                    self?.complete(.failure(
                        message: "A panorama frame could not be saved: \(error.localizedDescription)",
                        code: "CAPTURE_FAILED"
                    ))
                }
            }
        }
    }

    private func finishSaving(_ encodedFrame: [String: Any], targetIndex: Int) {
        guard !hasEnded else { return }

        capturedFrames.append(encodedFrame)
        targets[targetIndex].isCaptured = true
        isSavingFrame = false

        let capturedCount = capturedFrames.count
        let targetCount = targets.count
        let progress = Float(capturedCount) / Float(targetCount)

        DispatchQueue.main.async { [weak self] in
            guard let self, !self.hasEnded else { return }
            self.markTargetCaptured(targetIndex)
            self.progressLabel.text = "\(capturedCount) / \(targetCount)"
            self.progressView.setProgress(progress, animated: true)
            self.steadyProgressLayer.strokeEnd = 0
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            UIAccessibility.post(
                notification: .announcement,
                argument: "Captured \(capturedCount) of \(targetCount)"
            )
        }

        guard capturedCount == targetCount else { return }

        let result: [String: Any] = [
            "sessionId": sessionId,
            "mode": options.mode.rawValue,
            "directoryUrl": directoryURL.absoluteString,
            "targetCount": targetCount,
            "capturedCount": capturedCount,
            "requiresStitching": true,
            "frames": capturedFrames
        ]

        DispatchQueue.main.async { [weak self] in
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            self?.complete(.success(result))
        }
    }

    private func encode(snapshot: FrameSnapshot) throws -> [String: Any] {
        let sensorWidth = CVPixelBufferGetWidth(snapshot.pixelBuffer)
        let sensorHeight = CVPixelBufferGetHeight(snapshot.pixelBuffer)
        let exifOrientation = imageOrientation(for: snapshot.interfaceOrientation)
        let sourceImage = CIImage(cvPixelBuffer: snapshot.pixelBuffer).oriented(exifOrientation)
        let normalizedImage = sourceImage.transformed(by: CGAffineTransform(
            translationX: -sourceImage.extent.minX,
            y: -sourceImage.extent.minY
        ))
        let orientedWidth = max(1, Int(normalizedImage.extent.width.rounded()))
        let orientedHeight = max(1, Int(normalizedImage.extent.height.rounded()))
        let requestedWidth = options.outputWidth > 0 ? min(options.outputWidth, orientedWidth) : orientedWidth
        let scale = CGFloat(requestedWidth) / CGFloat(orientedWidth)
        let outputHeight = max(1, Int((CGFloat(orientedHeight) * scale).rounded()))

        let scaledImage = normalizedImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let outputImage = scaledImage.cropped(to: CGRect(
            x: 0,
            y: 0,
            width: CGFloat(requestedWidth),
            height: CGFloat(outputHeight)
        ))
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let qualityKey = CIImageRepresentationOption(
            rawValue: kCGImageDestinationLossyCompressionQuality as String
        )

        guard let jpegData = ciContext.jpegRepresentation(
            of: outputImage,
            colorSpace: colorSpace,
            options: [qualityKey: options.jpegQuality]
        ) else {
            throw CaptureFileError.jpegEncodingFailed
        }

        let fileURL = directoryURL.appendingPathComponent(
            String(format: "frame_%03d.jpg", snapshot.captureIndex),
            isDirectory: false
        )
        try jpegData.write(to: fileURL, options: .atomic)

        let displayCalibration = adjustedIntrinsics(
            snapshot.cameraIntrinsics,
            calibrationResolution: snapshot.calibrationResolution,
            sensorWidth: sensorWidth,
            sensorHeight: sensorHeight,
            orientation: exifOrientation,
            outputWidth: requestedWidth,
            outputHeight: outputHeight
        )
        let transform = snapshot.cameraTransform
        let quaternion = rotationQuaternion(from: transform)
        let timestampMilliseconds = Int64((snapshot.capturedDate.timeIntervalSince1970 * 1_000).rounded())
        let yawDegrees = Double(radiansToDegrees(snapshot.yaw))
        let pitchDegrees = Double(radiansToDegrees(snapshot.pitch))
        let rollDegrees = Double(radiansToDegrees(snapshot.roll))
        let targetYawDegrees = Double(normalizedDegrees(radiansToDegrees(snapshot.targetYaw)))
        let targetPitchDegrees = Double(radiansToDegrees(snapshot.targetPitch))
        let horizontalFovDegrees = fieldOfViewDegrees(
            focalLength: displayCalibration.fx,
            principalPoint: displayCalibration.cx,
            pixelCount: requestedWidth
        )
        let verticalFovDegrees = fieldOfViewDegrees(
            focalLength: displayCalibration.fy,
            principalPoint: displayCalibration.cy,
            pixelCount: outputHeight
        )

        return [
            "index": snapshot.captureIndex,
            "targetIndex": snapshot.targetIndex,
            "uri": fileURL.absoluteString,
            "path": fileURL.path,
            "width": requestedWidth,
            "height": outputHeight,
            "timestamp": timestampMilliseconds,
            "capturedAt": Self.isoTimestamp(from: snapshot.capturedDate),
            "frameTimestamp": snapshot.frameTimestamp,
            "yaw": yawDegrees,
            "pitch": pitchDegrees,
            "roll": rollDegrees,
            "yawDegrees": yawDegrees,
            "pitchDegrees": pitchDegrees,
            "rollDegrees": rollDegrees,
            "targetYaw": targetYawDegrees,
            "targetPitch": targetPitchDegrees,
            "targetYawDegrees": targetYawDegrees,
            "targetPitchDegrees": targetPitchDegrees,
            "horizontalFovDegrees": horizontalFovDegrees,
            "verticalFovDegrees": verticalFovDegrees,
            "rotationDegrees": 0,
            "position": [
                "x": Double(transform.columns.3.x),
                "y": Double(transform.columns.3.y),
                "z": Double(transform.columns.3.z)
            ],
            "quaternion": [
                "x": Double(quaternion.imag.x),
                "y": Double(quaternion.imag.y),
                "z": Double(quaternion.imag.z),
                "w": Double(quaternion.real)
            ],
            "transform": flatten(transform),
            "intrinsics": [
                displayCalibration.fx,
                0,
                displayCalibration.cx,
                0,
                displayCalibration.fy,
                displayCalibration.cy,
                0,
                0,
                1
            ],
            "imageOrientation": "up",
            "captureInterfaceOrientation": interfaceOrientationName(snapshot.interfaceOrientation),
            "trackingState": "normal",
            "sharpnessScore": Double(snapshot.sharpnessScore)
        ]
    }

    private func publishGuidance(
        timestamp: TimeInterval,
        targetIndex: Int?,
        angularDistance: Float,
        steadyProgress: Float,
        trackingMessage: String,
        trackingIsNormal: Bool,
        direction: SIMD2<Float>?,
        pivotDistance: Float
    ) {
        guard timestamp - lastGuidanceTimestamp >= 1.0 / 20.0 else { return }
        lastGuidanceTimestamp = timestamp

        DispatchQueue.main.async { [weak self] in
            guard let self, !self.hasEnded else { return }
            let isAligned = angularDistance <= self.options.alignmentRadians
            self.updateDisplayedTarget(targetIndex, isAligned: isAligned)
            self.steadyProgressLayer.strokeEnd = CGFloat(steadyProgress)
            self.updateDirectionArrow(
                direction,
                isVisible: trackingIsNormal && !isAligned && direction != nil
            )

            if !trackingIsNormal {
                self.guidanceLabel.text = trackingMessage
            } else if targetIndex == nil {
                self.guidanceLabel.text = "Capture complete"
            } else if pivotDistance > self.maximumCaptureOriginDistance {
                self.guidanceLabel.text = "Move the iPhone back to the starting point"
            } else if !isAligned {
                self.guidanceLabel.text = direction == nil
                    ? "Move a dot into the circle"
                    : "Follow the arrow to the next dot"
            } else if steadyProgress > 0 {
                self.guidanceLabel.text = "Hold still"
            } else {
                self.guidanceLabel.text = "Steady your iPhone"
            }
        }
    }

    private func updateDirectionArrow(
        _ direction: SIMD2<Float>?,
        isVisible: Bool
    ) {
        dispatchPrecondition(condition: .onQueue(.main))

        guard isVisible, let direction else {
            displayedGuidanceDirection = nil
            directionArrowMaterial.layer.removeAllAnimations()
            guard !directionArrowMaterial.isHidden else { return }
            UIView.animate(
                withDuration: 0.14,
                delay: 0,
                options: [.beginFromCurrentState, .allowUserInteraction]
            ) { [weak self] in
                self?.directionArrowMaterial.alpha = 0
            } completion: { [weak self] _ in
                guard let self, self.displayedGuidanceDirection == nil else { return }
                self.directionArrowMaterial.isHidden = true
            }
            return
        }

        displayedGuidanceDirection = CGVector(
            dx: CGFloat(direction.x),
            dy: CGFloat(direction.y)
        )
        positionDirectionArrow()
        directionArrowMaterial.layer.removeAllAnimations()
        if directionArrowMaterial.isHidden {
            directionArrowMaterial.isHidden = false
            directionArrowMaterial.alpha = 0
        }
        UIView.animate(
            withDuration: 0.14,
            delay: 0,
            options: [.beginFromCurrentState, .allowUserInteraction]
        ) { [weak self] in
            self?.directionArrowMaterial.alpha = 1
        }
    }

    private func positionDirectionArrow() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let direction = displayedGuidanceDirection,
              view.bounds.width > 0,
              view.bounds.height > 0 else { return }

        let length = max(0.000_1, hypot(direction.dx, direction.dy))
        let dx = direction.dx / length
        let dy = direction.dy / length
        let arrowRadius: CGFloat = 28
        let spacing: CGFloat = 14
        let safeFrame = view.safeAreaLayoutGuide.layoutFrame
        var minX = safeFrame.minX + arrowRadius + spacing
        var maxX = safeFrame.maxX - arrowRadius - spacing
        var minY = max(
            safeFrame.minY + arrowRadius + spacing,
            headerMaterial.frame.maxY + arrowRadius + 10
        )
        var maxY = min(
            safeFrame.maxY - arrowRadius - spacing,
            guidanceMaterial.frame.minY - arrowRadius - 10
        )

        if maxX <= minX {
            minX = view.bounds.minX + arrowRadius + 8
            maxX = view.bounds.maxX - arrowRadius - 8
        }
        if maxY <= minY {
            minY = safeFrame.minY + arrowRadius + 8
            maxY = safeFrame.maxY - arrowRadius - 8
        }

        let origin = reticleView.center
        var intersections: [CGFloat] = []
        if dx > 0.000_1 {
            intersections.append((maxX - origin.x) / dx)
        } else if dx < -0.000_1 {
            intersections.append((minX - origin.x) / dx)
        }
        if dy > 0.000_1 {
            intersections.append((maxY - origin.y) / dy)
        } else if dy < -0.000_1 {
            intersections.append((minY - origin.y) / dy)
        }
        let distance = intersections.filter { $0 > 0 }.min() ?? 0
        directionArrowMaterial.center = CGPoint(
            x: min(max(origin.x + dx * distance, minX), maxX),
            y: min(max(origin.y + dy * distance, minY), maxY)
        )
        directionArrowImageView.transform = CGAffineTransform(
            rotationAngle: atan2(dy, dx) + .pi / 2
        )
    }

    private func updateDisplayedTarget(_ index: Int?, isAligned: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))

        if displayedTargetIndex != index,
           let previous = displayedTargetIndex,
           !capturedTargetIndices.contains(previous) {
            styleTarget(at: previous, color: .white, scale: 1.0, opacity: 0.78)
        }

        displayedTargetIndex = index
        guard let index, !capturedTargetIndices.contains(index) else { return }
        styleTarget(
            at: index,
            color: .white,
            scale: isAligned ? 1.35 : 1.12,
            opacity: 1.0
        )
    }

    private func styleTarget(at index: Int, color: UIColor, scale: Float, opacity: CGFloat) {
        guard targetNodes.indices.contains(index),
              let material = targetNodes[index].geometry?.firstMaterial else { return }

        SCNTransaction.begin()
        SCNTransaction.animationDuration = 0.12
        material.diffuse.contents = color
        material.emission.contents = color.withAlphaComponent(0.45)
        targetNodes[index].simdScale = SIMD3<Float>(repeating: scale)
        targetNodes[index].opacity = opacity
        SCNTransaction.commit()
    }

    private func markTargetCaptured(_ index: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        capturedTargetIndices.insert(index)
        if displayedTargetIndex == index {
            displayedTargetIndex = nil
        }

        let node = targetNodes[index]
        SCNTransaction.begin()
        SCNTransaction.animationDuration = 0.28
        node.geometry?.firstMaterial?.diffuse.contents = UIColor.white
        node.geometry?.firstMaterial?.emission.contents = UIColor.white
        node.opacity = 0
        node.simdScale = SIMD3<Float>(repeating: 0.25)
        SCNTransaction.completionBlock = {
            node.isHidden = true
        }
        SCNTransaction.commit()
    }

    private func resetSteadiness() {
        previousCameraTransform = nil
        previousFrameTimestamp = nil
        smoothedAngularSpeed = .greatestFiniteMagnitude
        smoothedLinearSpeed = .greatestFiniteMagnitude
        instantaneousAngularSpeed = .greatestFiniteMagnitude
        instantaneousLinearSpeed = .greatestFiniteMagnitude
        consecutiveUnsteadyFrames = 0
        alignedTargetIndex = nil
        steadyStartTimestamp = nil
        steadyAnchorTransform = nil
        bestStableSnapshot = nil
        bestStableSharpness = -Float.greatestFiniteMagnitude
        lastGuidanceDirection = nil
    }

    private func updateCaptureOrientation(
        _ orientation: UIInterfaceOrientation,
        isTransitioning: Bool
    ) {
        let resolvedOrientation: UIInterfaceOrientation
        switch orientation {
        case .portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight:
            resolvedOrientation = orientation
        case .unknown:
            resolvedOrientation = .portrait
        @unknown default:
            resolvedOrientation = .portrait
        }

        orientationLock.lock()
        captureOrientation = resolvedOrientation
        isOrientationTransitioning = isTransitioning
        orientationLock.unlock()
    }

    private func currentOrientationState() -> (
        orientation: UIInterfaceOrientation,
        isTransitioning: Bool
    ) {
        orientationLock.lock()
        defer { orientationLock.unlock() }
        return (captureOrientation, isOrientationTransitioning)
    }

    private func imageOrientation(
        for interfaceOrientation: UIInterfaceOrientation
    ) -> CGImagePropertyOrientation {
        // ARFrame.capturedImage is delivered in the camera sensor's
        // landscape-right coordinates regardless of the interface orientation.
        switch interfaceOrientation {
        case .portrait:
            return .right
        case .portraitUpsideDown:
            return .left
        case .landscapeLeft:
            return .down
        case .landscapeRight:
            return .up
        case .unknown:
            return .right
        @unknown default:
            return .right
        }
    }

    private func interfaceOrientationName(_ orientation: UIInterfaceOrientation) -> String {
        switch orientation {
        case .portrait:
            return "portrait"
        case .portraitUpsideDown:
            return "portraitUpsideDown"
        case .landscapeLeft:
            return "landscapeLeft"
        case .landscapeRight:
            return "landscapeRight"
        case .unknown:
            return "unknown"
        @unknown default:
            return "unknown"
        }
    }

    private func adjustedIntrinsics(
        _ intrinsics: simd_float3x3,
        calibrationResolution: CGSize,
        sensorWidth: Int,
        sensorHeight: Int,
        orientation: CGImagePropertyOrientation,
        outputWidth: Int,
        outputHeight: Int
    ) -> (fx: Double, fy: Double, cx: Double, cy: Double) {
        let calibrationWidth = max(1.0, Double(calibrationResolution.width))
        let calibrationHeight = max(1.0, Double(calibrationResolution.height))
        let sensorScaleX = Double(sensorWidth) / calibrationWidth
        let sensorScaleY = Double(sensorHeight) / calibrationHeight

        var fx = Double(intrinsics.columns.0.x) * sensorScaleX
        var fy = Double(intrinsics.columns.1.y) * sensorScaleY
        var cx = Double(intrinsics.columns.2.x) * sensorScaleX
        var cy = Double(intrinsics.columns.2.y) * sensorScaleY
        var orientedWidth = sensorWidth
        var orientedHeight = sensorHeight

        switch orientation {
        case .right:
            let originalFX = fx
            let originalCX = cx
            fx = fy
            fy = originalFX
            cx = Double(sensorHeight - 1) - cy
            cy = originalCX
            orientedWidth = sensorHeight
            orientedHeight = sensorWidth
        case .left:
            let originalFX = fx
            let originalCX = cx
            fx = fy
            fy = originalFX
            cx = cy
            cy = Double(sensorWidth - 1) - originalCX
            orientedWidth = sensorHeight
            orientedHeight = sensorWidth
        case .down:
            cx = Double(sensorWidth - 1) - cx
            cy = Double(sensorHeight - 1) - cy
        case .up:
            break
        default:
            break
        }

        let outputScaleX = Double(outputWidth) / Double(max(1, orientedWidth))
        let outputScaleY = Double(outputHeight) / Double(max(1, orientedHeight))
        return (
            fx * outputScaleX,
            fy * outputScaleY,
            cx * outputScaleX,
            cy * outputScaleY
        )
    }

    private func fieldOfViewDegrees(
        focalLength: Double,
        principalPoint: Double,
        pixelCount: Int
    ) -> Double {
        guard focalLength > 0, pixelCount > 1 else { return 0 }
        let negativeExtent = max(0, principalPoint)
        let positiveExtent = max(0, Double(pixelCount - 1) - principalPoint)
        return (atan(negativeExtent / focalLength) + atan(positiveExtent / focalLength)) * 180 / .pi
    }

    private func cameraRoll(
        transform: simd_float4x4,
        yaw: Float,
        pitch: Float
    ) -> Float {
        let cameraRight = simd_normalize(SIMD3<Float>(
            transform.columns.0.x,
            transform.columns.0.y,
            transform.columns.0.z
        ))
        let levelRight = simd_normalize(SIMD3<Float>(
            cos(yaw),
            0,
            sin(yaw)
        ))
        let levelUp = simd_normalize(SIMD3<Float>(
            -sin(pitch) * sin(yaw),
            cos(pitch),
            sin(pitch) * cos(yaw)
        ))
        return atan2(
            simd_dot(cameraRight, levelUp),
            simd_dot(cameraRight, levelRight)
        )
    }

    private func trackingMessage(for state: ARCamera.TrackingState) -> String {
        switch state {
        case .normal:
            return ""
        case .notAvailable:
            return "Camera tracking is unavailable"
        case .limited(let reason):
            switch reason {
            case .initializing:
                return "Move slowly while tracking starts"
            case .excessiveMotion:
                return "Slow down"
            case .insufficientFeatures:
                return "Point toward a more detailed area"
            case .relocalizing:
                return "Return to the previous position"
            @unknown default:
                return "Move slowly while tracking recovers"
            }
        }
    }

    @objc private func cancelTapped() {
        complete(.cancelled)
    }

    private func complete(_ outcome: PanoramaCaptureOutcome) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard beginEnding() else { return }

        sceneView.session.pause()
        UIApplication.shared.isIdleTimerDisabled = previousIdleTimerState
        cancelButton.isEnabled = false

        switch outcome {
        case .success:
            break
        case .cancelled, .failure:
            let directoryURL = self.directoryURL
            imageQueue.async {
                try? FileManager.default.removeItem(at: directoryURL)
            }
        }

        onCompletion?(outcome)
    }

    private var hasEnded: Bool {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        return didEnd
    }

    private func beginEnding() -> Bool {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        guard !didEnd else { return false }
        didEnd = true
        return true
    }

    private func rotationQuaternion(from transform: simd_float4x4) -> simd_quatf {
        let rotation = simd_float3x3(columns: (
            SIMD3<Float>(transform.columns.0.x, transform.columns.0.y, transform.columns.0.z),
            SIMD3<Float>(transform.columns.1.x, transform.columns.1.y, transform.columns.1.z),
            SIMD3<Float>(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
        ))
        return simd_normalize(simd_quatf(rotation))
    }

    private func flatten(_ transform: simd_float4x4) -> [Double] {
        [
            Double(transform.columns.0.x), Double(transform.columns.0.y),
            Double(transform.columns.0.z), Double(transform.columns.0.w),
            Double(transform.columns.1.x), Double(transform.columns.1.y),
            Double(transform.columns.1.z), Double(transform.columns.1.w),
            Double(transform.columns.2.x), Double(transform.columns.2.y),
            Double(transform.columns.2.z), Double(transform.columns.2.w),
            Double(transform.columns.3.x), Double(transform.columns.3.y),
            Double(transform.columns.3.z), Double(transform.columns.3.w)
        ]
    }

    private func radiansToDegrees(_ radians: Float) -> Float {
        radians * 180 / .pi
    }

    private func normalizedDegrees(_ degrees: Float) -> Float {
        let remainder = degrees.truncatingRemainder(dividingBy: 360)
        return remainder >= 0 ? remainder : remainder + 360
    }

    private static func isoTimestamp(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
