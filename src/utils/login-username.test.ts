import { describe, it, expect, afterEach } from "vitest";
import { loginUsername, resetLoginUsername } from "./login-username.js";

describe("loginUsername", () => {
  const saved = { USER: process.env.USER, LOGNAME: process.env.LOGNAME };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    resetLoginUsername();
  });
  it("resolves the account with USER and LOGNAME unset", () => {
    delete process.env.USER;
    delete process.env.LOGNAME;
    resetLoginUsername();
    expect(loginUsername()).toMatch(/\S/);
  });
  it("is cached", () => {
    const a = loginUsername();
    process.env.USER = "someone-else";
    expect(loginUsername()).toBe(a);
  });
});
