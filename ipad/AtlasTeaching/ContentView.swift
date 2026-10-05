import SwiftUI
import SceneKit

private let accent = Color(red: 0.35, green: 0.86, blue: 0.91)

struct ContentView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var discovery = LANServiceDiscovery()
    @State private var scanning = false
    @State private var scannedCode: PairingQRCode?
    @State private var codeFocused = false
    var body: some View {
        GeometryReader { viewport in
        Group {
            if let project = session.current, let geometry = session.geometry {
                TeachingView(projectID: project.id, geometry: geometry)
            } else { library }
        }.frame(width: viewport.size.width, height: viewport.size.height)
        }.tint(accent).task { await session.reload() }
    }
    private var library: some View {
        GeometryReader { viewport in
            let wide = viewport.size.width >= 1000 && viewport.size.width > viewport.size.height
            let padding: CGFloat = viewport.size.width >= 700 ? 28 : 20
            let panelHeight: CGFloat = wide ? max(360, viewport.size.height - 208) : 0
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    libraryHeader
                    if !ARController.supported {
                        Label("空间定位需要配备 LiDAR 的 iPad Pro 真机。当前设备可接收、查看物体和已有 Pose。", systemImage: "info.circle")
                            .font(.callout).foregroundStyle(.orange).padding().frame(maxWidth: .infinity, alignment: .leading)
                            .background(.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                    }
                    if wide {
                        HStack(alignment: .top, spacing: 24) {
                            pairingPanel(minHeight: panelHeight).frame(width: min(420, viewport.size.width * 0.35))
                            localProjectsPanel(minHeight: panelHeight).frame(maxWidth: .infinity)
                        }
                    } else {
                        pairingPanel(minHeight: 0).fixedSize(horizontal: false, vertical: true)
                        localProjectsPanel(minHeight: 0).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(padding)
                .frame(minHeight: viewport.size.height, alignment: .topLeading)
                .accessibilityElement(children: .contain).accessibilityIdentifier("library-content")
            }
            .frame(width: viewport.size.width, height: viewport.size.height)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Color(red: 0.025, green: 0.05, blue: 0.065).ignoresSafeArea())
        .sheet(isPresented: $scanning, onDismiss: finishScanning) {
            PairingScannerView { qr in scannedCode = qr; scanning = false }
        }
        .onAppear { if !scanning { discovery.start() } }
        .onDisappear { discovery.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && session.current == nil && !scanning { discovery.start() }
            else { discovery.stop() }
        }
    }
    private func finishScanning() {
        if let qr = scannedCode {
            scannedCode = nil
            Task { await session.pair(qr: qr) }
        } else { discovery.start() }
    }
    private func beginScanning() {
        codeFocused = false; discovery.stop()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        // Finish the native field's resignation before SwiftUI presents the camera.
        DispatchQueue.main.async { scanning = true }
    }
    private var libraryHeader: some View {
        HStack(alignment: .center, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
                Text("ATLAS / IPAD PRO").font(.system(.caption, design: .monospaced)).tracking(3).foregroundStyle(accent)
                Text("虚拟示教").font(.largeTitle.weight(.medium))
                Text("每次记录一个 Pose。本机完成定位和保存，结束后通过局域网同步。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "ipad.landscape").font(.system(size: 60, weight: .ultraLight)).foregroundStyle(accent)
                .accessibilityHidden(true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func pairingPanel(minHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("从电脑接收物体", systemImage: "wifi").font(.title2.weight(.medium))
            discoveryPanel
            LANAddressFields(address: $session.serverConnection).disabled(session.busy)
            VStack(alignment: .leading, spacing: 8) {
                Text("4 位配对码 · 大写字母或数字").font(.caption).foregroundStyle(.secondary)
                pairingCodeInput
            }
            Button { Task { await session.pair() } } label: {
                Label("接收物体", systemImage: "arrow.down.circle").frame(maxWidth: .infinity).padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent).disabled(session.busy || !session.serverConnection.canConnect || !PairingCode.isValid(session.code))
            .accessibilityIdentifier("receive-model")
            if session.busy { ProgressView() }
            if !session.error.isEmpty { Text(session.error).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
            Spacer(minLength: 4)
            if !session.status.isEmpty {
                Text(session.status).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .contain).accessibilityIdentifier("library-pairing-panel")
    }
    private var pairingCodeInput: some View {
        let characters = Array(session.code)
        let invalid = characters.count > 4 || characters.contains { !$0.isASCII || !("A"..."Z").contains(String($0)) && !("0"..."9").contains(String($0)) }
        return VStack(alignment: .leading, spacing: 8) {
            PairingCodeField(code: $session.code, isFocused: $codeFocused)
                .frame(maxWidth: .infinity).frame(height: 58).disabled(session.busy)
            if invalid { Text("请输入 4 位字母或数字").font(.caption).foregroundStyle(.orange) }
        }
    }
    private var discoveryPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button(action: beginScanning) {
                    Label("扫码配对", systemImage: "qrcode.viewfinder")
                }.buttonStyle(.borderedProminent).font(.callout)
                    .disabled(session.busy).accessibilityIdentifier("scan-pairing-code")
                Button { discovery.start() } label: {
                    Label("搜索局域网服务", systemImage: "network")
                }.buttonStyle(.bordered).font(.callout)
                    .disabled(discovery.isSearching || session.busy).accessibilityIdentifier("discover-services")
                Spacer(minLength: 4)
                if discovery.isSearching { ProgressView().controlSize(.small) }
            }
            if !discovery.servers.isEmpty {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(discovery.servers) { server in
                            Button {
                                session.serverAddress = server.address
                                session.error = ""
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "desktopcomputer").foregroundStyle(accent)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(server.name).font(.callout.weight(.medium)).lineLimit(1)
                                        Text(LANAddressInput(address: server.address).displayAddress).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: session.serverAddress == server.address ? "checkmark.circle.fill" : "plus.circle").foregroundStyle(accent)
                                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                            }.buttonStyle(.plain).disabled(session.busy)
                                .accessibilityIdentifier("discovered-service-\(server.id)")
                        }
                    }
                }.frame(height: min(CGFloat(discovery.servers.count) * 62, 124))
            }
            Text(discovery.message).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("discovery-status")
        }
    }
    private func localProjectsPanel(minHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Label("保存在此 iPad", systemImage: "square.stack.3d.up").font(.title2.weight(.medium))
                Spacer()
                Text("\(session.projects.count) 个物体").font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            if session.projects.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "cube.transparent").font(.system(size: 64, weight: .ultraLight)).foregroundStyle(accent.opacity(0.7))
                    Text("从电脑接收第一个物体").font(.headline)
                    Text("接收后，物体和示教草稿都会出现在这里。")
                        .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.frame(maxWidth: .infinity, minHeight: 230)
            } else {
                ForEach(session.projects) { project in
                    Button { Task { await session.open(project) } } label: {
                        HStack(spacing: 18) {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(project.session.manifest.name).font(.headline).multilineTextAlignment(.leading).lineLimit(3)
                                Text("\(project.result.samples.count) 个 Pose · \(project.syncedAt != nil ? "已同步" : project.result.completedAt != nil ? "已完成，待同步" : "本地草稿")")
                                    .font(.caption).foregroundStyle(.secondary)
                                if session.openingProjectID == project.id {
                                    ProgressView("轻量加载…").font(.caption).controlSize(.small)
                                        .accessibilityIdentifier("opening-model-progress")
                                }
                            }
                            Spacer(minLength: 4)
                            ProjectThumbnailView(project: project)
                                .frame(width: 150, height: 100)
                                .overlay(alignment: .topTrailing) {
                                    Image(systemName: "arrow.up.right").font(.caption.weight(.medium)).foregroundStyle(accent)
                                        .padding(7).background(.black.opacity(0.5), in: Circle()).padding(6)
                                }
                                .allowsHitTesting(false)
                        }
                        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 14))
                    }.buttonStyle(.plain).disabled(session.busy).accessibilityIdentifier("local-project-\(project.id)")
                }
            }
            Spacer(minLength: 12)
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
        .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.06)))
        .accessibilityElement(children: .contain).accessibilityIdentifier("library-projects-panel")
    }

}

private struct LANAddressFields: View {
    @Binding var address: LANAddressInput
    @State private var hostError = ""
    @FocusState private var portFocused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) { hostFields.frame(minWidth: 224); portField }
                VStack(alignment: .leading, spacing: 12) { hostFields; portField }
            }
            if !hostError.isEmpty { Text(hostError).font(.caption).foregroundStyle(.orange).accessibilityIdentifier("server-address-error") }
            // Older saved .local endpoints remain visible until replaced with an IPv4 address.
            if !address.host.isEmpty && IPv4Input.octets(address.host, allowingEmpty: true) == nil {
                Text("当前地址：\(address.host)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .onChange(of: address.host) { _, _ in hostError = "" }
    }
    private var hostFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("IPv4 地址").font(.caption).foregroundStyle(.secondary)
            IPv4AddressField(host: $address.host, error: $hostError) { portFocused = true }
                .frame(maxWidth: .infinity).frame(height: 44)
        }.frame(maxWidth: .infinity)
    }
    private var portField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("端口").font(.caption).foregroundStyle(.secondary)
            TextField(LANAddressInput.defaultPort, text: $address.port)
                .focused($portFocused).submitLabel(.done).onSubmit {
                    if address.port.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { address.port = LANAddressInput.defaultPort }
                    portFocused = false
                }
                .font(.system(.body, design: .monospaced)).multilineTextAlignment(.center)
                .textFieldStyle(.plain).frame(height: 44)
                .background(.black.opacity(0.24), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.white.opacity(0.18)))
                .keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityLabel("服务端口").accessibilityIdentifier("server-port")
        }.frame(width: 94)
    }
}

struct TeachingView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var ar = ARController()
    @StateObject private var renderer = ModelRenderer()
    @StateObject private var coverage = TeachingCoverageRenderer()
    @State private var review = false
    @State private var finishing = false
    @State private var displaySettingsOpen = false
    @State private var levelVisible = true
    @State private var zividFieldOfViewEnabled = false
    @State private var tiltControlsOpen = false
    @State private var sidebarCollapsed = false
    @State private var nearbyPoseConfirmation: NearbyPoseConfirmation?
    @State private var loadedProjectID: String?
    let projectID: String
    let geometry: ModelGeometry
    private var completed: Bool { session.current?.result.completedAt != nil }
    private var count: Int { session.current?.result.samples.count ?? 0 }
    private var liveCamera: Bool { ARController.supported && !completed }
    private var fieldOfView: ZividFieldOfView? { liveCamera ? ar.cameraFieldOfView : .modelPreview }
    private var canRecordPose: Bool {
        scenePhase == .active && !review && session.current?.id == projectID
            && !completed && ar.calibrated && ar.trackingNormal && renderer.geometry != nil
            && !session.busy && count < maximumSamples && session.error.isEmpty
    }
    private var canConfirmPlacement: Bool {
        ar.placed && !ar.repositioning && ar.trackingNormal && renderer.geometry != nil
            && !session.busy && session.error.isEmpty
    }
    private var viewportMessage: String {
        if sidebarCollapsed && !session.error.isEmpty { return session.error }
        if !liveCamera { return "三维物体预览 · 拖动旋转 / 双指缩放视图" }
        if ar.repositioning || ar.adjustingPlacement { return ar.message }
        if sidebarCollapsed && !ar.calibrated { return "展开面板，确认物体位置与方向后即可记录 Pose" }
        return ar.message
    }

    var body: some View {
        GeometryReader { viewport in
        let sidebarWidth: CGFloat = sidebarCollapsed ? 0 : 340
        let controlsWidth = max(0, viewport.size.width - sidebarWidth)
        ZStack {
            // Always render with the collapsed panel's full viewport. The panel
            // covers its right edge; it must not resize/recenter the camera,
            // the M70 mask, or the center used by placement raycasts.
            ZStack {
                Color.black
                modelViewport(in: viewport.size)
                if liveCamera {
                    Image(systemName: ar.placed && !ar.repositioning ? "plus" : "viewfinder")
                        .font(ar.placed && !ar.repositioning ? .title2.weight(.ultraLight) : .system(size: 48, weight: .ultraLight))
                        .foregroundStyle(ar.groundAssistance && ar.groundTargetAvailable ? accent : .white)
                        .shadow(color: .black, radius: 2).allowsHitTesting(false)
                        .accessibilityLabel("模型放置准星").accessibilityIdentifier("teaching-placement-target")
                }
            }.frame(width: viewport.size.width, height: viewport.size.height).clipped()
                .accessibilityElement(children: .contain).accessibilityIdentifier("teaching-viewport")
            HStack(spacing: 0) {
                VStack {
                    HStack {
                        Label(ar.tracking, systemImage: ar.trackingNormal ? "location.fill" : "location.slash")
                            .foregroundStyle(ar.trackingNormal ? accent : .orange)
                        Spacer()
                        Text(ar.depthAvailable ? "LiDAR 已就绪" : "等待 LiDAR").foregroundStyle(.secondary)
                        if ARController.supported && !completed {
                            Button { levelVisible.toggle() } label: {
                                Image(systemName: "scope").frame(minWidth: 20, minHeight: 32)
                            }
                                .buttonStyle(.bordered).tint(levelVisible ? accent : .secondary)
                                .accessibilityLabel(levelVisible ? "隐藏水平仪" : "显示水平仪")
                                .accessibilityIdentifier("toggle-spatial-level")
                        }
                        Button { displaySettingsOpen = true } label: {
                            Label("显示设置", systemImage: "slider.horizontal.3").frame(minWidth: 88, minHeight: 32)
                        }
                            .buttonStyle(.bordered).accessibilityIdentifier("display-settings")
                        if sidebarCollapsed {
                            Button { setSidebarCollapsed(false) } label: {
                                Label("展开面板", systemImage: "sidebar.right").frame(minWidth: 88, minHeight: 32)
                            }.buttonStyle(.bordered).accessibilityIdentifier("expand-teaching-panel")
                        }
                    }.font(.caption).padding(16).background(.black.opacity(0.75))
                    if ARController.supported && !completed {
                        HStack {
                            VStack(alignment: .leading, spacing: 10) {
                                if !ar.calibrated { groundAssistancePanel }
                                if levelVisible {
                                    SpatialLevelView(reading: ar.levelReading, placed: ar.placed && !ar.repositioning).allowsHitTesting(false)
                                }
                            }.frame(width: 232)
                            Spacer(minLength: 0)
                        }.padding(.horizontal, 16).padding(.top, 10)
                    }
                    Spacer()
                    HStack(alignment: .bottom, spacing: 16) {
                        Text(viewportMessage).font(.callout).padding(14)
                            .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 10))
                            .frame(maxWidth: .infinity)
                        if sidebarCollapsed && !completed {
                            VStack(spacing: 8) {
                                Text("\(count) 个 Pose").font(.caption.monospacedDigit()).foregroundStyle(.white)
                                    .accessibilityIdentifier("floating-pose-count")
                                if ar.adjustingPlacement { placementAdjustmentControls }
                                else {
                                    recordPoseButton
                                    if ar.calibrated { placementAdjustmentControls }
                                }
                            }.frame(width: 198).padding(12)
                                .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.15)))
                                .accessibilityElement(children: .contain).accessibilityIdentifier("floating-pose-controls")
                        }
                    }.padding(20)
                }.frame(width: controlsWidth, height: viewport.size.height)
                    .overlay {
                        if liveCamera && (!ar.placed || ar.repositioning) {
                            Text(ar.groundAssistance ? "扫描地面，在青色网格上放置物体" : "对准现场基准点，放置独立示教物体")
                                .font(.callout).padding(10).background(.black.opacity(0.65), in: Capsule())
                                .padding(.horizontal, 16).offset(y: 60).allowsHitTesting(false)
                        }
                    }.clipped()
            // Keep sidebar controls alive while folding; only the overlay's
            // usable area changes, never the underlying scene/session.
            VStack(spacing: 0) {
                HStack {
                    Button { ar.stop(); Task { await session.close() } } label: { Label("本地项目", systemImage: "chevron.left") }.disabled(session.busy)
                    Spacer()
                    Button { setSidebarCollapsed(true) } label: {
                        Label("收起", systemImage: "chevron.right").font(.caption).frame(minHeight: 32)
                    }.buttonStyle(.bordered).accessibilityLabel("收起右侧面板")
                        .accessibilityIdentifier("collapse-teaching-panel")
                }.padding(.horizontal, 22).padding(.vertical, 12)
                if liveCamera && !sidebarCollapsed && (ar.calibrated || ar.adjustingPlacement) {
                    placementAdjustmentControls.padding(.horizontal, 22).padding(.bottom, 12)
                }
            ScrollView {
                VStack(alignment: .leading, spacing: 19) {
                    Text(session.current?.session.manifest.name ?? "独立示教物体").font(.title3).lineLimit(2)
                    Text("\(count)").font(.system(size: 54, weight: .light, design: .monospaced)) + Text("  POSES").font(.caption).foregroundColor(.secondary)
                    Text(renderer.appliedSettings.map { geometry.summary($0) } ?? "正在轻量加载模型…")
                        .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("teaching-render-summary")
                    if session.current?.session.manifest.sampled == true { Text("大物体以抽样点云显示，尺寸与坐标不变").font(.caption).foregroundStyle(.secondary) }
                    Divider()
                    fieldOfViewControl
                    coverageControl
                    Divider()
                    if !completed {
                        calibrationPanel
                        if !sidebarCollapsed && !ar.adjustingPlacement { recordPoseButton }
                        Text("移动到目标视角 → 记录 Pose → 调整下一个视角。每个 Pose 都会自动保存在 iPad。").font(.caption).foregroundStyle(.secondary)
                    }
                    Button { review = true } label: { Label("查看 / 编辑 Pose", systemImage: "list.bullet.rectangle").frame(maxWidth: .infinity).padding(7) }
                        .buttonStyle(.bordered).disabled(count == 0)
                        .accessibilityIdentifier("review-poses")
                    if !completed {
                        Button { finishing = true } label: { Label("完成示教", systemImage: "checkmark.circle").frame(maxWidth: .infinity).padding(7) }
                            .buttonStyle(.bordered).disabled(count == 0 || session.busy || ar.adjustingPlacement)
                    } else {
                        LANAddressFields(address: $session.serverConnection).disabled(session.busy)
                        Button { Task { await session.finish(sync: true) } } label: { Label("同步到电脑", systemImage: "arrow.up.circle").frame(maxWidth: .infinity).padding(10) }
                            .buttonStyle(.borderedProminent).disabled(session.busy || !session.serverConnection.canConnect)
                    }
                    if session.busy { ProgressView() }
                    Text(session.status).font(.caption).foregroundStyle(.secondary)
                    if !renderer.error.isEmpty { Text(renderer.error).font(.caption).foregroundStyle(.orange) }
                    if !session.error.isEmpty {
                        Text(session.error).font(.caption).foregroundStyle(.orange)
                        Button("重试保存") { Task { do { try await session.saveNow(); session.error = "" } catch { session.error = error.localizedDescription } } }
                    }
                }.padding(22)
            }
            }.frame(width: 340, height: viewport.size.height).background(Color(red: 0.025, green: 0.05, blue: 0.065))
                .frame(width: sidebarWidth, alignment: .leading).clipped()
                .opacity(sidebarCollapsed ? 0 : 1).allowsHitTesting(!sidebarCollapsed)
                .accessibilityHidden(sidebarCollapsed)
            }
        }
        }.task(id: projectID) {
            // Returning from full-screen review must retain the live AR session
            // and its calibration instead of loading and resetting it again.
            guard loadedProjectID != projectID, let project = session.current else { return }
            loadedProjectID = projectID
            ar.load(manifest: project.session.manifest, samples: project.result.samples)
            renderer.update(geometry, settings: session.displaySettings)
            coverage.update(model: geometry, samples: project.result.samples)
            ar.onCalibration = { session.addCalibration($0) }
            ar.onSample = { session.addSample($0) }
            if !completed { await ar.start() }
        }.onDisappear {
            guard !review || session.current?.id != projectID else { return }
            loadedProjectID = nil
            nearbyPoseConfirmation = nil; ar.stop(); renderer.cancel(); coverage.cancel()
        }
        .onReceive(renderer.$geometry) { ar.display($0); coverage.attach(to: $0) }
        .onReceive(session.$current) { project in
            if let project, project.id == projectID { coverage.update(model: geometry, samples: project.result.samples) }
        }
        .onChange(of: session.displaySettings) { _, settings in renderer.update(geometry, settings: settings) }
        .onChange(of: canRecordPose) { _, available in
            if !available { nearbyPoseConfirmation = nil }
        }
        .onChange(of: session.current?.result.samples.last?.id) { _, _ in nearbyPoseConfirmation = nil }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { nearbyPoseConfirmation = nil; ar.suspend(); coverage.cancel(); session.backgroundSave() }
            else { coverage.resume(); if !completed { Task { await ar.start() } } }
        }
        .sheet(isPresented: $displaySettingsOpen) { ModelDisplaySettingsView(geometry: geometry, renderer: renderer).environmentObject(session) }
        .fullScreenCover(isPresented: $review, onDismiss: { ar.refreshMarkers(session.current?.result.samples ?? []) }) {
            PoseReviewView(rendered: renderer.geometry).environmentObject(session)
        }
        .alert("当前 Pose 与上一个距离很近", isPresented: Binding(
            get: { nearbyPoseConfirmation != nil },
            set: { if !$0 { nearbyPoseConfirmation = nil } }
        ), presenting: nearbyPoseConfirmation) { confirmation in
            Button("仍然记录") {
                guard canRecordPose,
                      session.current?.result.samples.last?.id == confirmation.previousSampleID else { return }
                ar.recordKeyframe(confirmation.sample)
            }.accessibilityIdentifier("confirm-nearby-pose")
            Button("取消", role: .cancel) { nearbyPoseConfirmation = nil }
                .accessibilityIdentifier("cancel-nearby-pose")
        } message: { confirmation in
            Text(confirmation.message)
        }
        .confirmationDialog("完成后将锁定本次 Pose；你可以现在同步，或离线保存后再同步。", isPresented: $finishing, titleVisibility: .visible) {
            Button("完成并同步到电脑") { ar.stop(); Task { await session.finish(sync: true) } }
            Button("仅完成并保存在 iPad") { ar.stop(); Task { await session.finish(sync: false) } }
            Button("继续示教", role: .cancel) {}
        }
    }
    private func setSidebarCollapsed(_ collapsed: Bool) {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        sidebarCollapsed = collapsed
    }
    private var recordPoseButton: some View {
        Button {
            guard canRecordPose, nearbyPoseConfirmation == nil, let sample = ar.captureKeyframe() else { return }
            if let confirmation = NearbyPoseConfirmation(sample: sample, previousSample: session.current?.result.samples.last) {
                nearbyPoseConfirmation = confirmation
            } else {
                ar.recordKeyframe(sample)
            }
        } label: {
            Label("记录 Pose", systemImage: "plus.viewfinder").font(.title3)
                .frame(maxWidth: .infinity).padding(.vertical, 16)
        }.buttonStyle(.borderedProminent).disabled(!canRecordPose || nearbyPoseConfirmation != nil)
            .accessibilityIdentifier("capture-pose")
    }
    private var placementAdjustmentControls: some View {
        VStack(spacing: 8) {
            if ar.adjustingPlacement {
                confirmPlacementButton
                Button { ar.cancelPlacementAdjustment() } label: {
                    Text("取消调整").frame(maxWidth: .infinity, minHeight: 32)
                }.buttonStyle(.bordered).accessibilityIdentifier("cancel-placement-adjustment")
            } else {
                Button {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    ar.beginPlacementAdjustment()
                } label: {
                    Label("调整物体位置", systemImage: "arrow.up.and.down.and.arrow.left.and.right")
                        .frame(maxWidth: .infinity, minHeight: 32)
                }.buttonStyle(.bordered).disabled(session.busy || renderer.geometry == nil)
                    .accessibilityIdentifier("adjust-model-placement")
            }
        }.font(.subheadline)
    }
    private var confirmPlacementButton: some View {
        Button {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            ar.confirmCalibration()
        } label: {
            Text(ar.adjustingPlacement ? "确认位置，继续示教" : "确认物体位置与方向")
                .frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.borderedProminent).disabled(!canConfirmPlacement)
            .accessibilityIdentifier("confirm-model-calibration")
    }
    private func modelViewport(in available: CGSize) -> some View {
        let size = zividFieldOfViewEnabled ? fieldOfView?.fittedSize(in: available) ?? available : available
        return ZStack {
            if liveCamera { ARSceneView(controller: ar) }
            else { ObjectPreviewView(geometry: geometry, rendered: renderer.geometry) }
            if zividFieldOfViewEnabled, let fieldOfView {
                ZividFieldOfViewOverlay(fieldOfView: fieldOfView, labelAtTop: sidebarCollapsed)
            }
        }.frame(width: size.width, height: size.height).clipped()
            .accessibilityElement(children: .contain).accessibilityIdentifier("teaching-render-surface")
    }
    private var fieldOfViewControl: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { zividFieldOfViewEnabled.toggle() } label: {
                    Label("Zivid 2 M70 视野", systemImage: "viewfinder")
                        .font(.subheadline).frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHidden(true)
                Spacer(minLength: 4)
                Toggle("Zivid 2 M70 视野", isOn: $zividFieldOfViewEnabled).labelsHidden().fixedSize()
                    .tint(accent).accessibilityIdentifier("zivid-fov-toggle")
            }
            if zividFieldOfViewEnabled {
                Text("水平 56.6° · 垂直 35.6°").font(.caption).monospacedDigit().foregroundStyle(accent)
                Text(fieldOfView == nil ? "正在获取相机视野…" : fieldOfView?.fullyVisible == false
                     ? "iPad 相机视野不足，仅显示可见部分" : "阴影为视野外区域 · 标称视野参考")
                    .font(.caption).foregroundStyle(fieldOfView?.fullyVisible == false ? .orange : .secondary)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("zivid-fov-status")
            }
        }
    }
    private var coverageControl: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { coverage.enabled.toggle() } label: {
                    Label("已示教区域", systemImage: "square.3.layers.3d")
                        .font(.subheadline).frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHidden(true)
                Spacer(minLength: 4)
                Toggle("已示教区域", isOn: $coverage.enabled).labelsHidden().fixedSize()
                    .tint(accent).accessibilityIdentifier("teaching-coverage-toggle")
            }
            if coverage.enabled {
                HStack {
                    Text("着色强度").font(.caption)
                    Slider(value: $coverage.opacity, in: 0.05...0.6, step: 0.05)
                        .tint(.mint).accessibilityLabel("已示教区域着色强度")
                        .accessibilityIdentifier("teaching-coverage-opacity")
                    Text("\(Int((coverage.opacity * 100).rounded()))%")
                        .font(.caption.monospacedDigit()).frame(width: 32, alignment: .trailing)
                }
                Text("M70 · 0.3–1.3 m · 绿色标记已示教表面")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                if coverage.preparing { ProgressView().controlSize(.mini) }
                Text(coverage.status).font(.caption)
                    .foregroundStyle(coverage.error.isEmpty ? Color.secondary : .orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("teaching-coverage-status")
            }
        }
    }
    private var groundAssistancePanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { ar.groundAssistance.toggle() } label: {
                    Label("地面辅助", systemImage: "square.3.layers.3d").font(.caption.weight(.semibold))
                        .frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHidden(true)
                Spacer(minLength: 4)
                Toggle("地面辅助", isOn: $ar.groundAssistance).labelsHidden().fixedSize()
                    .tint(accent).accessibilityIdentifier("ground-assistance")
            }
            Text(ar.groundStatus).font(.caption).foregroundStyle(ar.groundTargetAvailable ? accent : .secondary)
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("ground-status")
            if ar.groundAssistance {
                Text("仅水平地面 · 模型仍可自由倾斜").font(.caption2).foregroundStyle(.secondary)
            }
        }.padding(12).background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 12))
    }
    private var calibrationPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(ar.calibrated ? "物体已校准" : ar.adjustingPlacement ? "正在调整物体" : "先校准物体", systemImage: ar.calibrated ? "checkmark.seal" : "scope").foregroundStyle(accent)
            if !ar.calibrated {
                Text("模型基准点 / 米（默认底部中心）").font(.caption).foregroundStyle(.secondary)
                HStack {
                    coordinate("X", $ar.referenceX); coordinate("Y", $ar.referenceY); coordinate("Z", $ar.referenceZ)
                }.disabled(ar.repositioning)
                    .onChange(of: ar.referenceX) { _, _ in ar.updatePlacement() }
                    .onChange(of: ar.referenceY) { _, _ in ar.updatePlacement() }.onChange(of: ar.referenceZ) { _, _ in ar.updatePlacement() }
                Text(ar.groundAssistance ? "点击或单指拖动青色地面网格放置物体，双指旋转调整方向。尺寸固定为 1:1，模型可自由倾斜。" : "点击或单指拖动放置物体，双指旋转调整方向。尺寸固定为 1:1；可按现场需要倾斜放置，水平仪仅供参考。")
                    .font(.caption).foregroundStyle(.secondary)
                Button(ar.repositioning ? "放到准星位置" : ar.placed ? "重新放置物体" : "放置物体") {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    if ar.placed && !ar.repositioning { ar.beginRepositioning() }
                    else { ar.placeObject() }
                }.buttonStyle(.bordered)
                    .disabled(!ar.placementActionEnabled)
                    .accessibilityIdentifier("place-model")
                if ar.repositioning {
                    Button("取消重新放置") { ar.cancelRepositioning() }.buttonStyle(.bordered)
                        .accessibilityIdentifier("cancel-model-repositioning")
                    Text("物体暂时隐藏，点击画面选择新位置；取消可恢复原位置。").font(.caption).foregroundStyle(.secondary)
                }
                HStack { Text("方向"); Spacer(); Text("\(ar.yaw, specifier: "%.1f")°").monospacedDigit() }.font(.caption)
                Slider(value: $ar.yaw, in: -180...180).disabled(ar.repositioning).onChange(of: ar.yaw) { _, _ in ar.updatePlacement() }
                Button { withAnimation { tiltControlsOpen.toggle() } } label: {
                    HStack {
                        Text("调整物体倾斜"); Spacer()
                        Image(systemName: tiltControlsOpen ? "chevron.down" : "chevron.right")
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).font(.caption).foregroundStyle(accent)
                    .accessibilityIdentifier("model-tilt-controls")
                    .accessibilityValue(tiltControlsOpen ? "已展开" : "已折叠")
                if tiltControlsOpen {
                    VStack(spacing: 10) {
                        tiltControl("左右倾斜", angle: $ar.pitch, id: "model-pitch")
                        tiltControl("前后倾斜", angle: $ar.roll, id: "model-roll")
                    }.font(.caption).disabled(ar.repositioning)
                }
                if !ar.adjustingPlacement { confirmPlacementButton }
            }
        }
    }
    private func tiltControl(_ label: String, angle: Binding<Float>, id: String) -> some View {
        VStack(spacing: 4) {
            HStack { Text(label); Spacer(); Text("\(angle.wrappedValue, specifier: "%.1f")°").monospacedDigit().accessibilityIdentifier("\(id)-value") }
            Slider(value: angle, in: -180...180).accessibilityLabel(label).accessibilityIdentifier(id)
                .onChange(of: angle.wrappedValue) { _, _ in ar.updatePlacement() }
        }
    }
    private func coordinate(_ name: String, _ value: Binding<Float>) -> some View {
        VStack(alignment: .leading) {
            Text(name).font(.caption).foregroundStyle(.secondary)
            TextField(name, value: value, format: .number.precision(.fractionLength(0...4))).textFieldStyle(.roundedBorder)
                .keyboardType(.numbersAndPunctuation).font(.system(.caption, design: .monospaced))
        }
    }
}

struct ModelDisplaySettingsView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.dismiss) private var dismiss
    let geometry: ModelGeometry
    @ObservedObject var renderer: ModelRenderer
    private var settings: Binding<ModelDisplaySettings> {
        Binding(get: { session.displaySettings }, set: { session.setDisplaySettings($0) })
    }
    private var mode: Binding<ModelDisplayMode> {
        Binding(get: { geometry.usesMesh(session.displaySettings) ? .mesh : .points }, set: { value in
            var next = session.displaySettings; next.mode = value; session.setDisplaySettings(next)
        })
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ObjectPreviewView(geometry: geometry, rendered: renderer.geometry)
                        .frame(height: 260).clipShape(RoundedRectangle(cornerRadius: 14))
                        .accessibilityLabel("物体显示预览，拖动旋转，双指缩放")
                    HStack(spacing: 12) {
                        ForEach(ModelDisplayMode.allCases) { option in
                            Button { mode.wrappedValue = option } label: {
                                Label(option.label, systemImage: option == .mesh ? "cube.transparent" : "circle.dotted")
                                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                            }.buttonStyle(.bordered)
                                .tint(mode.wrappedValue == option ? accent : .secondary)
                                .accessibilityAddTraits(mode.wrappedValue == option ? .isSelected : [])
                                .accessibilityIdentifier("display-mode-\(option.rawValue)")
                                .disabled(option == .mesh && geometry.indices == 0)
                        }
                    }
                    HStack {
                        Label("点云密度", systemImage: "circle.dotted")
                        Spacer()
                        Picker("点云密度", selection: settings.pointDensity) {
                            ForEach(PointDensity.allCases) { Text($0.label).tag($0) }
                        }.pickerStyle(.menu).accessibilityIdentifier("point-density")
                            .disabled(mode.wrappedValue != .points)
                    }
                    HStack {
                        Label("Mesh 质量", systemImage: "cube.transparent")
                        Spacer()
                        Picker("Mesh 质量", selection: settings.meshQuality) {
                            ForEach(MeshQuality.allCases) { Text($0.label).tag($0) }
                        }.pickerStyle(.menu).accessibilityIdentifier("mesh-quality")
                            .disabled(!geometry.usesMesh(session.displaySettings))
                    }
                    Divider()
                    if renderer.preparing { ProgressView("正在本机更新显示…").accessibilityIdentifier("model-render-progress") }
                    Text(geometry.summary(renderer.appliedSettings ?? session.displaySettings))
                        .font(.system(.callout, design: .monospaced)).foregroundStyle(accent)
                        .accessibilityIdentifier("model-render-summary")
                    if !renderer.error.isEmpty { Text(renderer.error).foregroundStyle(.orange) }
                    Text(geometry.indices == 0
                         ? "此项目只有点云。若电脑源模型包含 Mesh，请新建传输以接收网格。"
                         : "轻量 Mesh 用点状轮廓辅助辨认；查看完整连续表面请选择「全量」。")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("每次打开先以轻量显示：最多 5 万点或 4 万面。需要更多细节时，可手动提高质量；下次打开仍从轻量开始，保留上次的显示模式。调整保留物体的实际尺寸、校准和已有 Pose。")
                        .font(.callout).foregroundStyle(.secondary)
                }.padding(24)
            }
            .background(Color(red: 0.025, green: 0.05, blue: 0.065))
            .navigationTitle("显示设置").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.accessibilityIdentifier("close-display-settings") } }
        }.presentationDetents([.large])
    }
}

struct ObjectPreviewView: UIViewRepresentable {
    let geometry: ModelGeometry
    let rendered: SCNGeometry?
    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(); view.scene = SCNScene(); view.backgroundColor = UIColor(red: 0.025, green: 0.05, blue: 0.065, alpha: 1)
        let object = SCNNode(geometry: rendered); object.name = "preview-object"; view.scene?.rootNode.addChildNode(object)
        let minimum = geometry.minimum, maximum = geometry.maximum
        let center = SCNVector3((minimum.x + maximum.x) / 2, (minimum.y + maximum.y) / 2, (minimum.z + maximum.z) / 2)
        let size = max(maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z, 0.1)
        let camera = SCNNode(); camera.camera = SCNCamera(); camera.camera?.zNear = 0.001; camera.camera?.zFar = Double(max(size * 100, 1000))
        camera.camera?.projectionDirection = .vertical
        camera.camera?.fieldOfView = ZividFieldOfView.previewVerticalDegrees
        camera.position = SCNVector3(center.x + size * 1.2, center.y - size * 1.8, center.z + size)
        camera.look(at: center, up: SCNVector3(0, 0, 1), localFront: SCNVector3(0, 0, -1))
        view.scene?.rootNode.addChildNode(camera); view.pointOfView = camera
        view.allowsCameraControl = true; view.defaultCameraController.worldUp = SCNVector3(0, 0, 1)
        view.defaultCameraController.target = center
        return view
    }
    func updateUIView(_ view: SCNView, context: Context) {
        let object = view.scene?.rootNode.childNode(withName: "preview-object", recursively: false)
        if object?.geometry !== rendered { object?.geometry = rendered }
    }
}

struct PoseReviewView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.dismiss) private var dismiss
    @State private var selectedID: String?
    @State private var poseName = ""
    @State private var selectingForDeletion = false
    @State private var deletionIDs: Set<String> = []
    @FocusState private var poseNameFocused: Bool
    let rendered: SCNGeometry?
    private var samples: [TeachingSample] { session.current?.result.samples ?? [] }
    private var selected: TeachingSample? { samples.first { $0.id == selectedID } ?? samples.first }
    private var completed: Bool { session.current?.result.completedAt != nil }
    var body: some View {
        NavigationStack {
            GeometryReader { viewport in
                if viewport.size.width >= 1000 && viewport.size.width > viewport.size.height {
                    HStack(spacing: 0) {
                        VStack(spacing: 0) {
                            poseList
                            Divider()
                            ScrollView { poseEditor.padding(20) }
                                .frame(maxHeight: 290)
                        }.frame(width: 280)
                        Divider()
                        posePreview
                    }
                } else {
                    VStack(spacing: 0) {
                        posePreview.frame(height: max(180, viewport.size.height * 0.62))
                        Divider()
                        if viewport.size.width >= 600 {
                            HStack(spacing: 0) {
                                poseList.frame(width: viewport.size.width * 0.38)
                                Divider()
                                ScrollView { poseEditor.padding(20) }
                            }
                        } else {
                            VStack(spacing: 0) {
                                poseList
                                ScrollView { poseEditor.padding(12) }.frame(maxHeight: 190)
                            }
                        }
                    }
                }
            }
            .background(Color(red: 0.025, green: 0.05, blue: 0.065))
            .accessibilityElement(children: .contain).accessibilityIdentifier("pose-review-page")
            .navigationTitle("查看 / 编辑 Pose").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("返回示教") { poseNameFocused = false; dismiss() }.accessibilityIdentifier("close-pose-review")
                }
            }
        }.onAppear { poseName = selected?.name ?? "" }
            .onChange(of: samples.map(\.id)) { _, ids in
                deletionIDs.formIntersection(ids)
                if ids.isEmpty {
                    endDeletionSelection(); selectedID = nil; poseName = ""
                }
            }
            .onChange(of: completed) { _, locked in
                if locked { endDeletionSelection() }
            }
    }

    private var poseList: some View {
        VStack(spacing: 0) {
            if selectingForDeletion {
                HStack {
                    Button {
                        deletionIDs = allPosesSelected ? [] : Set(samples.map(\.id))
                    } label: {
                        Label("全选", systemImage: allPosesSelected ? "checkmark.square.fill" : deletionIDs.isEmpty ? "square" : "minus.square.fill")
                    }.accessibilityIdentifier("select-all-poses")
                        .accessibilityValue(allPosesSelected ? "已全选" : deletionIDs.isEmpty ? "未选择" : "部分选择")
                    Spacer()
                    Text("已选 \(deletionIDs.count)/\(samples.count)").font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("selected-poses-count")
                }
                .padding(.horizontal, 20).frame(minHeight: 48)
                Divider()
            }
            List {
                Section {
                    ForEach(samples) { sample in
                        poseRow(sample)
                    }
                } header: {
                    Text("\(samples.count) 个 Pose").accessibilityIdentifier("pose-review-count")
                }
            }.listStyle(.plain).scrollDismissesKeyboard(.interactively)
                .accessibilityIdentifier("pose-review-list")
        }
    }

    private var allPosesSelected: Bool { !samples.isEmpty && deletionIDs.count == samples.count }

    private func poseRow(_ sample: TeachingSample) -> some View {
        let highlighted = selectingForDeletion ? deletionIDs.contains(sample.id) : sample.id == selected?.id
        return Button {
            poseNameFocused = false; selectedID = sample.id; poseName = sample.name
            if selectingForDeletion {
                if deletionIDs.contains(sample.id) { deletionIDs.remove(sample.id) }
                else { deletionIDs.insert(sample.id) }
            }
        } label: {
            HStack(spacing: 12) {
                if selectingForDeletion {
                    Image(systemName: deletionIDs.contains(sample.id) ? "checkmark.square.fill" : "square")
                        .font(.title3).foregroundStyle(accent)
                }
                VStack(alignment: .leading, spacing: 7) {
                    Text(sample.name.isEmpty ? "Pose" : sample.name)
                        .foregroundStyle(highlighted ? accent : .primary)
                    Text(sample.capturedAt).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }.padding(.vertical, 5).contentShape(Rectangle())
        }.listRowBackground(highlighted ? accent.opacity(0.12) : Color.clear)
            .accessibilityIdentifier("review-pose-\(sample.id)")
            .accessibilityValue(selectingForDeletion ? (deletionIDs.contains(sample.id) ? "已勾选" : "未勾选") : "")
            .accessibilityAddTraits(highlighted ? .isSelected : [])
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                if !completed && !selectingForDeletion {
                    Button("删除", role: .destructive) { deletePoses([sample.id]) }
                        .tint(.red)
                        .accessibilityIdentifier("swipe-delete-pose-\(sample.id)")
                }
            }
    }

    private var posePreview: some View {
        Group {
            if let selected {
                let aspect = selected.previewAspect ?? (4.0 / 3.0)
                PosePreviewView(rendered: rendered, sample: selected)
                    .aspectRatio(CGFloat(aspect.isFinite && aspect > 0 ? aspect : 4.0 / 3.0), contentMode: .fit)
                    .accessibilityLabel("\(selected.name) 的物体视角")
                    .accessibilityIdentifier("pose-review-preview")
            } else { ContentUnavailableView("还没有 Pose", systemImage: "viewfinder") }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.black.opacity(0.25))
            .accessibilityElement(children: .contain).accessibilityIdentifier("pose-review-viewport")
    }

    @ViewBuilder private var poseEditor: some View {
        if selectingForDeletion {
            VStack(alignment: .leading, spacing: 14) {
                Text("选择要删除的 Pose").font(.headline)
                Text("勾选列表中的 Pose，或使用全选。点击 Pose 可同时查看对应视角。")
                    .font(.caption).foregroundStyle(.secondary)
                Button("删除所选（\(deletionIDs.count)）", role: .destructive) {
                    deletePoses(deletionIDs)
                    endDeletionSelection()
                }.buttonStyle(.borderedProminent).tint(.red)
                    .disabled(deletionIDs.isEmpty || session.busy)
                    .accessibilityIdentifier("delete-selected-poses")
                Button("取消多选") { endDeletionSelection() }.buttonStyle(.bordered)
                    .accessibilityIdentifier("cancel-pose-selection")
            }.frame(maxWidth: .infinity, alignment: .leading)
        } else if let selected {
            VStack(alignment: .leading, spacing: 14) {
                Text(selected.name.isEmpty ? "Pose" : selected.name).font(.headline)
                let p = selected.cameraPose.position
                Text("X \(p.x, specifier: "%.4f") m\nY \(p.y, specifier: "%.4f") m\nZ \(p.z, specifier: "%.4f") m")
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                if !completed {
                    TextField("Pose 名称", text: $poseName).textFieldStyle(.roundedBorder)
                        .focused($poseNameFocused)
                        .accessibilityIdentifier("review-pose-name")
                    HStack {
                        Button("保存名称") { session.renameSample(selected.id, name: poseName); poseNameFocused = false }
                            .accessibilityIdentifier("save-pose-name")
                        Spacer()
                        Button("删除", role: .destructive) {
                            poseNameFocused = false
                            deletionIDs = []; selectingForDeletion = true
                        }.accessibilityIdentifier("delete-review-pose")
                    }.buttonStyle(.bordered)
                }
                Text(completed ? "本次示教已完成，Pose 已锁定。" : "保存后返回示教，即可记录下一个 Pose。")
                    .font(.caption).foregroundStyle(.secondary)
                if !session.error.isEmpty { Text(session.error).font(.caption).foregroundStyle(.orange) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func deletePoses(_ ids: Set<String>) {
        guard !completed, !session.busy, !ids.isEmpty else { return }
        poseNameFocused = false
        let viewedID = selected?.id
        session.deleteSamples(ids)
        deletionIDs.subtract(ids)
        if let viewedID, ids.contains(viewedID) {
            selectedID = nil; poseName = samples.first?.name ?? ""
        }
    }

    private func endDeletionSelection() {
        selectingForDeletion = false; deletionIDs = []
    }
}

struct PosePreviewView: UIViewRepresentable {
    let rendered: SCNGeometry?
    let sample: TeachingSample
    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(); view.scene = SCNScene(); view.backgroundColor = UIColor(red: 0.025, green: 0.05, blue: 0.065, alpha: 1)
        let object = SCNNode(geometry: rendered); object.name = "preview-object"; view.scene?.rootNode.addChildNode(object)
        let camera = SCNNode(); camera.camera = SCNCamera(); camera.camera?.zNear = 0.01; camera.camera?.zFar = 1000
        view.scene?.rootNode.addChildNode(camera); view.pointOfView = camera
        return view
    }
    func updateUIView(_ view: SCNView, context: Context) {
        let object = view.scene?.rootNode.childNode(withName: "preview-object", recursively: false)
        if object?.geometry !== rendered { object?.geometry = rendered }
        if let matrix = sample.previewCameraTransform, matrix.count == 16,
           let projection = sample.previewProjection, projection.count == 16 {
            view.pointOfView?.simdTransform = simd_float4x4(elements: matrix)
            view.pointOfView?.camera?.projectionTransform = SCNMatrix4(simd_float4x4(elements: projection))
            return
        }
        let q = sample.cameraPose.quaternion
        var transform = simd_float4x4(simd_quatf(ix: q.x, iy: q.y, iz: q.z, r: q.w)) * TeachingCoordinates.opticalToARCamera
        transform.columns.3 = SIMD4(sample.cameraPose.position.simd, 1)
        view.pointOfView?.simdTransform = transform
    }
}
