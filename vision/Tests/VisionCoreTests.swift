import Foundation
import simd

@main struct VisionCoreTests {
    static func near(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ label: String) {
        precondition(simd_distance(a, b) < 0.00001, label)
    }
    static func same(_ a: simd_float4x4, _ b: simd_float4x4) {
        precondition(zip(a.elements, b.elements).allSatisfy { abs($0 - $1) < 0.00001 })
    }
    static func main() async throws {
        let args = CommandLine.arguments, base = args[1], fixture = URL(fileURLWithPath: args[2])
        var placement = VisionPlacement(reference: SIMD3(0.4, 0.6, 0.2))
        precondition(placement.transform == nil && !placement.isCalibrated)
        placement.hit = SIMD3(1, 0.7, -2); placement.yaw = 37; placement.roll = 12; placement.pitch = -21
        let first = try placement.confirm(), initial = placement.transform!
        near((initial * SIMD4(placement.reference, 1)).xyz, placement.hit!, "the model reference lands exactly on the selected surface")
        precondition(VisionPoseMath.isRigid(initial))
        var device = simd_float4x4(simd_quatf(angle: 0.6, axis: simd_normalize(SIMD3(1, 2, 3))))
        device.columns.3 = SIMD4(0.5, 1.6, -0.1, 1)
        let sample = try VisionPoseMath.sample(device: device, worldFromModel: initial, segmentID: first.id)
        let p = sample.cameraPose
        precondition(p.frameName == VisionPoseMath.frameName)
        var modelFromOptical = simd_float4x4(simd_quatf(vector: SIMD4(p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w)))
        modelFromOptical.columns.3 = SIMD4(p.position.simd, 1)
        same(initial * modelFromOptical * TeachingCoordinates.opticalToARCamera, device)
        let standard = try VisionPoseMath.sample(device: matrix_identity_float4x4, worldFromModel: TeachingCoordinates.zUpToAR, segmentID: first.id)
        let q = standard.cameraPose.quaternion
        near(simd_quatf(vector: SIMD4(q.x, q.y, q.z, q.w)).act(SIMD3(0, 0, 1)), SIMD3(0, 1, 0), "head forward maps to model +Y")
        let refinement = simd_float4x4(simd_quatf(angle: 0.01, axis: SIMD3(0, 1, 0))) * initial
        placement.refine(refinement); placement.unlock(); same(placement.transform!, refinement)
        precondition(!placement.isCalibrated, "unlock invalidates the sampling segment")
        let second = try placement.confirm()
        precondition(second.id != first.id, "recalibration creates a new segment")
        for invalid in [simd_float4x4(diagonal: SIMD4(2, 1, 1, 1)), simd_float4x4(diagonal: SIMD4(-1, 1, 1, 1)), simd_float4x4(diagonal: SIMD4(Float.nan, 1, 1, 1))] {
            precondition(!VisionPoseMath.isRigid(invalid))
            do { _ = try VisionPoseMath.sample(device: invalid, worldFromModel: initial, segmentID: first.id); preconditionFailure("invalid pose accepted") }
            catch is TeachingError {}
        }
        let plane: [SIMD3<Float>] = [SIMD3(-1, 0, -1), SIMD3(1, 0, -1), SIMD3(-1, 0, 1)]
        near(VisionPoseMath.intersection(origin: SIMD3(-0.5, 1, -0.5), direction: SIMD3(0, -1, 0), vertices: plane, indices: [0, 1, 2])!, SIMD3(-0.5, 0, -0.5), "observed triangle hit")
        precondition(VisionPoseMath.intersection(origin: SIMD3(0.8, 1, 0.8), direction: SIMD3(0, -1, 0), vertices: plane, indices: [0, 1, 2]) == nil, "unobserved corner must not count as a surface")
        let manifest = try JSONDecoder().decode(ModelManifest.self, from: Data(contentsOf: fixture.appendingPathExtension("json")))
        let bytes = try Data(contentsOf: fixture.appendingPathExtension("atls"))
        let model = try ModelGeometry(data: bytes, manifest: manifest)
        for quality in VisionQuality.allCases {
            let mesh = try VisionMeshData(model: model, mode: .mesh, quality: quality)
            precondition(mesh.primitiveCount == 12 && mesh.positions.count == 36 && mesh.triangles.count == 36)
            precondition(mesh.positions.allSatisfy { abs($0.x) <= 0.5 && abs($0.y) <= 0.5 && abs($0.z) <= 0.5 }, "rendering never rescales vertices")
            let points = try VisionMeshData(model: model, mode: .points, quality: quality)
            precondition(points.positions.count == model.vertices * 4 && points.triangles.count == model.vertices * 12)
        }
        var corrupt = bytes; corrupt[32] ^= 1
        do { _ = try ModelGeometry(data: corrupt, manifest: manifest); preconditionFailure("corrupt model accepted") } catch is TeachingError {}

        func api(_ path: String, method: String = "GET", token: String? = nil, body: Data? = nil) async throws -> Data {
            var request = URLRequest(url: URL(string: base + "/__atlas/ipad" + path)!)
            request.httpMethod = method; request.httpBody = body
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await URLSession.shared.data(for: request)
            precondition((200...299).contains((response as! HTTPURLResponse).statusCode), String(decoding: data, as: UTF8.self))
            return data
        }
        struct Ticket: Decodable { var id: String; var ownerToken: String; var pairingCode: String }
        let body = try JSONSerialization.data(withJSONObject: ["manifest": JSONSerialization.jsonObject(with: JSONEncoder().encode(manifest))])
        let ticket = try JSONDecoder().decode(Ticket.self, from: await api("/sessions", method: "POST", body: body))
        _ = try await api("/sessions/\(ticket.id)/model", method: "PUT", token: ticket.ownerToken, body: bytes)
        let client = try LANClient(address: base)
        let paired = try await client.pair(code: ticket.pairingCode, deviceID: UUID().uuidString, name: TeachingDevice.visionPro.model)
        let downloaded = try await client.download(paired)
        precondition(downloaded == bytes)
        var result = TeachingResult(sessionId: paired.id, modelHash: manifest.modelHash)
        result.device = .visionPro; result.calibrations = [first, second]; result.samples = [sample]
        var moved = device; moved.columns.3.x += 0.2
        result.samples.append(try VisionPoseMath.sample(device: moved, worldFromModel: placement.transform!, segmentID: second.id))
        for i in result.samples.indices { result.samples[i].name = "Vision Pose \(i + 1)" }
        let storeURL = URL(fileURLWithPath: args[3]), store = ProjectStore(directory: storeURL)
        var project = LocalProject(serverURL: base, session: paired, result: result)
        try await store.saveModel(downloaded, id: paired.id); try await store.save(project)
        let recovered = try await ProjectStore(directory: storeURL).projects()
        precondition(recovered.count == 1 && recovered[0].result.samples.count == 2 && recovered[0].result.device.platform == "visionOS")
        let modelURL = try await store.modelURL(paired.id)
        do { try await client.upload(project, modelURL: modelURL); preconditionFailure("unfinished result uploaded") } catch is TeachingError {}
        project.result.completedAt = timestamp(); try await store.save(project)
        try await store.saveModel(corrupt, id: paired.id)
        do { try await client.upload(project, modelURL: modelURL); preconditionFailure("mismatched model uploaded") } catch is TeachingError {}
        try await store.saveModel(bytes, id: paired.id)
        try await client.upload(project, modelURL: modelURL)
        try await client.upload(project, modelURL: modelURL)
        let returned = try JSONDecoder().decode(TeachingResult.self, from: await api("/sessions/\(ticket.id)/result", token: ticket.ownerToken))
        precondition(returned.id == project.result.id && returned.samples.count == 2 && returned.device.platform == "visionOS")
        try JSONEncoder().encode(returned).write(to: URL(fileURLWithPath: args[4]))
        print("Vision Pro: rigid transforms, optical axes, refined placement, mesh/point rendering, pairing, offline recovery, model checks and idempotent sync passed.")
    }
}
