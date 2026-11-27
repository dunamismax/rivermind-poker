import RiverMindKit
import SwiftUI

@main
struct RiverMindApp: App {
    @State private var lobby = LobbyModel(client: APIClient(server: RiverMindApp.server))

    var body: some Scene {
        WindowGroup {
            LobbyView(model: lobby)
                .preferredColorScheme(.dark)  // Q-12: dark whatever the phone's appearance
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
