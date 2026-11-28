import RiverMindKit
import SwiftUI

@main
struct RiverMindApp: App {
    @State private var lobby = LobbyModel(client: .app(server: RiverMindApp.server), build: RiverMindApp.build)
    /// The guest's table, followed across launches (P5D.3).
    @State private var table = TableConnection(
        client: .app(server: RiverMindApp.server), memory: DefaultsTableMemory(server: RiverMindApp.server))
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            root
                .kitPage()  // the site's night and gold, dark whatever the phone's appearance (Q-12)
                .task {
                    table.watchNetwork()
                    table.start()
                }
        }
        .onChange(of: scenePhase) { _, phase in
            // Q-16: out of voice, the table lets go in the background and rejoins on return.
            switch phase {
            case .active: table.phase(.active)
            case .background: table.phase(.background)
            default: table.phase(.inactive)
            }
        }
    }

    @ViewBuilder private var root: some View {
        #if DEBUG
            // `-gallery` opens the kit's gallery (P5D.5), for screenshots and its UI test.
            if ProcessInfo.processInfo.arguments.contains("-gallery") {
                NavigationStack { GalleryView() }
            } else {
                RootView(model: lobby, table: table)
            }
        #else
            RootView(model: lobby, table: table)
        #endif
    }

    /// This build's number, or in a debug build the older one `RIVERMIND_PRETEND_BUILD`
    /// names, for the UI test of the update screen (P5D.11).
    static var build: Int {
        #if DEBUG
            if let pretend = ProcessInfo.processInfo.environment["RIVERMIND_PRETEND_BUILD"].flatMap(Int.init) {
                return pretend
            }
        #endif
        return AppBuild.number
    }

    /// The live site, or in a debug build the server `RIVERMIND_SERVER` names
    /// (the UI tests and `ios/test.sh` set it to a local Node server).
    static var server: Server {
        #if DEBUG
            if let local = Server.from(environment: ProcessInfo.processInfo.environment) {
                return local
            }
        #endif
        return .live
    }
}
