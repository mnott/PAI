/**
 * iTerm2 exports __CFBundleIdentifier into its shells. Any inherited process
 * that touches AppKit/LaunchServices (osascript, chromedriver, helpers) then
 * registers AS iTerm2, and AppleScript sent to iTerm2 hits that impostor
 * (-600/-1708). Entry points call this first so nothing they spawn inherits it.
 */
export function dropItermBundleId(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin" && env.__CFBundleIdentifier === "com.googlecode.iterm2") {
    delete env.__CFBundleIdentifier;
  }
}
