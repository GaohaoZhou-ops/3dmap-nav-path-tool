import Foundation

@main struct DiscoveryTests {
    @MainActor static func main() async throws {
        let id = CommandLine.arguments[1], badID = CommandLine.arguments[2]
        let discovery = LANServiceDiscovery()
        discovery.start()
        let deadline = Date().addingTimeInterval(10)
        while !discovery.servers.contains(where: { $0.id == id }) && Date() < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        guard let found = discovery.servers.first(where: { $0.id == id }) else {
            throw TeachingError("Bonjour discovery failed: \(discovery.message)")
        }
        let info = try await LANClient(address: found.address).identify()
        precondition(info.serverId == id)
        try await Task.sleep(for: .seconds(2))
        precondition(discovery.servers.filter { $0.id == id }.count == 1, "multiple announcements for one server are deduplicated")
        precondition(!discovery.servers.contains { $0.id == badID }, "another protocol on a discovered port is rejected")
        discovery.stop()
        precondition(!discovery.isSearching)
        discovery.start()
        precondition(discovery.servers.isEmpty, "retry clears stale entries")
        discovery.stop()
        try await Task.sleep(for: .milliseconds(500))
        precondition(discovery.servers.isEmpty && !discovery.isSearching, "late callbacks after leaving the welcome page cannot restart discovery")
        print("Native Bonjour discovery, HTTP identification, deduplication, incompatible service rejection and cancellation passed.")
    }
}
