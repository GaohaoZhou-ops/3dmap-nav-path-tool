import ARKit
import AVFoundation
import SceneKit
import SwiftUI

@MainActor
final class ARController: NSObject, ObservableObject, @preconcurrency ARSessionDelegate {
    @Published var tracking = "等待相机"
    @Published var trackingNormal = false
    @Published var depthAvailable = false
    @Published var placed = false
    @Published var calibrated = false
    @Published var yaw: Float = 0
    @Published var referenceX: Float = 0
    @Published var referenceY: Float = 0
    @Published var referenceZ: Float = 0
    @Published var message = "缓慢移动 iPad，扫描物体附近的地面与表面"
    let view = ARSCNView(frame: .zero)
    private let objectRoot = SCNNode()
    private let modelNode = SCNNode()
    private let markers = SCNNode()
    private var hitPoint: SIMD3<Float>?
    private var segmentID: String?
    private var anchorID: UUID?
    private var gestureYaw: Float = 0
    private var lastStatusTime: TimeInterval = 0
    var onSample: ((TeachingSample) -> Void)?
    var onCalibration: ((Calibration) -> Void)?
    static var supported: Bool {
        UIDevice.current.userInterfaceIdiom == .pad && ARWorldTrackingConfiguration.isSupported
            && ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
            && ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }
    override init() {
        super.init()
        view.scene = SCNScene(); view.session.delegate = self; view.session.delegateQueue = .main
        view.automaticallyUpdatesLighting = false; view.preferredFramesPerSecond = 60
        view.scene.rootNode.addChildNode(objectRoot); objectRoot.addChildNode(markers)
        modelNode.name = "independent-teaching-object"; objectRoot.addChildNode(modelNode)
        objectRoot.isHidden = true
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapToPlace(_:))))
        let drag = UIPanGestureRecognizer(target: self, action: #selector(dragToPlace(_:)))
        drag.maximumNumberOfTouches = 1; view.addGestureRecognizer(drag)
        view.addGestureRecognizer(UIRotationGestureRecognizer(target: self, action: #selector(rotateObject(_:))))
    }
    func load(manifest: ModelManifest, samples: [TeachingSample]) {
        stop()
        objectRoot.childNodes.filter { $0 !== markers && $0 !== modelNode }.forEach { $0.removeFromParentNode() }
        markers.childNodes.forEach { $0.removeFromParentNode() }
        modelNode.geometry = nil
        if let bounds = manifest.bounds {
            referenceX = (bounds.min.x + bounds.max.x) / 2; referenceY = (bounds.min.y + bounds.max.y) / 2; referenceZ = bounds.min.z
        }
        yaw = 0; hitPoint = nil; placed = false; calibrated = false; segmentID = nil; anchorID = nil
        objectRoot.isHidden = true
        // Keep manual waypoints visible without constructing thousands of SceneKit nodes.
        refreshMarkers(samples)
        addAxes()
    }
    // Only replace draw geometry: placement, tracking, anchors and Pose markers stay intact.
    func display(_ geometry: SCNGeometry?) { modelNode.geometry = geometry }
    func start() async {
        guard Self.supported else { tracking = "需要配备 LiDAR 的 iPad Pro 真机"; return }
        let allowed = await AVCaptureDevice.requestAccess(for: .video)
        guard allowed else { tracking = "相机权限未开启"; message = "请在系统设置中允许 Atlas 示教访问相机"; return }
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity
        config.planeDetection = [.horizontal, .vertical]
        config.sceneReconstruction = .mesh
        config.frameSemantics = .sceneDepth
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) { config.frameSemantics.insert(.smoothedSceneDepth) }
        view.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        beginCalibration(); tracking = "正在建立空间定位"
    }
    func stop() { view.session.pause(); trackingNormal = false }
    func suspend() { stop(); calibrated = false; objectRoot.isHidden = true; placed = false; hitPoint = nil; segmentID = nil }
    func beginCalibration() {
        calibrated = false; segmentID = nil
        if let id = anchorID, let anchor = view.session.currentFrame?.anchors.first(where: { $0.identifier == id }) { view.session.remove(anchor: anchor) }
        anchorID = nil
        message = "将屏幕中心对准现实中的物体基准点，再点击「放置物体」"
    }
    private var reference: SIMD3<Float> { SIMD3(referenceX, referenceY, referenceZ) }
    func placeObject(at point: CGPoint? = nil) {
        guard trackingNormal, !calibrated, let hit = surfaceWorldPoint(at: point) else { message = "尚未测到可靠表面，请缓慢移动或靠近后重试"; return }
        hitPoint = hit; placed = true; updatePlacement()
        message = "旋转物体，让模型与现场方向一致；检查实际尺寸后确认校准"
    }
    @objc private func tapToPlace(_ gesture: UITapGestureRecognizer) { if !calibrated { placeObject(at: gesture.location(in: view)) } }
    @objc private func dragToPlace(_ gesture: UIPanGestureRecognizer) {
        if !calibrated, gesture.numberOfTouches == 1 { placeObject(at: gesture.location(in: view)) }
    }
    @objc private func rotateObject(_ gesture: UIRotationGestureRecognizer) {
        guard !calibrated, placed else { return }
        if gesture.state == .began { gestureYaw = yaw }
        yaw = (gestureYaw - Float(gesture.rotation) * 180 / .pi + 540).truncatingRemainder(dividingBy: 360) - 180
        updatePlacement()
    }
    func refreshMarkers(_ samples: [TeachingSample]) {
        markers.childNodes.forEach { $0.removeFromParentNode() }
        for sample in samples.filter({ $0.kind == "keyframe" }).suffix(2000) { showMarker(sample) }
    }
    func updatePlacement() {
        guard !calibrated, let hitPoint else { return }
        guard referenceX.isFinite, referenceY.isFinite, referenceZ.isFinite, yaw.isFinite else { return }
        objectRoot.simdTransform = TeachingCoordinates.placement(hit: hitPoint, reference: reference, yaw: yaw)
        objectRoot.isHidden = false
    }
    func confirmCalibration() {
        guard placed, trackingNormal, !calibrated, referenceX.isFinite, referenceY.isFinite, referenceZ.isFinite else { return }
        updatePlacement()
        let calibration = Calibration(worldFromModel: objectRoot.simdTransform.elements, referencePoint: Point3(reference), yawDegrees: yaw)
        segmentID = calibration.id
        let anchor = ARAnchor(name: "Atlas independent object", transform: objectRoot.simdTransform)
        anchorID = anchor.identifier; view.session.add(anchor: anchor)
        calibrated = true; onCalibration?(calibration)
        message = "校准已锁定。移动 iPad，将相机置于目标视角后记录示教点"
    }
    func recordKeyframe() { capture(kind: "keyframe") }
    private func capture(kind: String) {
        guard calibrated, trackingNormal, let segmentID, let frame = view.session.currentFrame,
              case .normal = frame.camera.trackingState else { return }
        let worldFromModel = objectRoot.simdTransform
        let sample = TeachingSample(segmentId: segmentID, kind: kind,
            cameraPose: TeachingCoordinates.opticalPose(camera: frame.camera.transform, worldFromModel: worldFromModel),
            surfacePoint: surfaceWorldPoint().map { TeachingCoordinates.modelPoint($0, worldFromModel: worldFromModel) },
            previewCameraTransform: view.pointOfView.map { (worldFromModel.inverse * $0.simdWorldTransform).elements },
            previewProjection: view.pointOfView?.camera.map { simd_float4x4($0.projectionTransform).elements },
            previewAspect: Float(view.bounds.width / view.bounds.height))
        if kind == "keyframe" { showMarker(sample); message = "已记录示教点" }
        onSample?(sample)
    }
    private func showMarker(_ sample: TeachingSample) {
        let sphere = SCNSphere(radius: 0.008); sphere.firstMaterial?.diffuse.contents = UIColor.systemYellow
        sphere.firstMaterial?.lightingModel = .constant
        let node = SCNNode(geometry: sphere); node.simdPosition = sample.cameraPose.position.simd; markers.addChildNode(node)
        if markers.childNodes.count > 2000 { markers.childNodes.first?.removeFromParentNode() }
    }
    private func addAxes() {
        let center = SCNNode(); center.name = "virtual-origin-axes"
        for (axis, color) in [(SIMD3<Float>(0.15, 0, 0), UIColor.systemRed), (SIMD3<Float>(0, 0.15, 0), UIColor.systemGreen), (SIMD3<Float>(0, 0, 0.15), UIColor.systemBlue)] {
            let line = SCNGeometry(sources: [SCNGeometrySource(vertices: [SCNVector3Zero, SCNVector3(axis.x, axis.y, axis.z)])],
                elements: [SCNGeometryElement(indices: [Int32(0), Int32(1)], primitiveType: .line)])
            line.firstMaterial?.diffuse.contents = color; line.firstMaterial?.lightingModel = .constant
            center.addChildNode(SCNNode(geometry: line))
        }
        objectRoot.addChildNode(center)
    }
    // Depth is sampled in the camera's image coordinates, after undoing the UI rotation/crop.
    private func surfaceWorldPoint(at point: CGPoint? = nil) -> SIMD3<Float>? {
        guard let frame = view.session.currentFrame, view.bounds.width > 0, view.bounds.height > 0 else { return nil }
        let orientation = view.window?.windowScene?.interfaceOrientation ?? .landscapeRight
        let screenPoint = point ?? CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        let normalized = CGPoint(x: screenPoint.x / view.bounds.width, y: screenPoint.y / view.bounds.height)
            .applying(frame.displayTransform(for: orientation, viewportSize: view.bounds.size).inverted())
        if let depth = frame.smoothedSceneDepth ?? frame.sceneDepth {
            let map = depth.depthMap, confidence = depth.confidenceMap
            CVPixelBufferLockBaseAddress(map, .readOnly)
            if let confidence { CVPixelBufferLockBaseAddress(confidence, .readOnly) }
            defer {
                CVPixelBufferUnlockBaseAddress(map, .readOnly)
                if let confidence { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) }
            }
            let width = CVPixelBufferGetWidth(map), height = CVPixelBufferGetHeight(map)
            let x = min(width - 1, max(0, Int(normalized.x * CGFloat(width))))
            let y = min(height - 1, max(0, Int(normalized.y * CGFloat(height))))
            if let base = CVPixelBufferGetBaseAddress(map) {
                let distance = base.advanced(by: y * CVPixelBufferGetBytesPerRow(map)).assumingMemoryBound(to: Float.self)[x]
                var reliable = true
                if let confidence, let base = CVPixelBufferGetBaseAddress(confidence) {
                    reliable = base.advanced(by: y * CVPixelBufferGetBytesPerRow(confidence)).assumingMemoryBound(to: UInt8.self)[x] >= ARConfidenceLevel.medium.rawValue
                }
                if reliable, distance.isFinite, distance >= 0.15, distance <= 6 {
                    let intrinsics = frame.camera.intrinsics, resolution = frame.camera.imageResolution
                    let u = Float(normalized.x * resolution.width), v = Float(normalized.y * resolution.height)
                    let cameraPoint = SIMD4((u - intrinsics[2].x) * distance / intrinsics[0].x,
                                           -(v - intrinsics[2].y) * distance / intrinsics[1].y, -distance, 1)
                    let world = frame.camera.transform * cameraPoint
                    return SIMD3(world.x, world.y, world.z)
                }
            }
        }
        // Only use observed geometry as a fallback, never an unobserved estimated plane.
        if let query = view.raycastQuery(from: screenPoint, allowing: .existingPlaneGeometry, alignment: .any),
           let hit = view.session.raycast(query).first { return hit.worldTransform.translation }
        return nil
    }
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let normal: Bool
        switch frame.camera.trackingState {
        case .normal: normal = true
        default: normal = false
        }
        if frame.timestamp - lastStatusTime > 0.2 {
            lastStatusTime = frame.timestamp; trackingNormal = normal; depthAvailable = frame.sceneDepth != nil
            switch frame.camera.trackingState {
            case .normal: tracking = "空间定位正常"
            case .notAvailable: tracking = "空间定位不可用"
            case .limited(let reason):
                switch reason {
                case .excessiveMotion: tracking = "请放慢移动速度"
                case .insufficientFeatures: tracking = "请对准有纹理、光线充足的表面"
                case .relocalizing: tracking = "正在重新定位，请回到刚才的场景"
                default: tracking = "正在初始化定位"
                }
            }
        }
    }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        if let anchor = anchors.first(where: { $0.identifier == anchorID }) { objectRoot.simdTransform = anchor.transform }
    }
    func sessionWasInterrupted(_ session: ARSession) {
        suspend(); message = "相机会话已中断。返回现场后重新校准，已有示教点保留"
    }
    func sessionInterruptionEnded(_ session: ARSession) { Task { await start() } }
    func session(_ session: ARSession, didFailWithError error: Error) {
        suspend(); tracking = "空间定位失败"; message = error.localizedDescription
    }
}

struct ARSceneView: UIViewRepresentable {
    let controller: ARController
    func makeUIView(context: Context) -> ARSCNView { controller.view }
    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
