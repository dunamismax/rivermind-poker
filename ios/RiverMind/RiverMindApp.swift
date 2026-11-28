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
            LobbyView(model: lobby, table: table)
                .preferredColorScheme(.dark)  // Q-12: dark whatever the phone's appearance
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
