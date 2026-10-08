import Foundation
import UIKit

@MainActor
final class TeachingSession: ObservableObject {
    @Published var projects: [LocalProject] = []
    @Published var current: LocalProject?
    @Published var busy = false
    @Published private(set) var openingProjectID: String?
    @Published var error = ""
    @Published var status = ""
    @Published var serverConnection = LANAddressInput(address: UserDefaults.standard.string(forKey: "serverAddress") ?? "")
    var serverAddress: String {
        get { serverConnection.address }
        set { serverConnection = LANAddressInput(address: newValue) }
    }
    @Published var code = ""
    @Published var geometry: ModelGeometry?
    var displaySettings: ModelDisplaySettings { current?.displaySettings ?? ModelDisplaySettings() }
    private var saveTask: Task<Void, Never>?
    private var lastSaved = Date.distantPast
    private var deviceID: String {
        if let id = UserDefaults.standard.string(forKey: "deviceID") { return id }
        let id = UUID().uuidString; UserDefaults.standard.set(id, forKey: "deviceID"); return id
    }
    func reload() async {
        do { projects = try await ProjectStore.shared.projects() } catch { self.error = "读取本地草稿失败：\(error.localizedDescription)" }
    }
    func pair(qr: PairingQRCode? = nil) async {
        guard !busy else { return }; busy = true; error = ""; defer { busy = false }
        do {
            if let qr { try qr.validate(); serverAddress = qr.address; code = PairingCode.normalize(qr.code) }
            let client = try LANClient(address: qr?.address ?? serverAddress)
            status = "连接电脑并配对…"
            let paired = try await client.pair(code: code, deviceID: deviceID, name: TeachingDevice.current.model, qr: qr)
            status = "通过局域网下载物体…"
            let data = try await client.download(paired)
            let geometry = try await Task.detached { try ModelGeometry(data: data, manifest: paired.manifest) }.value
            let existing = projects.first { $0.id == paired.id }
            var project = existing ?? LocalProject(serverURL: client.baseURL.absoluteString, session: paired,
                result: TeachingResult(sessionId: paired.id, modelHash: paired.manifest.modelHash))
            project.displaySettings = (project.displaySettings ?? ModelDisplaySettings()).forOpening()
            project.session = paired; project.serverURL = client.baseURL.absoluteString
            try await ProjectStore.shared.saveModel(data, id: paired.id)
            try await ProjectStore.shared.save(project)
            UserDefaults.standard.set(client.baseURL.absoluteString, forKey: "serverAddress")
            self.geometry = geometry; current = project; status = "物体已保存到 \(TeachingDevice.storageName)，可以断开网络"
            await reload()
        } catch { self.error = "接收失败：\(error.localizedDescription)"; status = "请检查局域网地址、配对码与本地网络权限" }
    }
    func open(_ project: LocalProject) async {
        guard !busy else { return }; busy = true; error = ""; openingProjectID = project.id
        defer { busy = false; openingProjectID = nil }
        do {
            let data = try await ProjectStore.shared.model(project.id)
            geometry = try await Task.detached(priority: .userInitiated) { try ModelGeometry(data: data, manifest: project.session.manifest) }.value
            var opened = project
            opened.displaySettings = (project.displaySettings ?? ModelDisplaySettings()).forOpening()
            current = opened; serverAddress = project.serverURL
            status = project.result.completedAt == nil ? "已恢复本地草稿，请重新校准物体" : "示教已完成，等待同步或已同步"
        } catch { self.error = error.localizedDescription }
    }
    func addCalibration(_ calibration: Calibration) {
        guard current?.result.completedAt == nil else { return }
        current?.result.calibrations.append(calibration); scheduleSave(force: true)
    }
    func setDisplaySettings(_ settings: ModelDisplaySettings) {
        guard current != nil, settings != displaySettings else { return }
        current?.displaySettings = settings
        scheduleSave(force: true)
    }
    @discardableResult
    func addSample(_ sample: TeachingSample) -> Bool {
        guard !busy, error.isEmpty, let project = current, project.result.completedAt == nil,
              project.result.samples.count < maximumSamples,
              project.result.calibrations.contains(where: { $0.id == sample.segmentId }),
              !project.result.samples.contains(where: { $0.id == sample.id }) else { return false }
        var named = sample
        named.name = String(format: "Pose %03d", project.result.samples.count + 1)
        current?.result.samples.append(named); scheduleSave(force: true)
        return true
    }
    func renameSample(_ id: String, name: String) {
        guard current?.result.completedAt == nil, let index = current?.result.samples.firstIndex(where: { $0.id == id }) else { return }
        let value = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        if !value.isEmpty { current?.result.samples[index].name = value; scheduleSave(force: true) }
    }
    func deleteSample(_ id: String) {
        deleteSamples([id])
    }
    func deleteSamples(_ ids: Set<String>) {
        guard !busy, !ids.isEmpty, let project = current, project.result.completedAt == nil else { return }
        let remaining = project.result.samples.filter { !ids.contains($0.id) }
        guard remaining.count != project.result.samples.count else { return }
        current?.result.samples = remaining
        scheduleSave(force: true)
    }
    private func scheduleSave(force: Bool = false) {
        guard let project = current, force || Date().timeIntervalSince(lastSaved) >= 1 else { return }
        lastSaved = Date()
        let prior = saveTask
        saveTask = Task {
            await prior?.value
            do { try await ProjectStore.shared.save(project); status = "已自动保存到 \(TeachingDevice.storageName) · \(project.result.samples.count) 个采样" }
            catch { self.error = "本地保存失败：\(error.localizedDescription)" }
        }
    }
    func saveNow() async throws {
        await saveTask?.value
        if let current { try await ProjectStore.shared.save(current) }
    }
    func backgroundSave() {
        let identifier = UIApplication.shared.beginBackgroundTask(expirationHandler: nil)
        Task {
            do { try await saveNow() } catch { self.error = error.localizedDescription }
            if identifier != .invalid { UIApplication.shared.endBackgroundTask(identifier) }
        }
    }
    func close() async {
        do { try await saveNow(); current = nil; geometry = nil; await reload() }
        catch { self.error = "保存失败，草稿仍在当前界面：\(error.localizedDescription)" }
    }
    func finish(sync: Bool) async {
        guard !busy, var project = current, !project.result.samples.isEmpty else { return }
        busy = true; error = ""; defer { busy = false }
        do {
            guard !sync || project.result.device.platform != "visionOS-simulator" else {
                throw TeachingError("模拟演练数据只能保存在本机，不能同步")
            }
            await saveTask?.value
            if project.result.completedAt == nil { project.result.completedAt = timestamp() }
            // Freeze before any network call. A failed/ambiguous upload can retry the same bytes.
            current = project; try await ProjectStore.shared.save(project)
            if sync {
                let client = try LANClient(address: serverAddress)
                project.serverURL = client.baseURL.absoluteString; current = project
                try await ProjectStore.shared.save(project)
                status = "正在核对 \(TeachingDevice.storageName) 与电脑的模型文件…"
                let modelURL = try await ProjectStore.shared.modelURL(project.id)
                try await client.upload(project, modelURL: modelURL) {
                    self.status = "模型一致，正在通过局域网上传 Pose…"
                }
                project.syncedAt = timestamp(); current = project; try await ProjectStore.shared.save(project)
                status = "同步成功，请在电脑端点击「检查完成状态」并接收结果"
            } else { status = "示教已完成并保存在 \(TeachingDevice.storageName)，返回局域网后点击同步" }
            await reload()
        } catch { self.error = "结果保留在 \(TeachingDevice.storageName)，可重试：\(error.localizedDescription)"; status = "尚未确认同步成功" }
    }
}
