import Foundation
import simd

enum VisionQuality: String, CaseIterable, Identifiable {
    case light, balanced, detail
    var id: String { rawValue }
    var label: String { switch self { case .light: "轻量"; case .balanced: "均衡"; case .detail: "精细" } }
    var faces: Int { switch self { case .light: 40_000; case .balanced: 120_000; case .detail: 300_000 } }
    var points: Int { switch self { case .light: 8_000; case .balanced: 20_000; case .detail: 50_000 } }
}

/// CPU-only, cancellable conversion. Fixed budgets bound the two-eye rendering cost.
/// The original ATLS bytes and the 1:1 model coordinates are never modified.
struct VisionMeshData {
    var positions: [SIMD3<Float>] = []
    var textureCoordinates: [SIMD2<Float>] = []
    var triangles: [UInt32] = []
    var pixels: [UInt8]
    let textureSide: Int
    let primitiveCount: Int
    let isMesh: Bool

    init(model: ModelGeometry, mode: ModelDisplayMode, quality: VisionQuality) throws {
        isMesh = mode == .mesh && model.indices > 0
        let total = isMesh ? model.indices / 3 : model.vertices
        primitiveCount = min(total, isMesh ? quality.faces : quality.points)
        textureSide = Int(ceil(sqrt(Double(primitiveCount))))
        pixels = [UInt8](repeating: 255, count: textureSide * textureSide * 4)
        positions.reserveCapacity(primitiveCount * (isMesh ? 3 : 4))
        textureCoordinates.reserveCapacity(positions.capacity)
        triangles.reserveCapacity(primitiveCount * (isMesh ? 3 : 12))
        func gcd(_ a: Int, _ b: Int) -> Int { var a = a, b = b; while b != 0 { (a, b) = (b, a % b) }; return a }
        var step = max(1, Int(Double(total) * 0.61803398875))
        while gcd(step, total) != 1 { step += 1 }
        // Point clouds use small tetrahedra, which remain visible from every side.
        let extent = Float(max(model.maximum.x - model.minimum.x, model.maximum.y - model.minimum.y, model.maximum.z - model.minimum.z))
        let radius = max(Float(0.0015), min(Float(0.006), extent / 1000))
        let offsets: [SIMD3<Float>] = [SIMD3(1, 1, 1), SIMD3(1, -1, -1), SIMD3(-1, 1, -1), SIMD3(-1, -1, 1)]
        try model.data.withUnsafeBytes { raw in
            func uint(_ offset: Int) -> UInt32 { UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self)) }
            func position(_ vertex: Int) throws -> SIMD3<Float> {
                guard vertex >= 0, vertex < model.vertices else { throw TeachingError("模型索引越界") }
                let value = SIMD3(Float(bitPattern: uint(32 + vertex * 12)), Float(bitPattern: uint(36 + vertex * 12)), Float(bitPattern: uint(40 + vertex * 12)))
                guard (0..<3).allSatisfy({ value[$0].isFinite }) else { throw TeachingError("模型坐标无效") }
                return value
            }
            let bytes = raw.bindMemory(to: UInt8.self)
            var item = 0
            for primitive in 0..<primitiveCount {
                if primitive % 1024 == 0 { try Task.checkCancellation() }
                let ids = isMesh ? (0..<3).map { Int(uint(32 + model.vertices * 16 + (item * 3 + $0) * 4)) } : [item]
                let points = try ids.map(position)
                let base = UInt32(positions.count)
                let uv = SIMD2((Float(primitive % textureSide) + 0.5) / Float(textureSide),
                               1 - (Float(primitive / textureSide) + 0.5) / Float(textureSide))
                for channel in 0..<3 {
                    // The wire format stores linear colors; the texture is tagged sRGB.
                    let linear = ids.reduce(Float.zero) { $0 + Float(bytes[32 + model.vertices * 12 + $1 * 4 + channel]) / 255 } / Float(ids.count)
                    let srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * pow(linear, 1 / 2.4) - 0.055
                    pixels[primitive * 4 + channel] = UInt8(clamping: Int((srgb * 255).rounded()))
                }
                if isMesh {
                    positions.append(contentsOf: points)
                    textureCoordinates.append(contentsOf: [uv, uv, uv])
                    triangles.append(contentsOf: [base, base + 1, base + 2])
                } else {
                    positions.append(contentsOf: offsets.map { points[0] + $0 * radius })
                    textureCoordinates.append(contentsOf: [uv, uv, uv, uv])
                    triangles.append(contentsOf: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3].map { base + $0 })
                }
                item = (item + step) % total
            }
        }
    }
}
