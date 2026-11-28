import RiverMindKit
import SwiftUI

@main
struct RiverMindApp: App {
    @State private var lobby = LobbyModel(client: .app(server: RiverMindApp.server))
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
