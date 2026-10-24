import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";

let cached: string | undefined;

/** A passwd lookup that failed prints the numeric uid (`id -un` → "501"); that is not a name. */
function isName(n: string | undefined): n is string {
  return !!n && !/^\d+$/.test(n);
}

/**
 * The login account name, without trusting the environment: a launchd service
 * has no USER/LOGNAME, and os.userInfo() then throws ERR_SYSTEM_ERROR
 * (uv_os_get_passwd ENOENT). `id -un` reads the passwd entry of the real uid;
 * os.userInfo and env are only fallbacks. When the passwd lookup itself fails
 * (directory-service account) `id -un` prints the numeric uid, so every
 * candidate is rejected if it is all digits. Cached after the first success;
 * a numeric or empty result is never cached.
 */
export function loginUsername(): string {
  if (cached) return cached;
  const tries: Array<() => string | undefined> = [
    () => execFileSync("id", ["-un"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }),
    () => userInfo().username,
    () => process.env.USER,
    () => process.env.LOGNAME,
    () => {
      const home = homedir() || process.env.HOME;
      return home ? home.replace(/\/+$/, "").split("/").pop() : undefined;
    },
  ];
  for (const t of tries) {
    try {
      const n = t()?.trim();
      if (isName(n)) return (cached = n);
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
