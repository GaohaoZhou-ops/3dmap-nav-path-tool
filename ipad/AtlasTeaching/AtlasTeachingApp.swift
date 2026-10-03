import SwiftUI

@main
struct AtlasTeachingApp: App {
    @StateObject private var session = TeachingSession()
    var body: some Scene {
        WindowGroup { ContentView().environmentObject(session).preferredColorScheme(.dark) }
    }
}
