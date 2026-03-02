/**
 * detect-environment.ts
 *
 * Environment detection utilities for PAI hooks.
 *
 * Determines if the system is running in a remote environment (SSH, cloud, etc.)
 * to conditionally adjust hook behaviour.
 *
 * Detection Logic (in priority order):
 * 1. Check PAI_ENVIRONMENT env var (explicit override)
 * 2. Check for SSH indicators (SSH_CLIENT, SSH_TTY)
 * 3. Default to local environment
 */

/**
 * Check if we're running in an SSH session
 * Looks for SSH_CLIENT or SSH_TTY environment variables
 */
function isSSHSession(): boolean {
  return !!(process.env.SSH_CLIENT || process.env.SSH_TTY);
}

/**
 * Main detection function - determines if we're in a remote environment
 *
 * Returns:
 * - true: Remote environment
 * - false: Local environment
 *
 * Detection priority:
 * 1. PAI_ENVIRONMENT === 'remote' → true
 * 2. PAI_ENVIRONMENT === 'local' → false
 * 3. SSH_CLIENT or SSH_TTY set → true
 * 4. Otherwise → false (local)
 */
export function isRemoteEnvironment(): boolean {
  // 1. Check explicit environment override
  const paiEnv = process.env.PAI_ENVIRONMENT?.toLowerCase();
  if (paiEnv === 'remote') {
    return true;
  }
  if (paiEnv === 'local') {
    return false;
  }

  // 2. Check for SSH session
  if (isSSHSession()) {
    return true;
  }

  // 3. Default to local environment
  return false;
}
