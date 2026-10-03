import Foundation
import Combine
import Network

struct DiscoveredTeachingServer: Identifiable {
    let id: String
    let name: String
    let address: String
}

@MainActor
final class LANServiceDiscovery: ObservableObject {
    static let serviceType = "_atlas-teach._tcp"
    @Published private(set) var servers: [DiscoveredTeachingServer] = []
    @Published private(set) var isSearching = false
    @Published private(set) var message = "可搜索同一局域网内的电脑"
    private var browser: NWBrowser?
    private var deadline: Task<Void, Never>?
    private var connections: [NWEndpoint: NWConnection] = [:]
    private var tasks: [NWEndpoint: Task<Void, Never>] = [:]
    private var attempted: Set<NWEndpoint> = []
    private var verified: [NWEndpoint: DiscoveredTeachingServer] = [:]
    private var generation = UUID()

    private func parameters() -> NWParameters {
        let parameters = NWParameters.tcp
        parameters.prohibitedInterfaceTypes = [.cellular]
        parameters.includePeerToPeer = false
        // The teaching protocol currently accepts LAN IPv4 and .local hosts.
        (parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
        return parameters
    }
    func start() {
        guard !isSearching else { return }
        stop(); servers = []; verified = [:]; attempted = []
        isSearching = true; message = "正在搜索局域网示教服务…"
        let generation = self.generation
        let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: "local."), using: parameters())
        self.browser = browser
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self, self.generation == generation else { return }
                switch state {
                case .failed(let error), .waiting(let error):
                    if case .dns(-65570) = error { // kDNSServiceErr_PolicyDenied
                        self.stop(); self.message = "请在系统设置中允许 Atlas 示教访问本地网络，再重新搜索。"
                    } else if case .failed = state {
                        self.stop(); self.message = "搜索暂不可用，请检查 Wi-Fi，也可手动填写电脑地址。"
                    }
                default: break
                }
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self, self.generation == generation else { return }
                self.update(results, generation: generation)
            }
        }
        browser.start(queue: .main)
        deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(12)) } catch { return }
            guard let self, self.generation == generation else { return }
            self.stop()
            self.message = self.servers.isEmpty
                ? "未找到服务。请确认电脑服务已启动、两台设备连接同一局域网；也可手动填写地址。"
                : "找到 \(self.servers.count) 个服务，点选后输入电脑上的配对码。"
        }
    }
    func stop() {
        generation = UUID()
        browser?.cancel(); browser = nil
        deadline?.cancel(); deadline = nil
        connections.values.forEach { $0.cancel() }; connections.removeAll()
        tasks.values.forEach { $0.cancel() }; tasks.removeAll()
        isSearching = false
    }
    private func update(_ results: Set<NWBrowser.Result>, generation: UUID) {
        let endpoints = Set(results.map(\.endpoint))
        for endpoint in attempted.subtracting(endpoints) {
            connections.removeValue(forKey: endpoint)?.cancel()
            tasks.removeValue(forKey: endpoint)?.cancel()
            verified.removeValue(forKey: endpoint); attempted.remove(endpoint)
        }
        refreshServers()
        for result in results where !attempted.contains(result.endpoint) && attempted.count < 16 {
            resolve(result.endpoint, generation: generation)
        }
    }
    private func resolve(_ endpoint: NWEndpoint, generation: UUID) {
        attempted.insert(endpoint)
        let connection = NWConnection(to: endpoint, using: parameters())
        connections[endpoint] = connection
        tasks[endpoint] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            guard let self, self.generation == generation else { return }
            self.connections.removeValue(forKey: endpoint)?.cancel()
            self.tasks.removeValue(forKey: endpoint)
        }
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            Task { @MainActor in
                guard let self, let connection, self.generation == generation,
                      self.connections[endpoint] === connection else { return }
                switch state {
                case .ready:
                    let remote = connection.currentPath?.remoteEndpoint
                    self.connections.removeValue(forKey: endpoint)?.cancel()
                    self.tasks.removeValue(forKey: endpoint)?.cancel()
                    guard case .hostPort(let host, let port) = remote,
                          case .ipv4(let ip) = host else { return }
                    // Bonjour endpoints carry an interface scope (such as %en0);
                    // HTTP IPv4 URLs use the four address octets without that scope.
                    let ipv4Host = ip.rawValue.map { String($0) }.joined(separator: ".")
                    let address = "http://\(ipv4Host):\(port.rawValue)"
                    self.tasks[endpoint] = Task { [weak self] in
                        do {
                            let info = try await LANClient(address: address).identify()
                            try Task.checkCancellation()
                            guard let self, self.generation == generation, self.attempted.contains(endpoint) else { return }
                            self.verified[endpoint] = DiscoveredTeachingServer(id: info.serverId, name: info.serverName, address: address)
                            self.refreshServers()
                            self.message = "找到 \(self.servers.count) 个服务，点选后输入电脑上的配对码。"
                        } catch { /* Ignore unrelated, unreachable or incompatible services. */ }
                        if let self, self.generation == generation { self.tasks.removeValue(forKey: endpoint) }
                    }
                case .failed, .cancelled:
                    self.connections.removeValue(forKey: endpoint)?.cancel()
                    self.tasks.removeValue(forKey: endpoint)?.cancel()
                default: break
                }
            }
        }
        connection.start(queue: .main)
    }
    private func refreshServers() {
        var unique: [String: DiscoveredTeachingServer] = [:]
        for server in verified.values { unique[server.id] = server }
        servers = unique.values.sorted { $0.name == $1.name ? $0.address < $1.address : $0.name < $1.name }
    }
    deinit {
        browser?.cancel(); deadline?.cancel()
        connections.values.forEach { $0.cancel() }
        tasks.values.forEach { $0.cancel() }
    }
}
