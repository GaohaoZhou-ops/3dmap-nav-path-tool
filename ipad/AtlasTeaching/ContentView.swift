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
        NavigationStack {
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
            .navigationTitle("Atlas 示教").navigationBarTitleDisplayMode(.inline)
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
    @State private var review = false
    @State private var finishing = false
    @State private var displaySettingsOpen = false
    @State private var levelVisible = true
    @State private var tiltControlsOpen = false
    let projectID: String
    let geometry: ModelGeometry
    private var completed: Bool { session.current?.result.completedAt != nil }
    private var count: Int { session.current?.result.samples.count ?? 0 }

    var body: some View {
        GeometryReader { viewport in
        HStack(spacing: 0) {
            ZStack {
                if !ARController.supported || completed {
                    ObjectPreviewView(geometry: geometry, rendered: renderer.geometry)
                } else { ARSceneView(controller: ar) }
                if !ar.placed && ARController.supported && !completed {
                    VStack(spacing: 14) {
                        Image(systemName: "viewfinder").font(.system(size: 48, weight: .ultraLight))
                            .foregroundStyle(ar.groundAssistance && ar.groundTargetAvailable ? accent : .white)
                        Text(ar.groundAssistance ? "扫描地面，在青色网格上放置物体" : "对准现场基准点，放置独立示教物体")
                            .font(.callout).padding(10).background(.black.opacity(0.65), in: Capsule())
                    }.allowsHitTesting(false)
                } else if ar.placed && !completed {
                    Image(systemName: "plus").font(.title2.weight(.ultraLight))
                        .foregroundStyle(ar.groundAssistance && ar.groundTargetAvailable ? accent : .white)
                        .shadow(color: .black, radius: 2).allowsHitTesting(false)
                }
                VStack {
                    HStack {
                        Label(ar.tracking, systemImage: ar.trackingNormal ? "location.fill" : "location.slash")
                            .foregroundStyle(ar.trackingNormal ? accent : .orange)
                        Spacer()
                        Text(ar.depthAvailable ? "LiDAR 已就绪" : "等待 LiDAR").foregroundStyle(.secondary)
                        if ARController.supported && !completed {
                            Button { levelVisible.toggle() } label: { Image(systemName: "scope") }
                                .buttonStyle(.bordered).tint(levelVisible ? accent : .secondary)
                                .accessibilityLabel(levelVisible ? "隐藏水平仪" : "显示水平仪")
                                .accessibilityIdentifier("toggle-spatial-level")
                        }
                        Button { displaySettingsOpen = true } label: { Label("显示设置", systemImage: "slider.horizontal.3") }
                            .buttonStyle(.bordered).accessibilityIdentifier("display-settings")
                    }.font(.caption).padding(16).background(.black.opacity(0.75))
                    if ARController.supported && !completed {
                        HStack {
                            VStack(alignment: .leading, spacing: 10) {
                                if !ar.calibrated { groundAssistancePanel }
                                if levelVisible {
                                    SpatialLevelView(reading: ar.levelReading, placed: ar.placed).allowsHitTesting(false)
                                }
                            }.frame(width: 232)
                            Spacer(minLength: 0)
                        }.padding(.horizontal, 16).padding(.top, 10)
                    }
                    Spacer()
                    Text(!ARController.supported || completed ? "三维物体预览 · 拖动旋转 / 双指缩放视图" : ar.message).font(.callout).padding(14).background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 10)).padding(20)
                }
            }.frame(width: max(0, viewport.size.width - 340), height: viewport.size.height).clipped()
            ScrollView {
                VStack(alignment: .leading, spacing: 19) {
                    HStack {
                        Button { ar.stop(); Task { await session.close() } } label: { Label("本地项目", systemImage: "chevron.left") }.disabled(session.busy)
                        Spacer(); Text("本机运行").font(.caption).foregroundStyle(accent)
                    }
                    Text(session.current?.session.manifest.name ?? "独立示教物体").font(.title3).lineLimit(2)
                    Text("\(count)").font(.system(size: 54, weight: .light, design: .monospaced)) + Text("  POSES").font(.caption).foregroundColor(.secondary)
                    if session.current?.session.manifest.sampled == true { Text("大物体以抽样点云显示，尺寸与坐标不变").font(.caption).foregroundStyle(.secondary) }
                    Divider()
                    if !completed {
                        calibrationPanel
                        Button { ar.recordKeyframe() } label: {
                            Label("记录 Pose", systemImage: "plus.viewfinder").font(.title3).frame(maxWidth: .infinity).padding(.vertical, 16)
                        }.buttonStyle(.borderedProminent)
                            .disabled(!ar.calibrated || !ar.trackingNormal || renderer.geometry == nil || session.busy || count >= maximumSamples || !session.error.isEmpty)
                            .accessibilityIdentifier("capture-pose")
                        Text("移动到目标视角 → 记录 Pose → 调整下一个视角。每个 Pose 都会自动保存在 iPad。").font(.caption).foregroundStyle(.secondary)
                    }
                    Button { review = true } label: { Label("查看 / 编辑 Pose", systemImage: "list.bullet.rectangle").frame(maxWidth: .infinity).padding(7) }
                        .buttonStyle(.bordered).disabled(count == 0)
                    if !completed {
                        Button { finishing = true } label: { Label("完成示教", systemImage: "checkmark.circle").frame(maxWidth: .infinity).padding(7) }
                            .buttonStyle(.bordered).disabled(count == 0 || session.busy)
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
            }.frame(width: 340, height: viewport.size.height).background(Color(red: 0.025, green: 0.05, blue: 0.065))
        }
        }.task(id: projectID) {
            guard let project = session.current else { return }
            ar.load(manifest: project.session.manifest, samples: project.result.samples)
            renderer.update(geometry, settings: session.displaySettings)
            ar.onCalibration = { session.addCalibration($0) }
            ar.onSample = { session.addSample($0) }
            if !completed { await ar.start() }
        }.onDisappear { ar.stop(); renderer.cancel() }
        .onReceive(renderer.$geometry) { ar.display($0) }
        .onChange(of: session.displaySettings) { _, settings in renderer.update(geometry, settings: settings) }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { ar.suspend(); session.backgroundSave() }
            else if !completed { Task { await ar.start() } }
        }
        .sheet(isPresented: $displaySettingsOpen) { ModelDisplaySettingsView(geometry: geometry, renderer: renderer).environmentObject(session) }
        .sheet(isPresented: $review, onDismiss: { ar.refreshMarkers(session.current?.result.samples ?? []) }) { PoseReviewView(rendered: renderer.geometry).environmentObject(session) }
        .confirmationDialog("完成后将锁定本次 Pose；你可以现在同步，或离线保存后再同步。", isPresented: $finishing, titleVisibility: .visible) {
            Button("完成并同步到电脑") { ar.stop(); Task { await session.finish(sync: true) } }
            Button("仅完成并保存在 iPad") { ar.stop(); Task { await session.finish(sync: false) } }
            Button("继续示教", role: .cancel) {}
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
            Label(ar.calibrated ? "物体已校准" : "先校准物体", systemImage: ar.calibrated ? "checkmark.seal" : "scope").foregroundStyle(accent)
            if ar.calibrated {
                Button("重新校准（保留已有 Pose）") { ar.beginCalibration() }.font(.caption)
            } else {
                Text("模型基准点 / 米（默认底部中心）").font(.caption).foregroundStyle(.secondary)
                HStack {
                    coordinate("X", $ar.referenceX); coordinate("Y", $ar.referenceY); coordinate("Z", $ar.referenceZ)
                }.onChange(of: ar.referenceX) { _, _ in ar.updatePlacement() }
                    .onChange(of: ar.referenceY) { _, _ in ar.updatePlacement() }.onChange(of: ar.referenceZ) { _, _ in ar.updatePlacement() }
                Text(ar.groundAssistance ? "点击或单指拖动青色地面网格放置物体，双指旋转调整方向。尺寸固定为 1:1，模型可自由倾斜。" : "点击或单指拖动放置物体，双指旋转调整方向。尺寸固定为 1:1；可按现场需要倾斜放置，水平仪仅供参考。")
                    .font(.caption).foregroundStyle(.secondary)
                Button("放置物体 / 更新位置") { ar.placeObject() }.buttonStyle(.bordered)
                    .disabled(!ar.trackingNormal || (ar.groundAssistance && !ar.groundTargetAvailable))
                    .accessibilityIdentifier("place-model")
                HStack { Text("方向"); Spacer(); Text("\(ar.yaw, specifier: "%.1f")°").monospacedDigit() }.font(.caption)
                Slider(value: $ar.yaw, in: -180...180).onChange(of: ar.yaw) { _, _ in ar.updatePlacement() }
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
                    }.font(.caption)
                }
                Button("确认物体位置与方向") { ar.confirmCalibration() }.buttonStyle(.bordered).disabled(!ar.placed || !ar.trackingNormal || renderer.geometry == nil)
                    .accessibilityIdentifier("confirm-model-calibration")
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
                         : "降低 Mesh 质量会减少显示的三角面；查看连续表面请选择「全量」。")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("显示设置随项目保存在 iPad。调整保留物体的实际尺寸、校准和已有 Pose。")
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
    let rendered: SCNGeometry?
    private var samples: [TeachingSample] { session.current?.result.samples ?? [] }
    private var selected: TeachingSample? { samples.first { $0.id == selectedID } ?? samples.first }
    private var completed: Bool { session.current?.result.completedAt != nil }
    var body: some View {
        NavigationStack {
            HStack(spacing: 0) {
                List(samples) { sample in
                    Button { selectedID = sample.id; poseName = sample.name } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(sample.name.isEmpty ? "Pose" : sample.name).foregroundStyle(sample.id == selected?.id ? accent : .primary)
                            Text(sample.capturedAt).font(.caption2).foregroundStyle(.secondary)
                        }.padding(.vertical, 5)
                    }
                }.frame(width: 230)
                if let selected {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("该 Pose 下的虚拟物体视角").font(.headline)
                        PosePreviewView(rendered: rendered, sample: selected).aspectRatio(CGFloat(selected.previewAspect ?? (4.0 / 3.0)), contentMode: .fit)
                        let p = selected.cameraPose.position
                        Text("X \(p.x, specifier: "%.4f")  Y \(p.y, specifier: "%.4f")  Z \(p.z, specifier: "%.4f") m")
                            .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        if !completed {
                            TextField("Pose 名称", text: $poseName).textFieldStyle(.roundedBorder)
                            HStack {
                                Button("保存名称") { session.renameSample(selected.id, name: poseName) }.buttonStyle(.bordered)
                                Spacer()
                                Button("删除此 Pose", role: .destructive) { session.deleteSample(selected.id); selectedID = nil; poseName = samples.first?.name ?? "" }.buttonStyle(.bordered)
                            }
                        }
                        Text(completed ? "本次示教已完成，Pose 已锁定。" : "保存后继续示教，即可记录下一个 Pose。").font(.caption).foregroundStyle(.secondary)
                    }.padding(22)
                } else { ContentUnavailableView("还没有 Pose", systemImage: "viewfinder") }
            }.navigationTitle("逐个 Pose 示教").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("返回示教") { dismiss() } } }
        }.onAppear { poseName = selected?.name ?? "" }
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
