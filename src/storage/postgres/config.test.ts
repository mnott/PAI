import { fakeUrl } from "../../utils/fake-secret.js";
import { describe, it, expect } from "vitest";
import { postgresConnectionString } from "./config.js";

describe("postgresConnectionString", () => {
  it("builds the default URL from no parts", () => {
    expect(postgresConnectionString({})).toBe(fakeUrl("postgresql", "pai", "pai", "localhost:5432/pai"));
  });
  it("uses the given parts", () => {
    expect(postgresConnectionString({ user: "u", password: "p", host: "h", port: 1, database: "d" })).toBe(
      fakeUrl("postgresql", "u", "p", "h:1/d"),
    );
  });
  it("lets connectionString win", () => {
    expect(postgresConnectionString({ connectionString: "postgresql://x/y", host: "h" })).toBe("postgresql://x/y");
  });
});
