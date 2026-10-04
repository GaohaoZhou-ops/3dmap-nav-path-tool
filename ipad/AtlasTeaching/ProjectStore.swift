import Foundation

// A serial actor orders writes so a delayed autosave cannot replace a completed result.
actor ProjectStore {
    static let shared = ProjectStore()
    private let directory: URL?
    init(directory: URL? = nil) { self.directory = directory }
    private func root() throws -> URL {
        var root: URL
        if let directory { root = directory }
        else { root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AtlasTeaching", isDirectory: true) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true; try root.setResourceValues(values)
        return root
    }
    private func file(_ id: String, ext: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw TeachingError("本地任务标识无效") }
        return try root().appendingPathComponent(id).appendingPathExtension(ext)
    }
    func save(_ project: LocalProject) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(project).write(to: file(project.id, ext: "json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func saveModel(_ data: Data, id: String) throws { try data.write(to: file(id, ext: "atls"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    func model(_ id: String) throws -> Data { try Data(contentsOf: file(id, ext: "atls"), options: .mappedIfSafe) }
    func modelURL(_ id: String) throws -> URL { try file(id, ext: "atls") }
    func projects() throws -> [LocalProject] {
        let files = try FileManager.default.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        return try files.map { try JSONDecoder().decode(LocalProject.self, from: Data(contentsOf: $0)) }
            .sorted { $0.result.createdAt > $1.result.createdAt }
    }
}
