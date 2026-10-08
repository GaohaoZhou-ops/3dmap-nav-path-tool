import SwiftUI

struct VisionWorkspaceView: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @Environment(\.openImmersiveSpace) private var openSpace
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var discovery = LANServiceDiscovery()
    @State private var finishConfirmation = false
    @State private var syncOnFinish = false

    private var completed: Bool { session.current?.result.completedAt != nil }
    private var spaceClosed: Bool { spatial.spaceState == .closed }

    var body: some View {
        HStack(spacing: 0) {
            library.frame(width: 280)
            Divider()
            VStack(alignment: .leading, spacing: 18) {
                header
                if session.current == nil { connection } else { project }
                Spacer(minLength: 0)
                status
            }.padding(28)
        }
        .frame(minWidth: 980, minHeight: 720)
        .task { await session.reload() }
        .onChange(of: session.current?.id) { _, _ in
            if let model = session.geometry, let current = session.current {
                spatial.configure(model, samples: current.result.samples, demo: current.result.device.platform == "visionOS-simulator")
            }
        }
        .onChange(of: session.current?.result.samples.map(\.id)) { _, _ in spatial.refreshMarkers(session.current?.result.samples ?? []) }
        .onChange(of: spatial.quality) { _, _ in if let model = session.geometry { spatial.render(model) } }
        .onChange(of: spatial.displayMode) { _, _ in if let model = session.geometry { spatial.render(model) } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                session.backgroundSave(); spatial.stop()
                if !spaceClosed { spatial.spaceState = .closing; Task { await dismissSpace() } }
            }
        }
        .onDisappear {
            discovery.stop(); session.backgroundSave()
            if !spaceClosed { spatial.stop(); spatial.spaceState = .closing; Task { await dismissSpace() } }
        }
        .confirmationDialog("完成后将锁定当前 Pose，可以稍后重试同步。", isPresented: $finishConfirmation, titleVisibility: .visible) {
            Button(syncOnFinish ? "完成并同步" : "完成并保存在本机") {
                Task {
                    if !spaceClosed { spatial.stop(); spatial.spaceState = .closing; await dismissSpace() }
                    await session.finish(sync: syncOnFinish && !spatial.isDemo)
                }
            }
            Button("取消", role: .cancel) {}
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text("ATLAS / SPATIAL TEACHING").font(.caption.weight(.semibold)).tracking(2).foregroundStyle(.secondary)
                Text(session.current?.session.manifest.name ?? "把示教带入空间").font(.largeTitle.bold()).lineLimit(2)
                Text("Vision Pro · 真实尺寸 · 本机记录").foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "visionpro").font(.system(size: 38)).foregroundStyle(.cyan).accessibilityHidden(true)
        }
    }

    private var library: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("本地任务", systemImage: "square.stack.3d.up").font(.title2.bold()).padding(.horizontal, 20)
            Button { Task { await session.close() } } label: {
                Label("连接新任务", systemImage: "plus")
            }.padding(.horizontal, 20).disabled(session.busy || !spaceClosed).accessibilityIdentifier("new-project")
            if session.projects.isEmpty {
                Text("下载后的模型与 Pose 会保存在这里，可离线继续示教。")
                    .foregroundStyle(.secondary).padding(.horizontal, 20)
            }
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(session.projects) { item in
                        let displayed = session.current?.id == item.id ? (session.current ?? item) : item
                        Button { Task { await session.open(item) } } label: {
                            VStack(alignment: .leading, spacing: 7) {
                                Text(item.session.manifest.name).font(.headline).lineLimit(2)
                                Text("\(displayed.result.samples.count) 个 Pose · \(displayed.syncedAt != nil ? "已同步" : displayed.result.completedAt != nil ? "待同步" : "草稿")")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                        }
                        .tint(item.id == session.current?.id ? .cyan : .primary)
                        .disabled(session.busy || !spaceClosed || item.id == session.current?.id)
                    }
                }.padding(.horizontal, 16)
            }
            Text("下载后可断网使用\n完成后再回到局域网同步").font(.caption).foregroundStyle(.secondary).padding(20)
        }.padding(.top, 30)
    }

    private var connection: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("在电脑的独立示教工作台点击「iPad / Vision Pro」，准备物体与配对码。")
                .font(.title3)
            HStack {
                Button { discovery.start() } label: { Label("搜索局域网电脑", systemImage: "wifi") }
                    .disabled(discovery.isSearching || session.busy)
                if discovery.isSearching { ProgressView().controlSize(.small) }
            }
            Text(discovery.message).font(.caption).foregroundStyle(.secondary)
            ForEach(discovery.servers) { server in
                Button { session.serverAddress = server.address } label: {
                    Label("\(server.name) · \(server.address)", systemImage: "desktopcomputer")
                }.disabled(session.busy)
            }
            HStack {
                TextField("电脑 IPv4 地址或 .local 主机名", text: $session.serverConnection.host)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("server-host")
                TextField("端口", text: $session.serverConnection.port).frame(width: 100).accessibilityIdentifier("server-port")
            }.textFieldStyle(.roundedBorder)
            HStack {
                TextField("4 位配对码", text: $session.code).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .font(.title2.monospaced()).frame(width: 210).accessibilityIdentifier("pairing-code")
                Button { discovery.stop(); Task { await session.pair() } } label: { Label("接收模型", systemImage: "arrow.down.circle.fill") }
                    .buttonStyle(.borderedProminent).tint(.cyan)
                    .disabled(session.busy || !session.serverConnection.canConnect || !PairingCode.isValid(session.code))
                    .accessibilityIdentifier("pair-model")
            }
            Text("头显记录的是头部参考位置与朝向；捏合用于操作按钮，视线用于选择界面。")
                .font(.callout).foregroundStyle(.secondary)
            #if targetEnvironment(simulator)
            Divider()
            Button("打开本地演练") { Task { await VisionDemo.load(into: session) } }.disabled(session.busy)
                .accessibilityIdentifier("open-demo")
            Text("模拟器演练使用合成模型和位姿，不能同步到电脑。")
                .font(.caption).foregroundStyle(.secondary)
            #endif
        }.disabled(session.busy)
    }

    private var project: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 16) {
                Label(completed ? "已完成" : "本地草稿", systemImage: completed ? "checkmark.seal" : "square.and.pencil")
                Text("\(session.current?.result.samples.count ?? 0) 个 Pose").monospacedDigit().accessibilityIdentifier("pose-count")
                Text(spatial.renderSummary).font(.caption).foregroundStyle(.secondary)
                if spatial.preparing { ProgressView().controlSize(.small) }
            }
            if spatial.isDemo { Label("模拟演练 · 不可同步", systemImage: "testtube.2").foregroundStyle(.orange) }
            HStack {
                Picker("显示", selection: $spatial.displayMode) {
                    ForEach(ModelDisplayMode.allCases) { Text($0.label).tag($0) }
                }.pickerStyle(.segmented).frame(width: 190)
                Picker("精度", selection: $spatial.quality) {
                    ForEach(VisionQuality.allCases) { Text($0.label).tag($0) }
                }.frame(width: 180)
                Spacer()
                Button(spaceClosed ? "进入空间示教" : "退出空间") { Task { await toggleSpace() } }
                    .buttonStyle(.borderedProminent).tint(.cyan)
                    .disabled(session.busy || spatial.preparing || spatial.spaceState == .opening || spatial.spaceState == .closing)
                    .accessibilityIdentifier("toggle-space")
            }
            if !spaceClosed {
                VisionTeachingControls(compact: false)
                Text("可将任务窗口移到侧面，使用空间控制板记录 Pose。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if spaceClosed && !completed {
                Text("进入空间 → 捏合选择青色水平面或手动放到前方 → 微调并确认校准 → 移动头部逐个记录 Pose。")
                    .foregroundStyle(.secondary)
            }
            VisionPoseList().frame(minHeight: 100, maxHeight: .infinity)
            Divider()
            HStack {
                if !completed {
                    Button("完成并保存在本机") { syncOnFinish = false; finishConfirmation = true }
                        .disabled(session.busy || session.current?.result.samples.isEmpty != false || spatial.calibrating)
                        .accessibilityIdentifier("finish-local")
                    Button("完成并同步") { syncOnFinish = true; finishConfirmation = true }
                        .disabled(spatial.isDemo || session.busy || session.current?.result.samples.isEmpty != false || spatial.calibrating)
                } else {
                    TextField("电脑地址", text: $session.serverAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("sync-address")
                    Button(session.current?.syncedAt == nil ? "同步到电脑" : "再次同步") { Task { await session.finish(sync: true) } }
                        .disabled(session.busy || spatial.isDemo).accessibilityIdentifier("sync-result")
                }
            }
        }
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !session.error.isEmpty {
                HStack {
                    Text(session.error).foregroundStyle(.red).textSelection(.enabled)
                    Button("知道了") { session.error = "" }
                }.accessibilityIdentifier("session-error")
            }
            if !spatial.renderError.isEmpty {
                HStack {
                    Text(spatial.renderError).foregroundStyle(.red)
                    Button("重试显示") { if let model = session.geometry { spatial.render(model) } }
                }
            }
            HStack {
                if session.busy { ProgressView().controlSize(.small) }
                Text(session.status.isEmpty ? "本地运算 · 无需云服务" : session.status).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func toggleSpace() async {
        if !spaceClosed {
            spatial.stop(); spatial.spaceState = .closing; await dismissSpace()
        } else {
            spatial.spaceState = .opening
            switch await openSpace(id: "teaching-space") {
            case .opened: spatial.spaceState = .open
            case .userCancelled: spatial.spaceState = .closed
            case .error: spatial.spaceState = .closed; session.error = "无法打开空间，请关闭其他沉浸式 App 后重试"
            @unknown default: spatial.spaceState = .closed
            }
        }
    }
}

struct VisionTeachingControls: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @State private var nearby: NearbyPoseConfirmation?
    let compact: Bool
    private var readOnly: Bool { session.current?.result.completedAt != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(spatial.tracking, systemImage: spatial.trackingNormal ? "location.fill" : "location.slash")
                    .foregroundStyle(spatial.trackingNormal ? .green : .orange)
                Spacer()
                if compact { Text("\(session.current?.result.samples.count ?? 0) Pose").monospacedDigit() }
            }.font(.callout)
            if !spatial.placement.isCalibrated {
                Text(spatial.message).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("放到前方") { spatial.placeInFront() }.accessibilityIdentifier("place-front")
                    Button(readOnly ? "确认显示位置" : "确认校准") {
                        Task {
                            do {
                                guard readOnly || (session.current?.result.calibrations.count ?? 0) < 1000 else { throw TeachingError("校准段已达上限，请完成此任务") }
                                let calibration = try await spatial.confirm()
                                if !readOnly { session.addCalibration(calibration) }
                            } catch is CancellationError {} catch { session.error = error.localizedDescription }
                        }
                    }.buttonStyle(.borderedProminent).tint(.cyan)
                        .disabled(spatial.placement.transform == nil || !spatial.trackingNormal || spatial.preparing || spatial.calibrating)
                        .accessibilityIdentifier("confirm-placement")
                    if spatial.canCancelAdjustment { Button("取消调整") { spatial.cancelAdjustment() } }
                }.disabled(spatial.calibrating)
                if !compact && !spatial.isDemo {
                    Button("沿头部朝向放到水平面") { spatial.placeOnObservedSurface() }
                        .disabled(spatial.planeCount == 0 || !spatial.trackingNormal || spatial.calibrating)
                }
                if !compact && spatial.placement.transform != nil {
                    HStack {
                        nudge("左右", axis: 0); nudge("高度", axis: 1); nudge("前后", axis: 2)
                    }
                    HStack {
                        angle("偏航", axis: 2, value: spatial.placement.yaw)
                        angle("俯仰", axis: 1, value: spatial.placement.pitch)
                        angle("翻滚", axis: 0, value: spatial.placement.roll)
                    }
                }
            } else {
                HStack {
                    if !readOnly { Button { capture() } label: { Label("记录 Pose", systemImage: "plus.circle.fill") }
                        .buttonStyle(.borderedProminent).tint(.cyan)
                        .disabled(!spatial.canRecord || (session.current?.result.samples.count ?? 0) >= maximumSamples)
                        .accessibilityIdentifier("record-pose")
                    } else { Label("已完成 · 空间回看", systemImage: "checkmark.seal") }
                    Button("调整模型") { nearby = nil; spatial.beginAdjustment() }.accessibilityIdentifier("adjust-model")
                    Button("控制板移到面前") { spatial.recenterPanel() }
                }
            }
            if !compact {
                Toggle("M70 虚拟视锥 · 0.3–1.3 m", isOn: $spatial.showFrustum).font(.callout)
                Text("以头显参考点模拟相机视角，未包含实际相机外参标定。模型始终保持 1:1。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            #if targetEnvironment(simulator)
            if spatial.isDemo { Button("模拟向右移动 20 cm") { spatial.moveDemo() }.accessibilityIdentifier("move-demo") }
            #endif
        }
        .disabled(session.busy || !session.error.isEmpty || spatial.spaceState != .open)
        .alert("距离上一个 Pose 小于 10 cm", isPresented: Binding(get: { nearby != nil }, set: { if !$0 { nearby = nil } })) {
            Button("仍然记录") {
                if let pending = nearby, spatial.canRecord,
                   pending.sample.segmentId == spatial.placement.calibration?.id { _ = session.addSample(pending.sample) }
                nearby = nil
            }
            Button("取消", role: .cancel) { nearby = nil }
        } message: { Text(nearby?.message ?? "") }
    }
    private func capture() {
        do {
            let sample = try spatial.capture()
            if let confirmation = NearbyPoseConfirmation(sample: sample, previousSample: session.current?.result.samples.last) { nearby = confirmation }
            else { _ = session.addSample(sample) }
        } catch { session.error = error.localizedDescription }
    }
    private func nudge(_ label: String, axis: Int) -> some View {
        HStack(spacing: 5) {
            Text(label).font(.caption)
            Button { spatial.nudge(axis: axis, amount: -0.01) } label: { Image(systemName: "minus") }.accessibilityLabel("\(label)减 1 cm")
            Button { spatial.nudge(axis: axis, amount: 0.01) } label: { Image(systemName: "plus") }.accessibilityLabel("\(label)加 1 cm")
        }.controlSize(.small).disabled(spatial.calibrating)
    }
    private func angle(_ label: String, axis: Int, value: Float) -> some View {
        VStack(alignment: .leading) {
            Text("\(label) \(value, specifier: "%.0f")°").font(.caption).monospacedDigit()
            Slider(value: Binding(get: { value }, set: { spatial.setAngle(axis, degrees: $0) }), in: -180...180, step: 1)
                .accessibilityLabel(label)
        }.disabled(spatial.calibrating)
    }
}

struct VisionPoseList: View {
    @EnvironmentObject private var session: TeachingSession
    @State private var editingID: String?
    @State private var editedName = ""
    @State private var deletingID: String?
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if session.current?.result.samples.isEmpty != false {
                    Label("校准后记录第一个 Pose", systemImage: "viewfinder").foregroundStyle(.secondary).padding(.vertical, 20)
                }
                ForEach((session.current?.result.samples ?? []).reversed()) { sample in
                    HStack {
                        Image(systemName: "location.north.circle").foregroundStyle(.yellow)
                        VStack(alignment: .leading) {
                            Text(sample.name).font(.headline)
                            Text(String(format: "x %.3f   y %.3f   z %.3f m", sample.cameraPose.position.x, sample.cameraPose.position.y, sample.cameraPose.position.z))
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if session.current?.result.completedAt == nil {
                            Button { editingID = sample.id; editedName = sample.name } label: { Image(systemName: "pencil") }.accessibilityLabel("重命名 \(sample.name)")
                            Button(role: .destructive) { deletingID = sample.id } label: { Image(systemName: "trash") }.accessibilityLabel("删除 \(sample.name)")
                        }
                    }.padding(8)
                }
            }
        }.disabled(session.busy)
        .alert("重命名 Pose", isPresented: Binding(get: { editingID != nil }, set: { if !$0 { editingID = nil } })) {
            TextField("名称", text: $editedName)
            Button("保存") { if let id = editingID { session.renameSample(id, name: editedName) }; editingID = nil }
            Button("取消", role: .cancel) { editingID = nil }
        }
        .confirmationDialog("删除这个 Pose？", isPresented: Binding(get: { deletingID != nil }, set: { if !$0 { deletingID = nil } }), titleVisibility: .visible) {
            Button("删除", role: .destructive) { if let id = deletingID { session.deleteSample(id) }; deletingID = nil }
            Button("取消", role: .cancel) { deletingID = nil }
        }
    }
}
