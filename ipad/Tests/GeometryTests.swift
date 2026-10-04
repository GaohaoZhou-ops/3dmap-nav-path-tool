import Foundation
import SceneKit
import CryptoKit

@main struct GeometryTests {
    @MainActor static func main() async throws {
        let side = 450, vertices = side * side, faces = (side - 1) * (side - 1) * 2
        var data = Data(count: 32 + vertices * 16 + faces * 12)
        data.withUnsafeMutableBytes { raw in
            let words = raw.bindMemory(to: UInt32.self)
            words[0] = 0x534c5441; words[1] = 1; words[2] = UInt32(vertices); words[3] = UInt32(faces * 3)
            for i in 0..<vertices {
                words[8 + i * 3] = Float(i % side).bitPattern
                words[9 + i * 3] = Float(i / side).bitPattern
                words[10 + i * 3] = Float(-2).bitPattern
                words[8 + vertices * 3 + i] = 0xff8040ff
            }
            var offset = 8 + vertices * 4
            for y in 0..<(side - 1) { for x in 0..<(side - 1) {
                let a = UInt32(y * side + x), b = a + 1, c = a + UInt32(side), d = c + 1
                for value in [a, b, c, b, d, c] { words[offset] = value; offset += 1 }
            } }
        }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let manifest = ModelManifest(protocol: teachingProtocol, modelHash: digest, name: "grid.ply", sourceHash: digest,
            sourceMapId: "grid", coordinateFrame: "virtual_origin", distanceUnit: "meter", verticalAxis: "Z",
            vertices: vertices, indices: faces * 3, sampled: false, originalVertices: vertices, byteLength: data.count)
        let model = try ModelGeometry(data: data, manifest: manifest)
        let thumbnail = try model.makeThumbnailGeometry()
        let thumbnailPositions = thumbnail.sources(for: .vertex)[0]
        precondition(thumbnailPositions.vectorCount <= 80_000 && thumbnailPositions.data.count < data.count,
            "card previews must have a bounded GPU buffer independent of the full model")
        precondition(thumbnail.boundingBox.min.z == -2 && thumbnail.boundingBox.max.x == 449,
            "thumbnail framing must retain the complete model bounds")
        let thumbnailPoints = thumbnailPositions.data.withUnsafeBytes { raw in
            (0..<thumbnailPositions.vectorCount).map { index -> SIMD3<Float> in
                let offset = index * thumbnailPositions.dataStride
                return SIMD3(raw.loadUnaligned(fromByteOffset: offset, as: Float.self),
                    raw.loadUnaligned(fromByteOffset: offset + 4, as: Float.self),
                    raw.loadUnaligned(fromByteOffset: offset + 8, as: Float.self))
            }
        }
        precondition(Set(thumbnailPoints).count == thumbnailPoints.count && thumbnailPoints.allSatisfy {
            $0.x >= 0 && $0.x <= 449 && $0.y >= 0 && $0.y <= 449 && $0.z == -2
        }, "thumbnail points must be distinct source positions without changing coordinates")
        let full = try model.makeGeometry(settings: ModelDisplaySettings(meshQuality: .full))
        precondition(full.elements[0].primitiveType == .triangles && full.elements[0].primitiveCount == faces)
        precondition(full.elements[0].data == data.subdata(in: (32 + vertices * 16)..<data.count), "full quality retains exact source triangles")
        let reduced = try model.makeGeometry(settings: ModelDisplaySettings(meshQuality: .performance))
        precondition(reduced.elements[0].primitiveCount == 180_000, "quality changes the actual draw count")
        func triangles(_ bytes: Data) -> [SIMD3<UInt32>] {
            bytes.withUnsafeBytes { raw in
                let values = raw.bindMemory(to: UInt32.self)
                return stride(from: 0, to: values.count, by: 3).map { SIMD3(values[$0], values[$0 + 1], values[$0 + 2]) }
            }
        }
        let allFaces = Set(triangles(full.elements[0].data)), shownFaces = Set(triangles(reduced.elements[0].data))
        precondition(shownFaces.count == 180_000 && shownFaces.isSubset(of: allFaces), "reduced quality uses distinct original triangles")
        let sparseSettings = ModelDisplaySettings(mode: .points, pointDensity: .five)
        let denseSettings = ModelDisplaySettings(mode: .points, pointDensity: .quarter)
        let sparse = try model.makeGeometry(settings: sparseSettings), dense = try model.makeGeometry(settings: denseSettings)
        precondition(sparse.elements[0].primitiveType == .point && sparse.elements[0].primitiveCount == 10_125)
        precondition(dense.elements[0].primitiveCount == 50_625)
        precondition(dense.elements[0].data.starts(with: sparse.elements[0].data), "density increments keep existing points")
        for geometry in [full, reduced, sparse, dense] {
            let positions = geometry.sources(for: .vertex)[0]
            precondition(positions.data == data && positions.vectorCount == vertices, "display never changes model coordinates")
            precondition(geometry.boundingBox.min.z == -2 && geometry.boundingBox.max.x == 449, "stable framing at every quality")
        }
        let allPoints = try model.makeGeometry(settings: ModelDisplaySettings(mode: .points, pointDensity: .full))
        let pointIDs = allPoints.elements[0].data.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
        precondition(Set(pointIDs).count == vertices && pointIDs.allSatisfy { $0 < vertices }, "100% draws every point exactly once")

        var pointData = data.prefix(32 + vertices * 16)
        pointData.withUnsafeMutableBytes { $0.storeBytes(of: UInt32(0), toByteOffset: 12, as: UInt32.self) }
        var pointManifest = manifest; pointManifest.indices = 0; pointManifest.byteLength = pointData.count
        pointManifest.modelHash = SHA256.hash(data: pointData).map { String(format: "%02x", $0) }.joined()
        let pointsOnly = try ModelGeometry(data: pointData, manifest: pointManifest)
        let legacyGeometry = try pointsOnly.makeGeometry(settings: ModelDisplaySettings())
        precondition(legacyGeometry.elements[0].primitiveType == .point, "legacy point clouds never invent mesh")
        let pointThumbnail = try pointsOnly.makeThumbnailGeometry()
        precondition(pointThumbnail.elements[0].primitiveType == .point)

        var triangleData = Data(count: 92)
        triangleData.withUnsafeMutableBytes { raw in
            let words = raw.bindMemory(to: UInt32.self)
            words[0] = 0x534c5441; words[1] = 1; words[2] = 3; words[3] = 3
            for (i, value) in [Float(0), 0, 0, 1, 0, 0, 0, 1, 0].enumerated() { words[8 + i] = value.bitPattern }
            words[17] = 0xff0000ff; words[18] = 0xff00ff00; words[19] = 0xffff0000
            words[20] = 2; words[21] = 0; words[22] = 1
        }
        var triangleManifest = manifest
        triangleManifest.vertices = 3; triangleManifest.indices = 3; triangleManifest.byteLength = triangleData.count
        triangleManifest.modelHash = SHA256.hash(data: triangleData).map { String(format: "%02x", $0) }.joined()
        let triangleThumbnail = try ModelGeometry(data: triangleData, manifest: triangleManifest).makeThumbnailGeometry()
        precondition(triangleThumbnail.elements[0].primitiveType == .triangles && triangleThumbnail.elements[0].primitiveCount == 1,
            "small meshes retain faces in their card preview")
        let trianglePositions = triangleThumbnail.sources(for: .vertex)[0]
        trianglePositions.data.withUnsafeBytes { raw in
            precondition(raw.loadUnaligned(fromByteOffset: 4, as: Float.self) == 1,
                "compacted mesh follows the source triangle indices")
            precondition(raw.loadUnaligned(fromByteOffset: 20, as: Float.self) == 1,
                "compacted preview preserves the source vertex color")
        }

        let renderer = ModelRenderer()
        renderer.update(model, settings: ModelDisplaySettings(meshQuality: .full))
        renderer.update(model, settings: denseSettings)
        for _ in 0..<300 {
            if !renderer.preparing { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        precondition(renderer.appliedSettings == denseSettings && renderer.geometry?.elements[0].primitiveCount == 50_625, "latest selection wins over cancelled rendering")
        precondition(model.data == data && manifest.modelHash == digest, "source data remain intact")
        print("Mesh quality, point density, compact thumbnails, original topology/coordinates, point-only compatibility and render cancellation passed.")
    }
}
