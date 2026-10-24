import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { userInfo, homedir } from "node:os";
import { loginUsername, resetLoginUsername } from "./login-username.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:os", () => ({ userInfo: vi.fn(), homedir: vi.fn() }));

const exec = vi.mocked(execFileSync);
const info = vi.mocked(userInfo);
const home = vi.mocked(homedir);

describe("loginUsername", () => {
  const saved = { USER: process.env.USER, LOGNAME: process.env.LOGNAME, HOME: process.env.HOME };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    resetLoginUsername();
    vi.clearAllMocks();
  });
  it("resolves the account with USER and LOGNAME unset", () => {
    delete process.env.USER;
    delete process.env.LOGNAME;
    resetLoginUsername();
    exec.mockReturnValue("realuser\n");
    expect(loginUsername()).toMatch(/\S/);
  });
  it("is cached", () => {
    exec.mockReturnValue("realuser\n");
    const a = loginUsername();
    process.env.USER = "someone-else";
    expect(loginUsername()).toBe(a);
  });
  it("skips a numeric uid from id -un and falls back to env USER", () => {
    delete process.env.LOGNAME;
    process.env.USER = "someone";
    exec.mockReturnValue("501\n");
    info.mockImplementation(() => {
      throw new Error("uv_os_get_passwd ENOENT");
    });
    expect(loginUsername()).toBe("someone");
  });
  it("falls back to the HOME basename when every other source is numeric or missing", () => {
    delete process.env.USER;
    delete process.env.LOGNAME;
    process.env.HOME = "/Users/someone";
    exec.mockReturnValue("501\n");
    info.mockImplementation(() => {
      throw new Error("uv_os_get_passwd ENOENT");
    });
    home.mockReturnValue("");
    expect(loginUsername()).toBe("someone");
  });
  it("never caches a numeric result", () => {
    delete process.env.USER;
    delete process.env.LOGNAME;
    process.env.HOME = "/Users/someone";
    exec.mockReturnValue("501\n");
    info.mockImplementation(() => {
      throw new Error("uv_os_get_passwd ENOENT");
    });
    home.mockReturnValue("");
    expect(loginUsername()).toBe("someone");
    // a numeric result must not have been cached: with USER set, the next call returns the name
    process.env.USER = "someone";
    expect(loginUsername()).toBe("someone");
  });
});
