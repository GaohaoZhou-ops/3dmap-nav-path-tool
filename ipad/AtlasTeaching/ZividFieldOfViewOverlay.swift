import SwiftUI

struct ZividFieldOfViewOverlay: View {
    let fieldOfView: ZividFieldOfView
    var labelAtTop = false
    private let tint = Color(red: 0.35, green: 0.86, blue: 0.91)

    var body: some View {
        GeometryReader { geometry in
            let bounds = CGRect(origin: .zero, size: geometry.size)
            let aperture = fieldOfView.aperture(in: geometry.size)
            let visible = aperture.intersection(bounds)
            ZStack(alignment: .topLeading) {
                Path { path in
                    path.addRect(bounds)
                    if !visible.isNull { path.addRect(visible) }
                }.fill(.black.opacity(0.72), style: FillStyle(eoFill: true))
                    .accessibilityHidden(true)
                Rectangle().strokeBorder(fieldOfView.fullyVisible ? tint : .orange, lineWidth: 1.5)
                    .frame(width: aperture.width, height: aperture.height)
                    .position(x: aperture.midX, y: aperture.midY)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Zivid 2 M70 视野")
                    .accessibilityValue(fieldOfView.fullyVisible ? "完整视野" : "部分视野")
                    .accessibilityIdentifier("zivid-fov-aperture")
                if !visible.isNull, visible.width > 90, visible.height > 40 {
                    Text("M70").font(.system(.caption, design: .monospaced).weight(.semibold))
                        .foregroundStyle(tint).padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 5))
                        .position(x: visible.maxX - 36, y: labelAtTop ? visible.minY + 22 : visible.maxY - 22)
                        .accessibilityHidden(true)
                }
            }
        }.clipped().allowsHitTesting(false)
    }
}
