import SwiftUI
import SceneKit
import Metal

struct ProjectThumbnailView: View {
    let project: LocalProject
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            Color(red: 0.04, green: 0.075, blue: 0.085)
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .accessibilityLabel("\(project.session.manifest.name) 模型预览")
                    .accessibilityIdentifier("model-thumbnail-\(project.id)")
            } else if failed {
                VStack(spacing: 6) {
                    Image(systemName: "cube.transparent").font(.title2)
                    Text("预览暂不可用").font(.caption2)
                }.foregroundStyle(.secondary)
            } else { ProgressView().controlSize(.small).accessibilityLabel("正在生成模型预览") }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.white.opacity(0.08)))
        .task(id: project.session.manifest.modelHash) {
            image = nil; failed = false
            do {
                let data = try await ProjectThumbnailStore.shared.thumbnail(for: project)
                try Task.checkCancellation()
                guard let decoded = UIImage(data: data) else { throw TeachingError("预览图片无效") }
                image = decoded
            } catch { if !Task.isCancelled { failed = true } }
        }
    }
}

// Serial rendering keeps large models off the main thread and limits peak memory.
// Only the finished image is cached; no model, pose or display setting is changed.
private actor ProjectThumbnailStore {
    static let shared = ProjectThumbnailStore()
    private let memory = NSCache<NSString, NSData>()
    init() { memory.totalCostLimit = 12 * 1024 * 1024; memory.countLimit = 64 }

    func thumbnail(for project: LocalProject) async throws -> Data {
        let hash = project.session.manifest.modelHash
        guard hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw TeachingError("模型标识无效")
        }
        let key = "v1-\(hash)"
        if let cached = memory.object(forKey: key as NSString) { return cached as Data }
        let directory = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AtlasModelThumbnails", isDirectory: true)
        let cachedURL = directory.appendingPathComponent(key).appendingPathExtension("png")
        if let cached = try? Data(contentsOf: cachedURL), UIImage(data: cached) != nil {
            memory.setObject(cached as NSData, forKey: key as NSString, cost: cached.count)
            return cached
        }
        let modelURL = try await ProjectStore.shared.modelURL(project.id)
        try Task.checkCancellation()
        // Another card for the same model may have completed while awaiting the URL.
        if let cached = memory.object(forKey: key as NSString) { return cached as Data }
        let png = try autoreleasepool { () throws -> Data in
            let data = try Data(contentsOf: modelURL, options: .mappedIfSafe)
            let model = try ModelGeometry(data: data, manifest: project.session.manifest)
            let geometry = try model.makeThumbnailGeometry()
            let scene = SCNScene()
            scene.background.contents = UIColor(red: 0.04, green: 0.075, blue: 0.085, alpha: 1)
            scene.rootNode.addChildNode(SCNNode(geometry: geometry))
            let lower = SIMD3<Float>(model.minimum.x, model.minimum.y, model.minimum.z)
            let upper = SIMD3<Float>(model.maximum.x, model.maximum.y, model.maximum.z)
            let center = (lower + upper) / 2
            let size = max(simd_length(upper - lower), 0.01)
            let camera = SCNNode(); camera.camera = SCNCamera()
            camera.camera?.usesOrthographicProjection = true
            camera.camera?.zNear = Double(size * 0.001); camera.camera?.zFar = Double(size * 10)
            camera.simdPosition = center + simd_normalize(SIMD3<Float>(1.2, -1.8, 1.1)) * size * 2
            camera.look(at: SCNVector3(center.x, center.y, center.z), up: SCNVector3(0, 0, 1), localFront: SCNVector3(0, 0, -1))
            let right = camera.simdTransform.columns.0, up = camera.simdTransform.columns.1
            var halfWidth: Float = 0, halfHeight: Float = 0
            for x in [lower.x, upper.x] { for y in [lower.y, upper.y] { for z in [lower.z, upper.z] {
                let offset = SIMD4<Float>(SIMD3<Float>(x, y, z) - center, 0)
                halfWidth = max(halfWidth, abs(simd_dot(offset, right)))
                halfHeight = max(halfHeight, abs(simd_dot(offset, up)))
            } } }
            camera.camera?.orthographicScale = Double(max(halfHeight, halfWidth / 1.5, 0.005) * 1.16)
            scene.rootNode.addChildNode(camera)
            guard let device = MTLCreateSystemDefaultDevice() else { throw TeachingError("预览渲染暂不可用") }
            let renderer = SCNRenderer(device: device, options: nil)
            renderer.scene = scene; renderer.pointOfView = camera
            try Task.checkCancellation()
            let snapshot = renderer.snapshot(atTime: 0, with: CGSize(width: 384, height: 256), antialiasingMode: .multisampling4X)
            guard let png = snapshot.pngData() else { throw TeachingError("生成预览失败") }
            return png
        }
        memory.setObject(png as NSData, forKey: key as NSString, cost: png.count)
        if (try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)) != nil {
            try? png.write(to: cachedURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        return png
    }
}
