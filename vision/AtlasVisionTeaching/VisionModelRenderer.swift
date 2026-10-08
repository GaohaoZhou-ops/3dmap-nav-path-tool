import RealityKit
import UIKit

@MainActor
enum VisionModelRenderer {
    static func makeEntity(_ data: VisionMeshData) async throws -> ModelEntity {
        var descriptor = MeshDescriptor(name: "Atlas workpiece")
        descriptor.positions = MeshBuffers.Positions(data.positions)
        descriptor.textureCoordinates = MeshBuffers.TextureCoordinates(data.textureCoordinates)
        descriptor.primitives = .triangles(data.triangles)
        let mesh = try await MeshResource(from: [descriptor])
        try Task.checkCancellation()
        guard let provider = CGDataProvider(data: Data(data.pixels) as CFData),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let image = CGImage(width: data.textureSide, height: data.textureSide, bitsPerComponent: 8,
                bitsPerPixel: 32, bytesPerRow: data.textureSide * 4, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
                decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { throw TeachingError("模型颜色纹理生成失败") }
        let texture = try await TextureResource(image: image, options: .init(semantic: .color, mipmapsMode: .none))
        var material = UnlitMaterial()
        material.color = .init(tint: .white, texture: .init(texture))
        material.faceCulling = .none
        return ModelEntity(mesh: mesh, materials: [material])
    }

    static func line(from: SIMD3<Float>, to: SIMD3<Float>, color: UIColor, width: Float = 0.004) -> Entity {
        let delta = to - from, length = simd_length(delta)
        let entity = ModelEntity(mesh: .generateCylinder(height: max(length, 0.0001), radius: width / 2),
            materials: [UnlitMaterial(color: color)])
        entity.position = (from + to) / 2
        if length > 0.0001 { entity.orientation = simd_quatf(from: SIMD3(0, 1, 0), to: delta / length) }
        return entity
    }

    static func axes() -> Entity {
        let root = Entity()
        root.addChild(line(from: .zero, to: SIMD3(0.25, 0, 0), color: .systemRed))
        root.addChild(line(from: .zero, to: SIMD3(0, 0.25, 0), color: .systemGreen))
        root.addChild(line(from: .zero, to: SIMD3(0, 0, 0.25), color: .systemBlue))
        return root
    }

    static func markers(_ samples: [TeachingSample]) -> Entity {
        let root = Entity()
        let sphere = MeshResource.generateSphere(radius: 0.009)
        let material = UnlitMaterial(color: .systemYellow)
        // Visualize recent markers with a bounded entity count; preserve every saved sample.
        for sample in samples.suffix(500) {
            let marker = ModelEntity(mesh: sphere, materials: [material])
            marker.position = sample.cameraPose.position.simd
            root.addChild(marker)
            let q = sample.cameraPose.quaternion
            let forward = simd_quatf(vector: SIMD4(q.x, q.y, q.z, q.w)).act(SIMD3(0, 0, 0.07))
            root.addChild(line(from: marker.position, to: marker.position + forward, color: .systemYellow, width: 0.003))
        }
        return root
    }
}
