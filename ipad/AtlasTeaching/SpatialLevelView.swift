import SwiftUI
import simd

struct SpatialLevelView: View {
    let reading: SpatialLevelReading?
    private let tint = Color(red: 0.35, green: 0.86, blue: 0.91)
    private var aligned: Bool { reading?.isAligned == true }
    private var status: String { reading == nil ? "等待定位" : aligned ? "已对齐" : "调整姿态" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("姿态坐标轴").font(.caption.weight(.semibold))
                Spacer()
                Label(status, systemImage: aligned ? "checkmark.circle.fill" : "circle.dashed")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(aligned ? Color.green : .secondary)
                    .accessibilityIdentifier("spatial-level-status")
            }
            HStack(spacing: 8) {
                CoordinateAxesView(orientation: reading?.deviceAxesInReference)
                    .frame(width: 112, height: 116)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Z 轴偏差").font(.caption2).foregroundStyle(.secondary)
                    Text(reading.map { String(format: "%.2f°", $0.zDeviationDegrees) } ?? "—")
                        .font(.system(size: 23, weight: .medium, design: .monospaced)).monospacedDigit()
                        .lineLimit(1).minimumScaleFactor(0.65)
                        .foregroundStyle(reading == nil ? Color.secondary : aligned ? .green : tint)
                        .accessibilityIdentifier("spatial-level-angle")
                    Text("≤ 1.5° 变绿").font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            Text("半透明：标准  ·  实色：iPad").font(.system(size: 10)).foregroundStyle(.secondary)
            Text("X 前  ·  Y 左  ·  Z 上").font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .padding(14)
        .background(aligned ? Color(red: 0.03, green: 0.24, blue: 0.10).opacity(0.94) : Color.black.opacity(0.73),
            in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(aligned ? Color.green : .white.opacity(0.12), lineWidth: aligned ? 1.5 : 1))
        .accessibilityElement(children: .contain).accessibilityIdentifier("spatial-level")
            .accessibilityValue(status)
    }
}

// Both frames share an origin and the same orthographic projection. A wider,
// translucent reference stays visible beneath a coincident live axis.
private struct CoordinateAxesView: View {
    let orientation: simd_float3x3?
    private let colors: [Color] = [Color(red: 1, green: 0.28, blue: 0.26),
        Color(red: 0.28, green: 0.87, blue: 0.38), Color(red: 0.27, green: 0.56, blue: 1)]

    var body: some View {
        Canvas { context, size in
            let origin = CGPoint(x: size.width / 2, y: size.height / 2)
            let scale = max(0, min(size.width, size.height) / 2 - 18)
            // A fixed isometric camera looking from +X/+Y/+Z at the origin.
            let right = simd_normalize(SIMD3<Float>(-1, 1, 0))
            let up = simd_normalize(SIMD3<Float>(-1, -1, 2))
            let towardViewer = simd_normalize(SIMD3<Float>(1, 1, 1))
            func draw(_ vector: SIMD3<Float>, axis: Int, reference: Bool) {
                let dx = CGFloat(simd_dot(vector, right)), dy = -CGFloat(simd_dot(vector, up))
                let length = hypot(dx, dy)
                let tip = CGPoint(x: origin.x + dx * scale, y: origin.y + dy * scale)
                let color = colors[axis].opacity(reference ? 0.28 : 1)
                var line = Path(); line.move(to: origin); line.addLine(to: tip)
                context.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: reference ? 7 : 3.5, lineCap: .round))
                if length > 0.08 {
                    let ux = dx / length, uy = dy / length
                    let head: CGFloat = reference ? 10 : 8
                    var arrow = Path()
                    arrow.move(to: tip)
                    arrow.addLine(to: CGPoint(x: tip.x - ux * head - uy * head * 0.48, y: tip.y - uy * head + ux * head * 0.48))
                    arrow.addLine(to: CGPoint(x: tip.x - ux * head + uy * head * 0.48, y: tip.y - uy * head - ux * head * 0.48))
                    arrow.closeSubpath()
                    context.fill(arrow, with: .color(color))
                    if !reference || orientation == nil {
                        context.draw(Text(["X", "Y", "Z"][axis]).font(.system(size: 12, weight: .bold, design: .rounded)).foregroundColor(color),
                            at: CGPoint(x: tip.x + ux * 12, y: tip.y + uy * 12))
                    }
                } else if !reference {
                    // End-on axes remain visible instead of vanishing at zero projected length.
                    let dot = Path(ellipseIn: CGRect(x: origin.x - 4, y: origin.y - 4, width: 8, height: 8))
                    context.stroke(dot, with: .color(color), lineWidth: 2)
                    context.draw(Text(["X", "Y", "Z"][axis]).font(.system(size: 12, weight: .bold)).foregroundColor(color),
                        at: CGPoint(x: origin.x + 13, y: origin.y - 12))
                }
            }
            for axis in 0..<3 { draw(matrix_identity_float3x3[axis], axis: axis, reference: true) }
            if let orientation {
                for axis in (0..<3).sorted(by: { simd_dot(orientation[$0], towardViewer) < simd_dot(orientation[$1], towardViewer) }) {
                    draw(orientation[axis], axis: axis, reference: false)
                }
            }
            context.fill(Path(ellipseIn: CGRect(x: origin.x - 2.5, y: origin.y - 2.5, width: 5, height: 5)), with: .color(.white.opacity(0.8)))
        }.accessibilityHidden(true)
    }
}
