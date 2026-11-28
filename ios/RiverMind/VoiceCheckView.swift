#if DEBUG
    import AVFoundation
    import SwiftUI
    import WebKit

    /// Voice's design check (P5D.9), candidate (b): the site's own voice code, run in
    /// the app's web view. A debug build launched with `RIVERMIND_VOICE_CHECK` set to a
    /// page of the voice checks (`web/voice/check/`, served by `pnpm voice:app`) opens
    /// that page and nothing else; the page runs by itself and posts what it finds to the
    /// server that served it, which the check reads back. `RIVERMIND_VOICE_CHECK_HIDDEN=1`
    /// keeps the web view out of every window, and `2` makes it a transparent point.
    /// Nothing of this ships: a release build has none of it.
    struct VoiceCheckView: View {
        let url: URL
        let hidden: Hidden
        @State private var host = VoiceCheckHost()

        var body: some View {
            VStack(alignment: .leading, spacing: 8) {
                Text("Voice check").font(.headline)
                Text(url.absoluteString.prefix(80)).font(.caption).foregroundStyle(.secondary)
                Text(host.status).font(.caption.monospaced())
                switch hidden {
                case .outOfWindow:
                    Text("The web view is in no window.").font(.caption)
                    Spacer()
                case .tiny:
                    // In the window, but a point square and all but transparent.
                    VoiceCheckWebView(webView: host.webView).frame(width: 1, height: 1).opacity(0.01)
                    Spacer()
                case .shown:
                    VoiceCheckWebView(webView: host.webView)
                        .accessibilityIdentifier("voice-check-web")
                }
            }
            .padding()
            .task { host.start(url: url, hidden: hidden) }
        }

        /// Where the web view is: shown, in no window (`HIDDEN=1`), or in the window as a
        /// transparent point (`HIDDEN=2`).
        enum Hidden { case shown, outOfWindow, tiny }

        static var fromEnvironment: (URL, Hidden)? {
            let environment = ProcessInfo.processInfo.environment
            guard let text = environment["RIVERMIND_VOICE_CHECK"], let url = URL(string: text) else { return nil }
            switch environment["RIVERMIND_VOICE_CHECK_HIDDEN"] {
            case "1": return (url, .outOfWindow)
            case "2": return (url, .tiny)
            default: return (url, .shown)
            }
        }
    }

    @MainActor @Observable final class VoiceCheckHost: NSObject, WKUIDelegate, WKNavigationDelegate {
        let webView: WKWebView
        var status = "starting"

        /// Pages from the app's own files rather than a server, as bundled voice code
        /// would be: `RIVERMIND_VOICE_CHECK_ROOT` names the built check pages, and a
        /// `rivermind-check://app/…` address serves them through `BundledPages`, a
        /// `file://` one straight from the disk.
        static let root = ProcessInfo.processInfo.environment["RIVERMIND_VOICE_CHECK_ROOT"].map {
            URL(filePath: $0, directoryHint: .isDirectory)
        }
        /// Where results go: the check server's `/result`.
        static let results = URL(string: ProcessInfo.processInfo.environment["RIVERMIND_VOICE_CHECK_RESULTS"]
            ?? "http://127.0.0.1:4391/result")!
        private var sessionTimer: Timer?

        override init() {
            let configuration = WKWebViewConfiguration()
            if let root = Self.root {
                configuration.setURLSchemeHandler(BundledPages(root: root, results: Self.results), forURLScheme: "rivermind-check")
            }
            configuration.allowsInlineMediaPlayback = true
            configuration.mediaTypesRequiringUserActionForPlayback = []
            webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 600), configuration: configuration)
            webView.isInspectable = true
            super.init()
            webView.uiDelegate = self
            webView.navigationDelegate = self
        }

        func start(url: URL, hidden: VoiceCheckView.Hidden) {
            // As a call app would: play and record, voice chat, the speaker by default.
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
                try session.setActive(true)
            } catch {
                status = "audio session: \(error.localizedDescription)"
            }
            if url.isFileURL, let root = Self.root {
                webView.loadFileURL(url, allowingReadAccessTo: root)
            } else {
                webView.load(URLRequest(url: url))
            }
            status = "loading (\(hidden))"
            // What the audio session is while the page runs: WebKit may change it.
            sessionTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
                Task { @MainActor in Self.postSession() }
            }
        }

        static func postSession() {
            let session = AVAudioSession.sharedInstance()
            let state: [String: Any] = [
                "room": "audio-session", "at": Int(Date().timeIntervalSince1970 * 1000),
                "session": [
                    "category": session.category.rawValue, "mode": session.mode.rawValue,
                    "options": session.categoryOptions.rawValue,
                    "outputs": session.currentRoute.outputs.map(\.portType.rawValue),
                    "inputs": session.currentRoute.inputs.map(\.portType.rawValue),
                    "otherAudioPlaying": session.isOtherAudioPlaying,
                    "state": UIApplication.shared.applicationState.rawValue,
                ],
            ]
            var request = URLRequest(url: results)
            request.httpMethod = "POST"
            request.httpBody = try? JSONSerialization.data(withJSONObject: state)
            URLSession.shared.dataTask(with: request).resume()
        }

        // The page's microphone: granted here, since the person chose to join voice
        // before the page was ever loaded; iOS still asks once for the app itself.
        func webView(
            _ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
            initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType
        ) async -> WKPermissionDecision {
            .grant
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            status = "loaded"
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            status = "failed: \(error.localizedDescription)"
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            status = "web content process ended"
        }
    }

    /// The check pages from the app's own files under `rivermind-check://app/`, with
    /// the site's policy, as bundled voice code would be served; a page's `POST
    /// /result` goes on to the check server.
    final class BundledPages: NSObject, WKURLSchemeHandler {
        let root: URL
        let results: URL
        init(root: URL, results: URL) {
            self.root = root
            self.results = results
        }

        static let policy = [
            "default-src 'self'", "img-src 'self' data:", "style-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self' ws://127.0.0.1:4392",
            "object-src 'none'", "base-uri 'self'",
        ].joined(separator: "; ")

        func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
            let request = task.request
            guard let url = request.url else { return }
            if url.path == "/result" {
                var forward = URLRequest(url: results)
                forward.httpMethod = "POST"
                forward.httpBody = request.httpBody
                URLSession.shared.dataTask(with: forward).resume()
                respond(task, url: url, status: 204, type: "text/plain", body: Data())
                return
            }
            let path = url.path == "/" || url.path.isEmpty ? "index.html" : String(url.path.dropFirst())
            guard let body = try? Data(contentsOf: root.appending(path: path)) else {
                respond(task, url: url, status: 404, type: "text/plain", body: Data())
                return
            }
            let type =
                switch (path as NSString).pathExtension {
                case "html": "text/html"
                case "js": "text/javascript"
                case "wasm": "application/wasm"
                case "json": "application/json"
                case "css": "text/css"
                default: "application/octet-stream"
                }
            respond(task, url: url, status: 200, type: type, body: body)
        }

        func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}

        private func respond(_ task: any WKURLSchemeTask, url: URL, status: Int, type: String, body: Data) {
            let response = HTTPURLResponse(
                url: url, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": type, "Content-Security-Policy": Self.policy, "Cache-Control": "no-store",
                ])!
            task.didReceive(response)
            task.didReceive(body)
            task.didFinish()
        }
    }

    private struct VoiceCheckWebView: UIViewRepresentable {
        let webView: WKWebView
        func makeUIView(context: Context) -> WKWebView { webView }
        func updateUIView(_ view: WKWebView, context: Context) {}
    }
#endif
