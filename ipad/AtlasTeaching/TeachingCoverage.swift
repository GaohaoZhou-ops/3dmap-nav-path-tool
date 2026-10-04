import Foundation
import Combine
import Metal
import SceneKit
import simd

/// A model-relative optical pose. Names, calibration segments and screen
/// orientation do not change the footprint of an already recorded camera.
struct TeachingCoveragePose: Hashable {
    let position: SIMD3<Float>
    let quaternion: SIMD4<Float>

    init?(_ camera: CameraPose) {
        let p = camera.position.simd, q = camera.quaternion
        let vector = SIMD4(q.x, q.y, q.z, q.w)
        let length = simd_length_squared(vector)
        guard camera.frameName == "ipad_camera_optical_frame",
              (0..<3).allSatisfy({ p[$0].isFinite }), (0..<4).allSatisfy({ vector[$0].isFinite }),
              length.isFinite, length > 0.000001 else { return nil }
        let normalized = simd_normalize(vector)
        position = p; quaternion = normalized.w < 0 ? -normalized : normalized
    }

    var cameraFromModel: simd_float4x4 {
        var modelFromCamera = simd_float4x4(simd_quatf(vector: quaternion))
        modelFromCamera.columns.3 = SIMD4(position, 1)
        return modelFromCamera.inverse
    }
}

enum TeachingCoverageProfile {
    // Twice the desktop depth-envelope resolution in each direction. The
    // footprint itself is evaluated per fragment, not per model vertex.
    static let columns = 28, rows = 18
    static let near: Float = 0.3, far: Float = 1.3
    static let tangentX = Float(tan(ZividFieldOfView.horizontalDegrees * .pi / 360))
    static let tangentY = Float(tan(ZividFieldOfView.verticalDegrees * .pi / 360))
    static let rasterNear: Float = 0.001

    static func contains(_ point: SIMD3<Float>, depths: [Float]) -> Bool {
        guard point.z >= near, point.z <= far, depths.count == columns * rows else { return false }
        let normalized = SIMD2(point.x / (point.z * tangentX), point.y / (point.z * tangentY))
        guard abs(normalized.x) <= 1, abs(normalized.y) <= 1 else { return false }
        let column = min(columns - 1, max(0, Int((normalized.x + 1) * 0.5 * Float(columns))))
        let row = min(rows - 1, max(0, Int((normalized.y + 1) * 0.5 * Float(rows))))
        let depth = depths[row * columns + column]
        guard depth >= near else { return false }
        let cell = SIMD2(2 * tangentX * depth / Float(columns), 2 * tangentY * depth / Float(rows))
        let tolerance = min(Float(0.12), max(0.018, depth * 0.025, simd_length(cell) * 0.72))
        return point.z <= depth + tolerance
    }
}

struct TeachingCoverageSnapshot {
    let frames: MTLBuffer?
    let depths: MTLBuffer?
    let frameCount: Int
}

/// The original model is rasterized on the local GPU once per distinct pose.
/// Display quality does not affect occlusion, and existing depth maps are reused
/// when recording another pose. Nothing is sent to the server or saved in Poses.
actor TeachingCoverageEngine {
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let depthState: MTLDepthStencilState
    private let modelBuffer: MTLBuffer
    private let vertices: Int, indices: Int
    private let target: MTLTexture, zBuffer: MTLTexture
    private var cache: [TeachingCoveragePose: [Float]] = [:]

    init(model: ModelGeometry) throws {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
            throw TeachingError("无法启动已示教区域的本机渲染")
        }
        self.device = device; self.queue = queue; vertices = model.vertices; indices = model.indices
        try Task.checkCancellation()
        let library = try device.makeLibrary(source: Self.rasterShader, options: nil)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "coverageVertex")
        descriptor.fragmentFunction = library.makeFunction(name: "coverageFragment")
        descriptor.colorAttachments[0].pixelFormat = .r32Float
        descriptor.depthAttachmentPixelFormat = .depth32Float
        pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        let depthDescriptor = MTLDepthStencilDescriptor()
        depthDescriptor.depthCompareFunction = .less; depthDescriptor.isDepthWriteEnabled = true
        guard let depthState = device.makeDepthStencilState(descriptor: depthDescriptor),
              let modelBuffer = model.data.withUnsafeBytes({ raw in
                  device.makeBuffer(bytes: raw.baseAddress!, length: raw.count, options: .storageModeShared)
              }) else { throw TeachingError("已示教区域渲染内存不足") }
        self.depthState = depthState; self.modelBuffer = modelBuffer
        let texture = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r32Float,
            width: TeachingCoverageProfile.columns, height: TeachingCoverageProfile.rows, mipmapped: false)
        texture.usage = [.renderTarget]; texture.storageMode = .private
        guard let target = device.makeTexture(descriptor: texture) else { throw TeachingError("无法创建覆盖深度图") }
        texture.pixelFormat = .depth32Float
        guard let zBuffer = device.makeTexture(descriptor: texture) else { throw TeachingError("无法创建遮挡深度图") }
        self.target = target; self.zBuffer = zBuffer
    }

    func build(_ poses: [TeachingCoveragePose], progress: @Sendable (Int) -> Void = { _ in }) async throws -> TeachingCoverageSnapshot {
        let needed = Set(poses)
        cache = cache.filter { needed.contains($0.key) }
        var matrices: [simd_float4x4] = [], depths: [Float] = []
        for (index, pose) in poses.enumerated() {
            try Task.checkCancellation()
            let grid: [Float]
            if let cached = cache[pose] { grid = cached }
            else {
                grid = try await rasterize(pose)
                try Task.checkCancellation()
                cache[pose] = grid
            }
            if grid.contains(where: { $0 >= TeachingCoverageProfile.near && $0 <= TeachingCoverageProfile.far }) {
                matrices.append(pose.cameraFromModel); depths.append(contentsOf: grid)
            }
            if index % 8 == 0 || index == poses.count - 1 { progress(index + 1) }
        }
        try Task.checkCancellation()
        guard !matrices.isEmpty else { return TeachingCoverageSnapshot(frames: nil, depths: nil, frameCount: 0) }
        guard let frames = matrices.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
              let depthData = depths.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }) else {
            throw TeachingError("已示教区域渲染内存不足")
        }
        return TeachingCoverageSnapshot(frames: frames, depths: depthData, frameCount: matrices.count)
    }

    func rasterize(_ pose: TeachingCoveragePose) async throws -> [Float] {
        try Task.checkCancellation()
        let columns = TeachingCoverageProfile.columns, rows = TeachingCoverageProfile.rows
        // A private readback buffer per command avoids races when a cancelled
        // request is followed by a new one while the GPU is still completing.
        let rowBytes = ((columns * 4 + 255) / 256) * 256
        guard let readback = device.makeBuffer(length: rowBytes * rows, options: .storageModeShared),
              let invalid = device.makeBuffer(length: 4, options: .storageModeShared),
              let command = queue.makeCommandBuffer() else { throw TeachingError("无法准备覆盖区域渲染") }
        invalid.contents().storeBytes(of: UInt32(0), as: UInt32.self)
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .clear; pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
        pass.depthAttachment.texture = zBuffer
        pass.depthAttachment.loadAction = .clear; pass.depthAttachment.storeAction = .dontCare
        pass.depthAttachment.clearDepth = 1
        guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { throw TeachingError("无法绘制覆盖区域") }
        struct Parameters {
            var cameraFromModel: simd_float4x4
            var projection: SIMD4<Float>
            var counts: SIMD4<UInt32>
        }
        var parameters = Parameters(cameraFromModel: pose.cameraFromModel,
            projection: SIMD4(TeachingCoverageProfile.tangentX, TeachingCoverageProfile.tangentY,
                              TeachingCoverageProfile.rasterNear, TeachingCoverageProfile.far),
            counts: SIMD4(UInt32(vertices), 0, 0, 0))
        encoder.setRenderPipelineState(pipeline); encoder.setDepthStencilState(depthState)
        encoder.setCullMode(.none)
        encoder.setVertexBuffer(modelBuffer, offset: 32, index: 0)
        encoder.setVertexBytes(&parameters, length: MemoryLayout<Parameters>.stride, index: 1)
        encoder.setVertexBuffer(invalid, offset: 0, index: 2)
        if indices > 0 {
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: indices, indexType: .uint32,
                indexBuffer: modelBuffer, indexBufferOffset: 32 + vertices * 16)
        } else { encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: vertices) }
        encoder.endEncoding()
        guard let blit = command.makeBlitCommandEncoder() else { throw TeachingError("无法读取覆盖深度图") }
        blit.copy(from: target, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
            sourceSize: MTLSize(width: columns, height: rows, depth: 1), to: readback,
            destinationOffset: 0, destinationBytesPerRow: rowBytes, destinationBytesPerImage: rowBytes * rows)
        blit.endEncoding()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            command.addCompletedHandler { completed in
                if completed.status == .completed { continuation.resume() }
                else { continuation.resume(throwing: TeachingError(completed.error?.localizedDescription ?? "覆盖区域渲染失败")) }
            }
            command.commit()
        }
        try Task.checkCancellation()
        guard invalid.contents().load(as: UInt32.self) == 0 else { throw TeachingError("模型存在无效坐标或越界索引，无法计算覆盖区域") }
        let values = readback.contents().bindMemory(to: Float.self, capacity: rowBytes * rows / 4)
        return (0..<rows).flatMap { row in (0..<columns).map { values[row * rowBytes / 4 + $0] } }
    }

    private static let rasterShader = """
    #include <metal_stdlib>
    using namespace metal;
    struct Parameters { float4x4 cameraFromModel; float4 projection; uint4 counts; };
    struct RasterVertex { float4 position [[position]]; float cameraDepth; float pointSize [[point_size]]; };
    vertex RasterVertex coverageVertex(uint vertexID [[vertex_id]],
        device const packed_float3 *positions [[buffer(0)]], constant Parameters &p [[buffer(1)]],
        device atomic_uint *invalid [[buffer(2)]]) {
        RasterVertex result; result.pointSize = 1.0; result.cameraDepth = 0.0;
        result.position = float4(2.0, 2.0, 2.0, 1.0);
        if (vertexID >= p.counts.x) { atomic_store_explicit(invalid, 1u, memory_order_relaxed); return result; }
        float3 point = float3(positions[vertexID]);
        if (!all(isfinite(point))) { atomic_store_explicit(invalid, 1u, memory_order_relaxed); return result; }
        float3 camera = (p.cameraFromModel * float4(point, 1.0)).xyz;
        float near = p.projection.z, far = p.projection.w;
        result.position = float4(camera.x / p.projection.x, -camera.y / p.projection.y,
            (camera.z - near) * far / (far - near), camera.z);
        result.cameraDepth = camera.z;
        return result;
    }
    fragment float coverageFragment(RasterVertex in [[stage_in]]) { return in.cameraDepth; }
    """
}

@MainActor
final class TeachingCoverageRenderer: ObservableObject {
    @Published var enabled = true { didSet { apply(); if enabled { rebuild() } else { cancel() } } }
    @Published var opacity: Float = 0.25 { didSet { apply() } }
    @Published private(set) var preparing = false
    @Published private(set) var processed = 0
    @Published private(set) var poseCount = 0
    @Published private(set) var hitCount = 0
    @Published private(set) var error = ""
    private var model: ModelGeometry?
    private var poses: [TeachingCoveragePose] = []
    private var appliedPoses: [TeachingCoveragePose] = []
    private var engine: Task<TeachingCoverageEngine, Error>?
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private var snapshot: TeachingCoverageSnapshot?
    private weak var rendered: SCNGeometry?

    var status: String {
        if !enabled { return "已隐藏" }
        if !error.isEmpty { return error }
        if poseCount == 0 { return "记录 Pose 后显示覆盖区域" }
        if preparing { return "正在本机计算 \(processed) / \(poses.count) 个视角…" }
        return hitCount == 0 ? "\(poseCount) 个 Pose · M70 工作范围内未命中模型" : "\(poseCount) 个 Pose · 表面覆盖已更新"
    }

    func update(model: ModelGeometry, samples: [TeachingSample]) {
        self.model = model
        var seen = Set<TeachingCoveragePose>()
        let next = samples.compactMap { TeachingCoveragePose($0.cameraPose) }.filter { seen.insert($0).inserted }
        poseCount = samples.count
        guard next != poses else { return }
        let removed = !Set(poses).isSubset(of: seen)
        poses = next
        // Retain the previous union while adding a pose. Removed or edited
        // cameras must disappear immediately, including during rebuild.
        if removed { snapshot = nil; hitCount = 0; apply() }
        rebuild()
    }

    func attach(to geometry: SCNGeometry?) { rendered = geometry; apply() }
    func cancel() { generation = UUID(); task?.cancel(); preparing = false }
    func resume() { if snapshot == nil || appliedPoses != poses { rebuild() } }

    private func rebuild() {
        cancel(); error = ""; processed = 0
        guard enabled, !poses.isEmpty, let model else { return }
        if engine == nil { engine = Task.detached(priority: .utility) { try TeachingCoverageEngine(model: model) } }
        let engine = engine!, inputs = poses, request = generation
        preparing = true
        task = Task {
            do {
                let service = try await engine.value
                try Task.checkCancellation()
                let result = try await service.build(inputs) { [weak self] count in
                    Task { @MainActor in
                        guard let self, self.generation == request else { return }
                        self.processed = count
                    }
                }
                guard !Task.isCancelled, generation == request else { return }
                snapshot = result; appliedPoses = inputs
                hitCount = result.frameCount; preparing = false; apply()
            } catch {
                guard !Task.isCancelled, generation == request else { return }
                self.error = "覆盖显示失败：\(error.localizedDescription)"; preparing = false
                self.engine = nil
            }
        }
    }

    private func apply() {
        for material in rendered?.materials ?? [] {
            guard enabled, let snapshot, snapshot.frameCount > 0 else {
                material.shaderModifiers = nil
                material.setValue(nil, forKey: "atlasCoverageFrames")
                material.setValue(nil, forKey: "atlasCoverageDepths")
                continue
            }
            Self.apply(snapshot, opacity: opacity, to: material)
        }
    }

    static func apply(_ snapshot: TeachingCoverageSnapshot, opacity: Float, to material: SCNMaterial) {
        material.setValue(snapshot.frames, forKey: "atlasCoverageFrames")
        material.setValue(snapshot.depths, forKey: "atlasCoverageDepths")
        material.setValue(snapshot.frameCount, forKey: "atlasCoverageCount")
        material.setValue(opacity, forKey: "atlasCoverageOpacity")
        material.shaderModifiers = [.geometry: """
            #pragma varyings
            float3 atlasCoveragePosition;
            #pragma body
            out.atlasCoveragePosition = _geometry.position.xyz;
            """, .fragment: """
            #pragma arguments
            float4x4* atlasCoverageFrames;
            float* atlasCoverageDepths;
            int atlasCoverageCount;
            float atlasCoverageOpacity;
            #pragma body
            for (int frame = 0; frame < atlasCoverageCount; ++frame) {
                float3 p = (atlasCoverageFrames[frame] * float4(in.atlasCoveragePosition, 1.0)).xyz;
                if (p.z < \(TeachingCoverageProfile.near) || p.z > \(TeachingCoverageProfile.far)) continue;
                float2 tangents = float2(\(TeachingCoverageProfile.tangentX), \(TeachingCoverageProfile.tangentY));
                float2 n = p.xy / (p.z * tangents);
                if (any(abs(n) > 1.0)) continue;
                float2 size = float2(\(TeachingCoverageProfile.columns).0, \(TeachingCoverageProfile.rows).0);
                int2 cell = clamp(int2((n + 1.0) * 0.5 * size), int2(0), int2(size) - 1);
                float depth = atlasCoverageDepths[frame * \(TeachingCoverageProfile.columns * TeachingCoverageProfile.rows)
                    + cell.y * \(TeachingCoverageProfile.columns) + cell.x];
                if (depth < \(TeachingCoverageProfile.near)) continue;
                float tolerance = min(0.12, max(0.018, max(depth * 0.025,
                    length(2.0 * tangents * depth / size) * 0.72)));
                if (p.z <= depth + tolerance) {
                    _output.color.rgb = mix(float3(_output.color.rgb), float3(0.1765, 0.9412, 0.5961), atlasCoverageOpacity);
                    break;
                }
            }
            """]
    }
}
