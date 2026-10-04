import SwiftUI
import AVFoundation
import VisionKit

struct PairingScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var permission = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var cameraError: String?
    @State private var scanMessage = "对准电脑上的 Atlas 配对二维码"
    let onScan: (PairingQRCode) -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Text("扫描电脑「iPad 运行」窗口中的二维码，识别后自动连接并接收物体。")
                    .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                Group {
                    if DataScannerViewController.isSupported && permission == .authorized && cameraError == nil {
                        PairingCamera(active: scenePhase == .active, onScan: onScan,
                            onMessage: { scanMessage = $0 }, onError: { cameraError = $0 })
                            .accessibilityIdentifier("pairing-camera")
                    } else {
                        VStack(spacing: 20) {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 70, weight: .ultraLight))
                            Text(cameraHelp).multilineTextAlignment(.center).accessibilityIdentifier("scanner-camera-help")
                            if permission == .denied {
                                Button("前往设置开启相机") {
                                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                                }.buttonStyle(.borderedProminent)
                            } else if cameraError != nil {
                                Button("重新开启相机") { cameraError = nil; Task { await prepareCamera() } }.buttonStyle(.bordered)
                            }
                        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(.white.opacity(0.04))
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity).clipShape(RoundedRectangle(cornerRadius: 18))
                Text(scanMessage).font(.callout).multilineTextAlignment(.center).accessibilityIdentifier("scanner-status")
                Label("电脑与 iPad 需连接同一局域网", systemImage: "wifi").font(.caption).foregroundStyle(.secondary)
            }.padding(24)
                .background(Color(red: 0.025, green: 0.05, blue: 0.065))
                .navigationTitle("扫码配对").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.accessibilityIdentifier("cancel-pairing-scan")
                } }
                .task { await prepareCamera() }
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await prepareCamera() } } }
        }
    }
    private var cameraHelp: String {
        if !DataScannerViewController.isSupported { return "当前设备不支持相机扫码，可返回使用四位配对码。" }
        if permission == .denied { return "请允许相机访问，以扫描电脑上的配对二维码。" }
        if permission == .restricted { return "相机访问受到系统限制，可返回使用四位配对码。" }
        return cameraError ?? "正在准备相机…"
    }
    private func prepareCamera() async {
        guard DataScannerViewController.isSupported else { return }
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
        }
        permission = AVCaptureDevice.authorizationStatus(for: .video)
    }
}

private struct PairingCamera: UIViewControllerRepresentable {
    let active: Bool
    let onScan: (PairingQRCode) -> Void
    let onMessage: (String) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }
    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.parent = self
        guard active && !context.coordinator.finished else { scanner.stopScanning(); return }
        guard !scanner.isScanning else { return }
        do { try scanner.startScanning() }
        catch { DispatchQueue.main.async { onError("相机暂时不可用，请关闭其他相机画面后重试。") } }
    }
    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        coordinator.finished = true; scanner.stopScanning(); scanner.delegate = nil
    }
    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var parent: PairingCamera
        var finished = false
        private var lastValue: String?
        init(parent: PairingCamera) { self.parent = parent }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            read(allItems, scanner: scanner)
        }
        func dataScanner(_ scanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            read(allItems, scanner: scanner)
        }
        private func read(_ items: [RecognizedItem], scanner: DataScannerViewController) {
            guard !finished, parent.active else { return }
            for item in items {
                guard case let .barcode(barcode) = item, let value = barcode.payloadStringValue, value != lastValue else { continue }
                lastValue = value
                do {
                    let qr = try PairingQRCode.parse(value)
                    finished = true; scanner.stopScanning(); parent.onScan(qr)
                    return
                } catch { parent.onMessage(error.localizedDescription) }
            }
        }
        func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            scanner.stopScanning()
            parent.onError("相机扫码已中断，请重试或返回使用四位配对码。")
        }
    }
}
