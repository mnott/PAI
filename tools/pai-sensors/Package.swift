// swift-tools-version:6.4
import PackageDescription

let package = Package(
  name: "pai-sensors",
  platforms: [.macOS(.v15)],
  targets: [
    .executableTarget(name: "pai-sensors")
  ]
)
