import Foundation

struct LANServiceInfo: Decodable {
    let `protocol`: String
    let serverId: String
    let serverName: String
    let port: Int
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
              url.path.isEmpty || url.path == "/" else { throw TeachingError("请输入电脑显示的局域网地址，例如 http://192.168.1.20:21990") }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        let ipv4 = octets.count == 4 && octets.allSatisfy { (0...255).contains($0) }
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
    func pair(code: String, deviceID: String, name: String) async throws -> PairedSession {
        let code = PairingCode.normalize(code)
        guard PairingCode.isValid(code) else { throw TeachingError("请输入 4 位配对码，仅支持大写字母 A–Z 和数字 0–9") }
        let body = try JSONSerialization.data(withJSONObject: ["code": code, "deviceId": deviceID, "deviceName": name])
        let (data, response) = try await Self.session.data(for: request("pair", method: "POST", body: body))
        try check(response, data: data)
        return try JSONDecoder().decode(PairedSession.self, from: data)
    }
    func download(_ paired: PairedSession) async throws -> Data {
        guard UUID(uuidString: paired.id) != nil else { throw TeachingError("配对任务标识无效") }
        let (url, response) = try await Self.session.download(for: request("sessions/\(paired.id)/model", token: paired.deviceToken))
        defer { try? FileManager.default.removeItem(at: url) }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= maximumModelBytes else { throw TeachingError("物体超过 iPad 传输上限（192 MiB）") }
        let data = try Data(contentsOf: url); try check(response, data: data); return data
    }
    func upload(_ project: LocalProject) async throws {
        guard project.result.completedAt != nil, !project.result.samples.isEmpty else { throw TeachingError("示教尚未完成") }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let (data, response) = try await Self.session.data(for: request("sessions/\(project.id)/result", token: project.session.deviceToken,
            method: "POST", body: try encoder.encode(project.result)))
        try check(response, data: data)
        struct Receipt: Decodable { var id: String; var received: Bool; var sampleCount: Int }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.received, receipt.id == project.result.id, receipt.sampleCount == project.result.samples.count else { throw TeachingError("同步回执与示教结果不匹配") }
    }
}
