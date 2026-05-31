// src/utils/execFileNoThrow.ts
// Safe subprocess wrapper using array-form execFile — no shell string interpolation.
// Never throws: non-zero exit codes are returned as { status: N }, not thrown.
// Use this for ALL subprocess invocations in the codebase.
//
// Security: array-form execFile passes args as an array directly to the OS —
// shell metacharacters (`;`, `|`, `&`, etc.) are inert. Mitigates T-06-04.

import { execFile } from 'node:child_process';

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  /** Process exit code. null if the process was killed by a signal. */
  status: number | null;
}

/**
 * Invoke a subprocess using array-form execFile and return its output.
 * Never throws — non-zero exit codes are captured in the returned status field.
 *
 * @param cmd     Executable name or absolute path. Never a shell string.
 * @param args    Arguments array. Shell metacharacters are inert.
 * @param options Optional execution context (cwd, env, timeout).
 */
export async function execFileNoThrow(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: options?.cwd,
        env: options?.env,
        timeout: options?.timeoutMs,
        // 50 MB buffer — UBT can produce large compilation logs
        maxBuffer: 50 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, status: 0 });
        } else {
          // err.code is the numeric exit status on non-zero exit; null if killed by signal.
          // err.stdout / err.stderr may contain captured output on some Node versions —
          // prefer them when set, fall back to the direct callback params.
          const status = typeof err.code === 'number' ? err.code : null;
          const outStr = (err as NodeJS.ErrnoException & { stdout?: string }).stdout ?? stdout;
          const errStr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? stderr;
          resolve({ stdout: outStr, stderr: errStr, status });
        }
      }
    );
  });
}
