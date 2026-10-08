#if targetEnvironment(simulator)
import Foundation
import CryptoKit
import simd

enum VisionDemo {
    @MainActor static func load(into session: TeachingSession) async {
        guard !session.busy else { return }
        session.busy = true; session.error = ""; defer { session.busy = false }
        do {
            let vertices: [SIMD3<Float>] = [SIMD3(-0.3, -0.2, 0), SIMD3(0.3, -0.2, 0), SIMD3(0.3, 0.2, 0), SIMD3(-0.3, 0.2, 0),
                SIMD3(-0.3, -0.2, 0.5), SIMD3(0.3, -0.2, 0.5), SIMD3(0.3, 0.2, 0.5), SIMD3(-0.3, 0.2, 0.5)]
            let indices: [UInt32] = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
                1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
            var data = Data()
            func uint(_ value: UInt32) { var value = value.littleEndian; withUnsafeBytes(of: &value) { data.append(contentsOf: $0) } }
            for value: UInt32 in [0x534c5441, 1, UInt32(vertices.count), UInt32(indices.count), 0, 0, 0, 0] { uint(value) }
            for point in vertices { for axis in 0..<3 { uint(point[axis].bitPattern) } }
            for index in vertices.indices { data.append(contentsOf: index < 4 ? [32, 140, 185, 255] : [80, 230, 185, 255]) }
            indices.forEach(uint)
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            let manifest = ModelManifest(protocol: teachingProtocol, modelHash: hash, name: "空间演练工件", sourceHash: hash,
                sourceMapId: "simulator-demo", coordinateFrame: "virtual_origin", distanceUnit: "meter", verticalAxis: "Z",
                vertices: vertices.count, indices: indices.count, sampled: false, originalVertices: vertices.count,
                byteLength: data.count, bounds: ModelBounds(min: Point3(SIMD3(-0.3, -0.2, 0)), max: Point3(SIMD3(0.3, 0.2, 0.5))))
            let paired = PairedSession(id: UUID().uuidString, deviceToken: "simulator-only", manifest: manifest)
            var result = TeachingResult(sessionId: paired.id, modelHash: hash)
            result.device = TeachingDevice(model: "Vision Pro Simulator", lidar: false, platform: "visionOS-simulator", poseSource: "simulatedDeviceAnchor")
            let project = LocalProject(serverURL: "http://localhost:21990", session: paired, result: result)
            try await ProjectStore.shared.saveModel(data, id: paired.id)
            try await ProjectStore.shared.save(project)
            session.geometry = try ModelGeometry(data: data, manifest: manifest)
            session.current = project; session.status = "模拟演练：合成模型与位姿，禁止同步"
            await session.reload()
        } catch { session.error = error.localizedDescription }
    }
}
#endif
