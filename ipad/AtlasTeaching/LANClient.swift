import Foundation
import CryptoKit

struct ModelFileIdentity: Codable {
    let modelHash: String
    let byteLength: Int

    static func read(from url: URL) throws -> ModelFileIdentity {
        let file: FileHandle
        do { file = try FileHandle(forReadingFrom: url) }
        catch { throw TeachingError("无法读取 \(TeachingDevice.storageName) 本地模型文件，已停止同步；本地 Pose 仍保留") }
        defer { try? file.close() }
        var digest = SHA256(), byteLength = 0
        while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            try Task.checkCancellation()
            byteLength += chunk.count
            guard byteLength <= maximumModelBytes else { throw TeachingError("\(TeachingDevice.storageName) 本地模型文件大小异常，已停止同步") }
            digest.update(data: chunk)
        }
        guard byteLength >= 48 else { throw TeachingError("\(TeachingDevice.storageName) 本地模型文件不完整，已停止同步") }
        return ModelFileIdentity(modelHash: digest.finalize().map { String(format: "%02x", $0) }.joined(), byteLength: byteLength)
    }
}

struct LANAddressInput {
    static let defaultPort = "21990"
    var host = ""
    var port = defaultPort
    private var scheme = "http"

    init(address: String = "") {
        let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let explicitScheme = text.contains("://")
        guard let parts = URLComponents(string: explicitScheme ? text : "http://\(text)"),
              let host = parts.host, !host.isEmpty, ["http", "https"].contains(parts.scheme),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { self.host = text; return }
        self.host = host; scheme = parts.scheme ?? "http"
        // Preserve an explicit URL's standard port when reopening older projects.
        port = parts.port.map(String.init) ?? (explicitScheme ? (scheme == "https" ? "443" : "80") : Self.defaultPort)
    }
    var effectivePort: String {
        let value = port.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? Self.defaultPort : value
    }
    var displayAddress: String { "\(host):\(effectivePort)" }
    var address: String {
        let host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        return host.isEmpty ? "" : "\(scheme)://\(host):\(effectivePort)"
    }
    var canConnect: Bool {
        guard effectivePort.utf8.allSatisfy({ (48...57).contains($0) }),
              let port = Int(effectivePort), (1...65535).contains(port),
              let client = try? LANClient(address: address) else { return false }
        return client.baseURL.host?.lowercased() == host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct LANServiceInfo: Decodable {
    let `protocol`: String
    let serverId: String
    let serverName: String
    let port: Int
}

struct PairingQRCode: Decodable {
    let `protocol`: String
    let address: String
    let code: String
    let sessionId: String
    let serverId: String
    let expiresAt: Double

    static func parse(_ text: String) throws -> PairingQRCode {
        guard text.utf8.count <= 2048, let data = text.data(using: .utf8),
              let value = try? JSONDecoder().decode(Self.self, from: data) else {
            throw TeachingError("这不是 Atlas 配对二维码，请扫描电脑「iPad 运行」窗口中的二维码")
        }
        try value.validate()
        return value
    }
    func validate() throws {
        guard self.protocol == "atlas-ipad-pairing/1", PairingCode.isValid(code),
              UUID(uuidString: sessionId) != nil, UUID(uuidString: serverId) != nil, expiresAt.isFinite else {
            throw TeachingError("二维码格式不支持，请在电脑上更新配对码后重新扫描")
        }
        _ = try LANClient(address: address)
        guard expiresAt > Date().timeIntervalSince1970 * 1000 else {
            throw TeachingError("二维码已过期，请在电脑点击「更新配对码」后重新扫描")
        }
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct LANClient {
    let baseURL: URL
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.allowsCellularAccess = false; config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 300
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }()
    init(address: String) throws {
        let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text.contains("://") ? text : "http://\(text)"),
              ["http", "https"].contains(url.scheme), let host = url.host,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw TeachingError("请检查电脑的 IPv4 地址与端口，例如 192.168.1.20，端口 21990") }
        guard url.port == nil || (1...65535).contains(url.port!) else { throw TeachingError("局域网端口无效") }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        let octets = parts.compactMap { Int($0) }
        let ipv4 = parts.count == 4 && octets.count == 4 && octets.allSatisfy { (0...255).contains($0) }
            && parts.allSatisfy { !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } }
        let localIPv4 = ipv4 && (octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 169 && octets[1] == 254))
        guard localIPv4 || host.hasSuffix(".local") || host == "localhost" else { throw TeachingError("仅支持局域网 IPv4 地址或 .local 主机名") }
        baseURL = url
    }
    private func request(_ path: String, token: String? = nil, method: String = "GET", body: Data? = nil) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent("__atlas/ipad/\(path)"))
        request.httpMethod = method; request.httpBody = body
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }
    private func check(_ response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
            struct ErrorResponse: Decodable { var error: String }
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
            throw TeachingError(message ?? "局域网服务未返回有效响应，请检查电脑地址和网络")
        }
    }
    // Discovery is read-only and bounded; another HTTP service is never a match.
    func identify() async throws -> LANServiceInfo {
        var request = request("info")
        request.timeoutInterval = 3
        let (bytes, response) = try await Self.session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              response.expectedContentLength <= 16_384 else { throw TeachingError("不是可用的 Atlas 示教服务") }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 16_384 else { throw TeachingError("服务信息过大") }
            data.append(byte)
        }
        let info = try JSONDecoder().decode(LANServiceInfo.self, from: data)
        guard info.protocol == teachingProtocol, UUID(uuidString: info.serverId) != nil,
              !info.serverName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, info.serverName.count <= 120,
              info.port == (baseURL.port ?? (baseURL.scheme == "https" ? 443 : 80)) else {
            throw TeachingError("不是兼容的 Atlas 示教服务")
        }
        return info
    }
    func pair(code: String, deviceID: String, name: String, qr: PairingQRCode? = nil) async throws -> PairedSession {
        let code = PairingCode.normalize(code)
        guard PairingCode.isValid(code) else { throw TeachingError("请输入 4 位配对码，仅支持大写字母 A–Z 和数字 0–9") }
        var fields = ["code": code, "deviceId": deviceID, "deviceName": name]
        if let qr {
            try qr.validate()
            guard try LANClient(address: qr.address).baseURL == baseURL, PairingCode.normalize(qr.code) == code else {
                throw TeachingError("二维码配对信息已变更，请重新扫描")
            }
            let info = try await identify()
            guard info.serverId == qr.serverId else { throw TeachingError("电脑服务已重启或地址已变更，请重新打开电脑配对窗口并扫码") }
            fields["sessionId"] = qr.sessionId; fields["serverId"] = qr.serverId
        }
        let body = try JSONSerialization.data(withJSONObject: fields)
        let (data, response) = try await Self.session.data(for: request("pair", method: "POST", body: body))
        try check(response, data: data)
        let paired = try JSONDecoder().decode(PairedSession.self, from: data)
        if let qr, paired.id != qr.sessionId { throw TeachingError("接收任务与二维码不匹配，请重新扫描") }
        return paired
    }
    func download(_ paired: PairedSession) async throws -> Data {
        guard UUID(uuidString: paired.id) != nil else { throw TeachingError("配对任务标识无效") }
        let (url, response) = try await Self.session.download(for: request("sessions/\(paired.id)/model", token: paired.deviceToken))
        defer { try? FileManager.default.removeItem(at: url) }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= maximumModelBytes else { throw TeachingError("物体超过 移动端传输上限（192 MiB）") }
        let data = try Data(contentsOf: url); try check(response, data: data); return data
    }
    func upload(_ project: LocalProject, modelURL: URL, onModelVerified: @MainActor () -> Void = {}) async throws {
        guard project.result.completedAt != nil, !project.result.samples.isEmpty else { throw TeachingError("示教尚未完成") }
        guard UUID(uuidString: project.id) != nil, project.result.sessionId == project.id else { throw TeachingError("本地模型与配对任务不匹配，已停止同步") }
        let identity = try await Task.detached { try ModelFileIdentity.read(from: modelURL) }.value
        try Task.checkCancellation()
        guard identity.modelHash == project.session.manifest.modelHash,
              identity.byteLength == project.session.manifest.byteLength,
              identity.modelHash == project.result.modelHash else {
            throw TeachingError("\(TeachingDevice.storageName) 本地模型内容与配对时不一致，已停止同步；请恢复原模型，本地 Pose 仍保留")
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        // Send only the model fingerprint first. No poses are sent until both files match.
        let (verificationData, verificationResponse) = try await Self.session.data(for: request("sessions/\(project.id)/verify-model",
            token: project.session.deviceToken, method: "POST", body: try encoder.encode(identity)))
        try check(verificationResponse, data: verificationData)
        struct Verification: Decodable { var sessionId: String; var modelHash: String; var byteLength: Int; var verified: Bool }
        let verification = try JSONDecoder().decode(Verification.self, from: verificationData)
        guard verification.verified, verification.sessionId == project.id,
              verification.modelHash == identity.modelHash, verification.byteLength == identity.byteLength else {
            throw TeachingError("电脑返回的模型校验结果不匹配，已停止同步；本地 Pose 仍保留")
        }
        try Task.checkCancellation()
        await onModelVerified()
        let (data, response) = try await Self.session.data(for: request("sessions/\(project.id)/result", token: project.session.deviceToken,
            method: "POST", body: try encoder.encode(project.result)))
        try check(response, data: data)
        struct Receipt: Decodable { var id: String; var received: Bool; var sampleCount: Int }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.received, receipt.id == project.result.id, receipt.sampleCount == project.result.samples.count else { throw TeachingError("同步回执与示教结果不匹配") }
    }
}
