import SwiftUI

struct SpatialLevelView: View {
    let reading: SpatialLevelReading?
    let placed: Bool
    private let tint = Color(red: 0.35, green: 0.86, blue: 0.91)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("空间水平仪").font(.caption.weight(.semibold))
                Spacer()
                Text("仅参考").font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 14) {
                dial.frame(width: 86, height: 86).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(reading.map { String(format: "%.1f°", $0.planeDegrees) } ?? "—")
                        .font(.system(size: 27, weight: .light, design: .monospaced)).monospacedDigit()
                        .foregroundStyle(reading == nil ? Color.secondary : tint)
                        .accessibilityIdentifier("spatial-level-angle")
                    Text("屏幕夹角").font(.caption2).foregroundStyle(.secondary)
                }
            }
            if let reading {
                HStack {
                    Text("左右 \(signed(reading.horizontalDegrees))")
                    Spacer(minLength: 4)
                    Text("上下 \(signed(reading.verticalDegrees))")
                }.font(.system(size: 11, design: .monospaced)).monospacedDigit()
                Text("模型基准面与屏幕平行时为 0°")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            } else {
                Text(placed ? "定位暂不可用，角度暂停" : "放置模型后显示相对倾角")
                    .font(.caption2).foregroundStyle(.secondary)
                    .accessibilityIdentifier("spatial-level-status")
            }
        }
        .padding(14)
        .background(.black.opacity(0.73), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.12)))
        .accessibilityElement(children: .contain).accessibilityIdentifier("spatial-level")
    }
    private func signed(_ value: Float) -> String { String(format: "%+.1f°", abs(value) < 0.05 ? 0 : value) }
    private var dial: some View {
        GeometryReader { size in
            let center = size.size.width / 2
            let radius = center - 7
            ZStack {
                Circle().fill(tint.opacity(0.035))
                Circle().strokeBorder(.white.opacity(0.25), lineWidth: 1)
                Circle().strokeBorder(.white.opacity(0.12), lineWidth: 1).padding(center * 0.45)
                Path { path in
                    path.move(to: CGPoint(x: center, y: 5)); path.addLine(to: CGPoint(x: center, y: size.size.height - 5))
                    path.move(to: CGPoint(x: 5, y: center)); path.addLine(to: CGPoint(x: size.size.width - 5, y: center))
                }.stroke(.white.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
                if let reading {
                    Circle().fill(tint).frame(width: 12, height: 12)
                        .overlay(Circle().strokeBorder(.white.opacity(0.7), lineWidth: 1))
                        .offset(x: CGFloat(reading.normalInScreen.x) * radius, y: -CGFloat(reading.normalInScreen.y) * radius)
                        .animation(.linear(duration: 0.1), value: reading.normalInScreen)
                }
                Circle().strokeBorder(.white.opacity(0.65), lineWidth: 1).frame(width: 6, height: 6)
            }
        }
    }
}
