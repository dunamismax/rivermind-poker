// swift-tools-version: 6.2
// RiverMindKit: everything of the iPhone app that is not a screen (docs/ios.md).
// `swift test` runs it on a Mac without a simulator. Swift 6.2 is the oldest
// toolchain it must build with, Xcode 26's, which CI's runner has.

import PackageDescription

let package = Package(
    name: "RiverMindKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "RiverMindKit", targets: ["RiverMindKit"])
    ],
    targets: [
        .target(name: "RiverMindKit"),
        .testTarget(name: "RiverMindKitTests", dependencies: ["RiverMindKit"]),
    ],
    swiftLanguageModes: [.v6]
)
