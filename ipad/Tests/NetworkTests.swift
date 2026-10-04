import Foundation
import CryptoKit
import simd

@main struct NetworkTests {
    static func main() async throws {
        let args = CommandLine.arguments
        let address = args[1], fixture = URL(fileURLWithPath: args[2]), storeURL = URL(fileURLWithPath: args[3])
        for valid in ["", "0", "1", "99", "100", "254", "255", "001"] { precondition(IPv4Input.acceptsOctet(valid)) }
        for invalid in ["256", "999", "1234", "-1", "+1", "1a", "1.2", " 1", "２５５"] { precondition(!IPv4Input.acceptsOctet(invalid)) }
        precondition(IPv4Input.octets("192.168.0.255") == ["192", "168", "0", "255"])
        precondition(IPv4Input.octets("192.168..1", allowingEmpty: true) == ["192", "168", "", "1"])
        for invalid in ["192.168..1", "192.168.0.256", "1.2.3", "1.2.3.4.5", "http://192.168.0.1", "192.168.0.1:21990"] {
            precondition(IPv4Input.octets(invalid) == nil, "reject an entire invalid paste instead of changing its address")
        }
        var fields = LANAddressInput()
        precondition(fields.host.isEmpty && fields.port == "21990" && !fields.canConnect)
        fields.host = "192.168.1.20"
        precondition(fields.address == "http://192.168.1.20:21990" && fields.canConnect)
        fields.port = "22001"
        precondition(fields.address == "http://192.168.1.20:22001" && fields.canConnect)
        fields.port = ""
        precondition(fields.effectivePort == "21990" && fields.canConnect, "empty port uses the default")
        for port in ["0", "65536", "-1", "abc", "21990/path"] {
            fields.port = port; precondition(!fields.canConnect, "invalid ports must not enable pairing")
        }
        fields.port = "21990"
        for host in ["192.168.1", "192.168.1.999", "8.8.8.8", "192.168.1.20/path", "http://192.168.1.20"] {
            fields.host = host; precondition(!fields.canConnect, "the host field must not turn into another URL")
        }
        let restored = LANAddressInput(address: "http://192.168.1.20:22001")
        precondition(restored.host == "192.168.1.20" && restored.port == "22001" && restored.canConnect)
        precondition(restored.displayAddress == "192.168.1.20:22001", "visible addresses omit the scheme")
        let secure = LANAddressInput(address: "https://studio.local")
        precondition(secure.address == "https://studio.local:443" && secure.canConnect, "preserve existing saved endpoints")
        precondition(LANAddressInput(address: "192.168.1.20").port == "21990")
        let manifest = try JSONDecoder().decode(ModelManifest.self, from: Data(contentsOf: fixture.appendingPathExtension("json")))
        let model = try Data(contentsOf: fixture.appendingPathExtension("atls"))
        func api(_ path: String, method: String = "GET", token: String? = nil, body: Data? = nil) async throws -> Data {
            var request = URLRequest(url: URL(string: address + "/__atlas/ipad" + path)!)
            request.httpMethod = method; request.httpBody = body
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
                throw TeachingError("Test API failed: \(String(decoding: data, as: UTF8.self))")
            }
            return data
        }
        struct Creation: Decodable { var id: String; var ownerToken: String; var pairingCode: String }
        let body = try JSONSerialization.data(withJSONObject: ["manifest": JSONSerialization.jsonObject(with: JSONEncoder().encode(manifest))])
        let creation = try JSONDecoder().decode(Creation.self, from: await api("/sessions", method: "POST", body: body))
        precondition(creation.pairingCode.count == 4 && PairingCode.isValid(creation.pairingCode))
        _ = try await api("/sessions/\(creation.id)/model", method: "PUT", token: creation.ownerToken, body: model)
        let client = try LANClient(address: LANAddressInput(address: address).address)
        let info = try await client.identify()
        precondition(info.protocol == teachingProtocol && !info.serverName.isEmpty, "identify a real teaching service before offering it")
        for invalid in ["", "A12", "ABCDE", "A1-2", "A1B2C3D4E5F6", "中文12"] {
            do { _ = try await client.pair(code: invalid, deviceID: UUID().uuidString, name: "Invalid input"); preconditionFailure("invalid code sent") }
            catch let error as TeachingError { precondition(error.message.contains("4 位配对码")) }
        }
        for valid in ["1234", "WXYZ", "q7z2"] { precondition(PairingCode.isValid(valid)) }
        let paired = try await client.pair(code: " " + creation.pairingCode.lowercased() + " ", deviceID: UUID().uuidString, name: "Native Swift Test")
        let downloaded = try await client.download(paired)
        precondition(downloaded == model, "native model download")
        let store = ProjectStore(directory: storeURL)
        var result = TeachingResult(sessionId: paired.id, modelHash: manifest.modelHash)
        let calibration = Calibration(worldFromModel: TeachingCoordinates.zUpToAR.elements, referencePoint: Point3(SIMD3.zero), yawDegrees: 0)
        result.calibrations = [calibration]
        result.samples = [TeachingSample(name: "Pose 001", segmentId: calibration.id, kind: "keyframe",
            cameraPose: TeachingCoordinates.opticalPose(camera: matrix_identity_float4x4, worldFromModel: TeachingCoordinates.zUpToAR))]
        var project = LocalProject(serverURL: address, session: paired, result: result)
        let legacy = try JSONDecoder().decode(LocalProject.self, from: JSONEncoder().encode(project))
        precondition(legacy.displaySettings == nil, "older projects load without display settings")
        project.displaySettings = ModelDisplaySettings(mode: .points, pointDensity: .quarter, meshQuality: .detail)
        try await store.saveModel(downloaded, id: paired.id)
        try await store.save(project)
        // Recreate the store, as after termination, and recover without any server request.
        let reopened = ProjectStore(directory: storeURL)
        let local = try await reopened.projects()
        precondition(local.count == 1 && local[0].result.samples[0].name == "Pose 001", "offline Pose recovery")
        precondition(local[0].displaySettings == project.displaySettings, "display settings survive reopening alongside unchanged poses")
        let localModel = try await reopened.model(paired.id)
        precondition(localModel == model, "offline model recovery")
        let modelURL = try await reopened.modelURL(project.id)
        do { try await client.upload(project, modelURL: modelURL); preconditionFailure("unfinished work must never upload") }
        catch let error as TeachingError { precondition(error.message == "示教尚未完成") }
        project.result.completedAt = timestamp()
        try await store.save(project)
        let savedBefore = try Data(contentsOf: storeURL.appendingPathComponent(project.id).appendingPathExtension("json"))
        precondition(model.count > 1024 * 1024, "exercise more than one file hashing chunk")
        var changedModel = model; changedModel[model.count - 1] ^= 1
        try await store.saveModel(changedModel, id: paired.id)
        do { try await client.upload(project, modelURL: modelURL); preconditionFailure("local model mismatch uploaded poses") }
        catch let error as TeachingError { precondition(error.message.contains("本地模型内容")) }
        try FileManager.default.removeItem(at: modelURL)
        do { try await client.upload(project, modelURL: modelURL); preconditionFailure("missing local model uploaded poses") }
        catch let error as TeachingError { precondition(error.message.contains("无法读取")) }
        try await store.saveModel(model, id: paired.id)
        let remoteModelURL = URL(fileURLWithPath: args[4]).appendingPathComponent(paired.id).appendingPathComponent("model.atls")
        try changedModel.write(to: remoteModelURL)
        do { try await client.upload(project, modelURL: modelURL); preconditionFailure("same-name remote model mismatch uploaded poses") }
        catch let error as TeachingError { precondition(error.message.contains("模型文件已改变"), error.message) }
        try FileManager.default.removeItem(at: remoteModelURL)
        do { try await client.upload(project, modelURL: modelURL); preconditionFailure("missing remote model uploaded poses") }
        catch let error as TeachingError { precondition(error.message.contains("缺少配对时的模型文件"), error.message) }
        try model.write(to: remoteModelURL)
        let savedAfter = try Data(contentsOf: storeURL.appendingPathComponent(project.id).appendingPathExtension("json"))
        precondition(savedBefore == savedAfter, "failed model checks must preserve every local Pose")
        // Names and display settings do not participate in the file comparison.
        project.session.manifest.name = "renamed-workpiece.ply"
        project.displaySettings = ModelDisplaySettings(mode: .mesh, pointDensity: .full, meshQuality: .performance)
        try await client.upload(project, modelURL: modelURL)
        try await client.upload(project, modelURL: modelURL) // lost response retry verifies again
        let received = try JSONDecoder().decode(TeachingResult.self, from: await api("/sessions/\(paired.id)/result", token: creation.ownerToken))
        precondition(received.samples.count == 1 && received.id == result.id, "native completion receipt")
        for address in ["https://example.com", "http://192.168.1.2@outside.com", "http://192.168.1.2/path", "http://8.8.8.8"] {
            do { _ = try LANClient(address: address); preconditionFailure("non-LAN address accepted") } catch {}
        }
        print("IPv4/port input, pairing, offline recovery, pre-sync model checks, local/remote mismatch and missing-file rejection, Pose preservation and verified retry passed.")
    }
}
