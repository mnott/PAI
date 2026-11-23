// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PAIMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "PAIMenuBarCore"),
        .executableTarget(name: "PAIMenuBar", dependencies: ["PAIMenuBarCore"]),
        .executableTarget(name: "PAIMenuBarDump", dependencies: ["PAIMenuBarCore"]),
        .testTarget(name: "PAIMenuBarTests", dependencies: ["PAIMenuBarCore"]),
    ]
)
