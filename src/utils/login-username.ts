import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

let cached: string | undefined;

/**
 * The login account name, without trusting the environment: a launchd service
 * has no USER/LOGNAME, and os.userInfo() then throws ERR_SYSTEM_ERROR
 * (uv_os_get_passwd ENOENT). `id -un` reads the passwd entry of the real uid;
 * os.userInfo and env are only fallbacks. Cached after the first success.
 */
export function loginUsername(): string {
  if (cached) return cached;
  const tries: Array<() => string | undefined> = [
    () => execFileSync("id", ["-un"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }),
    () => userInfo().username,
    () => process.env.USER || process.env.LOGNAME,
  ];
  for (const t of tries) {
    try {
      const n = t()?.trim();
      if (n) return (cached = n);
    } catch {
      /* next source */
    }
  }
  return "";
}

/** Test seam: forget the cached name. */
export function resetLoginUsername(): void {
  cached = undefined;
}
