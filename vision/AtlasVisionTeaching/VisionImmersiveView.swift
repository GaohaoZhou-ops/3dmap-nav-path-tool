import SwiftUI
import RealityKit

struct VisionImmersiveView: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @State private var spaceID = UUID()
    var body: some View {
        RealityView { content, attachments in
            content.add(spatial.root)
            spatial.panelRoot.children.forEach { $0.removeFromParent() }
            if let panel = attachments.entity(for: "controls") { spatial.panelRoot.addChild(panel) }
        } attachments: {
            Attachment(id: "controls") {
                if session.current != nil {
                    VisionTeachingControls(compact: true).padding(22).frame(width: 560).glassBackgroundEffect()
                        .environmentObject(session).environmentObject(spatial)
                }
            }
        }
        .gesture(SpatialTapGesture().targetedToAnyEntity().onEnded { value in
            guard value.entity.name == "atlas-surface" else { return }
            let point = value.convert(value.location3D, from: .local, to: .scene)
            spatial.place(at: point)
        })
        .task { await spatial.spaceAppeared(spaceID) }
        .onDisappear {
            spatial.spaceDisappeared(spaceID)
            session.backgroundSave()
        }
    }
}
