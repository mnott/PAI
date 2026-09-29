import { describe, expect, it } from "vitest";
import { dropItermBundleId } from "./env.js";

describe("dropItermBundleId", () => {
  it("removes iTerm's id on darwin", () => {
    const env: NodeJS.ProcessEnv = { __CFBundleIdentifier: "com.googlecode.iterm2" };
    dropItermBundleId(env, "darwin");
    expect(env.__CFBundleIdentifier).toBeUndefined();
  });

  it("keeps any other value", () => {
    const env: NodeJS.ProcessEnv = { __CFBundleIdentifier: "com.apple.Terminal" };
    dropItermBundleId(env, "darwin");
    expect(env.__CFBundleIdentifier).toBe("com.apple.Terminal");
  });

  it("leaves non-darwin untouched", () => {
    const env: NodeJS.ProcessEnv = { __CFBundleIdentifier: "com.googlecode.iterm2" };
    dropItermBundleId(env, "linux");
    expect(env.__CFBundleIdentifier).toBe("com.googlecode.iterm2");
  });
});
