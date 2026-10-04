import Foundation
import SceneKit
import CryptoKit
import Combine

struct ModelGeometry {
    let data: Data
    let vertices: Int
    let indices: Int
    let minimum: SCNVector3
    let maximum: SCNVector3
    init(data: Data, manifest: ModelManifest) throws {
        try Task.checkCancellation()
        guard manifest.protocol == teachingProtocol, manifest.coordinateFrame == "virtual_origin",
              manifest.verticalAxis == "Z", manifest.distanceUnit == "meter",
              data.count >= 48, data.count <= maximumModelBytes, data.count == manifest.byteLength else {
            throw TeachingError("模型清单或文件大小无效")
        }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == manifest.modelHash else { throw TeachingError("模型校验失败，请重新下载") }
        try Task.checkCancellation()
        func uint(_ offset: Int) -> UInt32 { data.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self)) } }
        guard uint(0) == 0x534c5441, uint(4) == 1 else { throw TeachingError("模型格式不支持") }
        let count = Int(uint(8)), indexCount = Int(uint(12))
        guard count > 0, count <= maximumModelVertices, indexCount <= maximumModelIndices, indexCount % 3 == 0,
              count == manifest.vertices, indexCount == manifest.indices,
              data.count == 32 + count * 16 + indexCount * 4 else { throw TeachingError("模型文件不完整") }
        var lower = SIMD3<Float>(repeating: .infinity), upper = SIMD3<Float>(repeating: -.infinity)
        // The entire file is still hash-verified above. Use the transmitted full
        // bounds without eagerly expanding millions of unused vertices/colors.
        // Coordinates and indices are validated as they are selected for rendering.
        if let bounds = manifest.bounds {
            lower = bounds.min.simd; upper = bounds.max.simd
            guard (0..<3).allSatisfy({ lower[$0].isFinite && upper[$0].isFinite && lower[$0] <= upper[$0] }) else {
                throw TeachingError("模型边界无效")
            }
        } else {
            // Older transfers did not carry bounds; keep their exact framing.
            try data.withUnsafeBytes { raw in
                for i in 0..<count {
                    if i % 4096 == 0 { try Task.checkCancellation() }
                    let point = try Self.position(in: raw, vertex: i)
                    lower = simd_min(lower, point); upper = simd_max(upper, point)
                }
            }
        }
        self.data = data; vertices = count; indices = indexCount
        minimum = SCNVector3(lower.x, lower.y, lower.z); maximum = SCNVector3(upper.x, upper.y, upper.z)
    }
    private static func position(in raw: UnsafeRawBufferPointer, vertex: Int) throws -> SIMD3<Float> {
        let offset = 32 + vertex * 12
        let point = SIMD3<Float>(
            Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self))),
            Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: offset + 4, as: UInt32.self))),
            Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: offset + 8, as: UInt32.self))))
        guard point.x.isFinite, point.y.isFinite, point.z.isFinite else { throw TeachingError("模型坐标无效") }
        return point
    }
    private func index(in raw: UnsafeRawBufferPointer, at offset: Int) throws -> UInt32 {
        let value = UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 32 + vertices * 16 + offset * 4, as: UInt32.self))
        guard value < vertices else { throw TeachingError("模型索引越界") }
        return value
    }
    func usesMesh(_ settings: ModelDisplaySettings) -> Bool { indices > 0 && settings.mode == .mesh }
    func renderedCount(_ settings: ModelDisplaySettings) -> Int {
        usesMesh(settings) ? settings.meshQuality.count(for: indices / 3) : settings.pointDensity.count(for: vertices)
    }
    func summary(_ settings: ModelDisplaySettings) -> String {
        let mesh = usesMesh(settings), count = renderedCount(settings), total = mesh ? indices / 3 : vertices
        return "\(mesh ? "Mesh" : "点云") · \(count.formatted()) / \(total.formatted()) \(mesh ? "面" : "点")"
    }
    func makeThumbnailGeometry() throws -> SCNGeometry {
        let mesh = indices > 0 && indices / 3 <= 120_000
        let geometry = try makeCompactGeometry(mesh: mesh, primitiveCount: mesh ? indices / 3 : min(vertices, 80_000))
        geometry.elements[0].pointSize = 2
        geometry.elements[0].minimumPointScreenSpaceRadius = 0.8
        geometry.elements[0].maximumPointScreenSpaceRadius = 1.8
        return geometry
    }
    private func makeCompactGeometry(mesh: Bool, primitiveCount: Int, showVertices: Bool = false) throws -> SCNGeometry {
        // Build only the selected vertices: lowering the draw count alone still
        // uploaded the entire source model and converted all of its colors.
        try Task.checkCancellation()
        let total = mesh ? indices / 3 : vertices, count = primitiveCount * (mesh ? 3 : 1)
        func gcd(_ a: Int, _ b: Int) -> Int { var a = a, b = b; while b != 0 { (a, b) = (b, a % b) }; return a }
        var step = max(1, Int(Double(total) * 0.61803398875))
        while gcd(step, total) != 1 { step += 1 }
        var compact = Data(count: count * 28), sequential = Data(count: count * 4)
        try compact.withUnsafeMutableBytes { destination in
            try data.withUnsafeBytes { source in
                let output = destination.bindMemory(to: UInt32.self)
                let bytes = source.bindMemory(to: UInt8.self)
                var sampled = 0
                for i in 0..<count {
                    if i % 4096 == 0 { try Task.checkCancellation() }
                    let vertex = mesh ? Int(try index(in: source, at: sampled * 3 + i % 3)) : sampled
                    let point = try Self.position(in: source, vertex: vertex)
                    for axis in 0..<3 { output[i * 7 + axis] = point[axis].bitPattern.littleEndian }
                    for channel in 0..<4 { output[i * 7 + 3 + channel] = (Float(bytes[32 + vertices * 12 + vertex * 4 + channel]) / 255).bitPattern.littleEndian }
                    if !mesh || i % 3 == 2 { sampled = (sampled + step) % total }
                }
            }
        }
        sequential.withUnsafeMutableBytes { raw in
            let indices = raw.bindMemory(to: UInt32.self)
            for i in 0..<count { indices[i] = UInt32(i).littleEndian }
        }
        let positions = SCNGeometrySource(data: compact, semantic: .vertex, vectorCount: count,
            usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 28)
        let colors = SCNGeometrySource(data: compact, semantic: .color, vectorCount: count,
            usesFloatComponents: true, componentsPerVector: 4, bytesPerComponent: 4, dataOffset: 12, dataStride: 28)
        let element = SCNGeometryElement(data: sequential, primitiveType: mesh ? .triangles : .point,
            primitiveCount: mesh ? count / 3 : count, bytesPerIndex: 4)
        element.pointSize = 3; element.minimumPointScreenSpaceRadius = 1; element.maximumPointScreenSpaceRadius = 5
        var elements = [element]
        if mesh && showVertices {
            // Tiny sampled faces can become subpixel holes. Reuse the same
            // selected corners as splats so the lightweight object stays legible
            // without decoding more source data or moving any vertices.
            let points = SCNGeometryElement(data: sequential, primitiveType: .point, primitiveCount: count, bytesPerIndex: 4)
            points.pointSize = 3; points.minimumPointScreenSpaceRadius = 1; points.maximumPointScreenSpaceRadius = 3
            elements.append(points)
        }
        let geometry = SCNGeometry(sources: [positions, colors], elements: elements)
        let material = SCNMaterial(); material.lightingModel = .constant; material.isDoubleSided = true
        geometry.materials = [material]; geometry.boundingBox = (minimum, maximum)
        return geometry
    }
    func makeGeometry(settings: ModelDisplaySettings) throws -> SCNGeometry {
        try Task.checkCancellation()
        let mesh = usesMesh(settings), total = mesh ? indices / 3 : vertices, count = renderedCount(settings)
        if count < total && count * (mesh ? 3 : 1) < vertices {
            return try makeCompactGeometry(mesh: mesh, primitiveCount: count, showVertices: mesh && settings.meshQuality == .preview)
        }
        let indexData: Data
        if mesh && count == total {
            try data.withUnsafeBytes { source in
                for i in 0..<indices {
                    if i % 4096 == 0 { try Task.checkCancellation() }
                    _ = try index(in: source, at: i)
                }
            }
            indexData = data.subdata(in: (32 + vertices * 16)..<data.count)
        }
        else {
            // The coprime walk covers the whole object and makes lower budgets a stable subset.
            func gcd(_ a: Int, _ b: Int) -> Int { var a = a, b = b; while b != 0 { (a, b) = (b, a % b) }; return a }
            var step = max(1, Int(Double(total) * 0.61803398875))
            while gcd(step, total) != 1 { step += 1 }
            var selected = Data(count: count * (mesh ? 3 : 1) * 4)
            try selected.withUnsafeMutableBytes { target in
                try data.withUnsafeBytes { source in
                    let output = target.bindMemory(to: UInt32.self)
                    var item = 0
                    for i in 0..<count {
                        if i % 4096 == 0 { try Task.checkCancellation() }
                        if mesh {
                            for corner in 0..<3 {
                                output[i * 3 + corner] = try index(in: source, at: item * 3 + corner).littleEndian
                            }
                        } else { output[i] = UInt32(item).littleEndian }
                        item = (item + step) % total
                    }
                }
            }
            indexData = selected
        }
        let element = SCNGeometryElement(data: indexData, primitiveType: mesh ? .triangles : .point,
            primitiveCount: count, bytesPerIndex: 4)
        element.pointSize = 3; element.minimumPointScreenSpaceRadius = 1; element.maximumPointScreenSpaceRadius = 5
        let geometry = SCNGeometry(sources: try fullSources(), elements: [element])
        let material = SCNMaterial(); material.lightingModel = .constant; material.isDoubleSided = true
        geometry.materials = [material]
        geometry.boundingBox = (minimum, maximum)
        return geometry
    }
    private func fullSources() throws -> [SCNGeometrySource] {
        // High/full quality is prepared only after an explicit selection. Keep
        // the original vertex order and triangles, but omit unrelated file bytes
        // from the position buffer sent to SceneKit.
        var colorData = Data(count: vertices * 16)
        try colorData.withUnsafeMutableBytes { colors in
            let values = colors.bindMemory(to: Float.self)
            try data.withUnsafeBytes { raw in
                let bytes = raw.bindMemory(to: UInt8.self)
                for vertex in 0..<vertices {
                    if vertex % 4096 == 0 { try Task.checkCancellation() }
                    _ = try Self.position(in: raw, vertex: vertex)
                    for channel in 0..<4 {
                        values[vertex * 4 + channel] = Float(bytes[32 + vertices * 12 + vertex * 4 + channel]) / 255
                    }
                }
            }
        }
        let positions = SCNGeometrySource(data: data.subdata(in: 32..<(32 + vertices * 12)), semantic: .vertex, vectorCount: vertices,
            usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
        let colors = SCNGeometrySource(data: colorData, semantic: .color, vectorCount: vertices,
            usesFloatComponents: true, componentsPerVector: 4, bytesPerComponent: 4, dataOffset: 0, dataStride: 16)
        return [positions, colors]
    }
}

@MainActor
final class ModelRenderer: ObservableObject {
    @Published private(set) var geometry: SCNGeometry?
    @Published private(set) var appliedSettings: ModelDisplaySettings?
    @Published private(set) var preparing = false
    @Published private(set) var error = ""
    private var task: Task<Void, Never>?

    func update(_ model: ModelGeometry, settings: ModelDisplaySettings) {
        task?.cancel(); preparing = true; error = ""
        task = Task {
            let build = Task.detached(priority: .userInitiated) { try model.makeGeometry(settings: settings) }
            do {
                let result = try await withTaskCancellationHandler(operation: { try await build.value }, onCancel: { build.cancel() })
                guard !Task.isCancelled else { return }
                geometry = result; appliedSettings = settings; preparing = false
            } catch {
                guard !Task.isCancelled else { return }
                self.error = "显示更新失败：\(error.localizedDescription)"; preparing = false
            }
        }
    }
    func cancel() { task?.cancel(); preparing = false }
}
