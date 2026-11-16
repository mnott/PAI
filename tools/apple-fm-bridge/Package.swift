// swift-tools-version:6.4
import PackageDescription

let package = Package(
  name: "apple-fm-bridge",
  platforms: [.macOS(.v27)],
  targets: [
    .executableTarget(name: "apple-fm-bridge")
  ]
)
