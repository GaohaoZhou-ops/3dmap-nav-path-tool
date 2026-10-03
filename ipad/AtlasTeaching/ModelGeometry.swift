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
    private let sources: [SCNGeometrySource]
    init(data: Data, manifest: ModelManifest) throws {
        guard manifest.protocol == teachingProtocol, manifest.coordinateFrame == "virtual_origin",
              manifest.verticalAxis == "Z", manifest.distanceUnit == "meter",
              data.count >= 48, data.count <= maximumModelBytes, data.count == manifest.byteLength else {
            throw TeachingError("模型清单或文件大小无效")
        }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == manifest.modelHash else { throw TeachingError("模型校验失败，请重新下载") }
        func uint(_ offset: Int) -> UInt32 { data.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self)) } }
        guard uint(0) == 0x534c5441, uint(4) == 1 else { throw TeachingError("模型格式不支持") }
        let count = Int(uint(8)), indexCount = Int(uint(12))
        guard count > 0, count <= maximumModelVertices, indexCount <= maximumModelIndices, indexCount % 3 == 0,
              count == manifest.vertices, indexCount == manifest.indices,
              data.count == 32 + count * 16 + indexCount * 4 else { throw TeachingError("模型文件不完整") }
        var lower = SIMD3<Float>(repeating: .infinity), upper = SIMD3<Float>(repeating: -.infinity)
        var colorData = Data(count: count * 16)
        try data.withUnsafeBytes { raw in
            for i in 0..<count {
                let offset = 32 + i * 12
                let p = SIMD3<Float>(
                    Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self))),
                    Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: offset + 4, as: UInt32.self))),
                    Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: offset + 8, as: UInt32.self))))
                guard p.x.isFinite, p.y.isFinite, p.z.isFinite else { throw TeachingError("模型坐标无效") }
                lower = simd_min(lower, p); upper = simd_max(upper, p)
            }
            for i in 0..<indexCount {
                guard UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 32 + count * 16 + i * 4, as: UInt32.self)) < count else { throw TeachingError("模型索引越界") }
            }
            colorData.withUnsafeMutableBytes { colors in
                let values = colors.bindMemory(to: Float.self)
                let bytes = raw.bindMemory(to: UInt8.self)
                for i in 0..<(count * 4) { values[i] = Float(bytes[32 + count * 12 + i]) / 255 }
            }
        }
        self.data = data; vertices = count; indices = indexCount
        minimum = SCNVector3(lower.x, lower.y, lower.z); maximum = SCNVector3(upper.x, upper.y, upper.z)
        let positions = SCNGeometrySource(data: data, semantic: .vertex, vectorCount: count,
            usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 32, dataStride: 12)
        let colors = SCNGeometrySource(data: colorData, semantic: .color, vectorCount: count,
            usesFloatComponents: true, componentsPerVector: 4, bytesPerComponent: 4, dataOffset: 0, dataStride: 16)
        sources = [positions, colors]
    }
    func usesMesh(_ settings: ModelDisplaySettings) -> Bool { indices > 0 && settings.mode == .mesh }
    func renderedCount(_ settings: ModelDisplaySettings) -> Int {
        usesMesh(settings) ? settings.meshQuality.count(for: indices / 3) : settings.pointDensity.count(for: vertices)
    }
    func summary(_ settings: ModelDisplaySettings) -> String {
        let mesh = usesMesh(settings), count = renderedCount(settings), total = mesh ? indices / 3 : vertices
        return "\(mesh ? "Mesh" : "点云") · \(count.formatted()) / \(total.formatted()) \(mesh ? "面" : "点")"
    }
    func makeGeometry(settings: ModelDisplaySettings) throws -> SCNGeometry {
        try Task.checkCancellation()
        let mesh = usesMesh(settings), total = mesh ? indices / 3 : vertices, count = renderedCount(settings)
        let indexData: Data
        if mesh && count == total { indexData = data.subdata(in: (32 + vertices * 16)..<data.count) }
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
                                output[i * 3 + corner] = source.loadUnaligned(fromByteOffset: 32 + vertices * 16 + (item * 3 + corner) * 4, as: UInt32.self)
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
        let geometry = SCNGeometry(sources: sources, elements: [element])
        let material = SCNMaterial(); material.lightingModel = .constant; material.isDoubleSided = true
        geometry.materials = [material]
        geometry.boundingBox = (minimum, maximum)
        return geometry
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
