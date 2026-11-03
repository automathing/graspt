import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';

// Shared subprocess helpers (Lean/pi-free provisioning + git + lake).

export function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const extraBins = [path.join(os.homedir(), '.elan', 'bin'), path.join(os.homedir(), '.local', 'bin'), '/home/codespace/nvm/current/bin'];
  const parts = (process.env.PATH ?? '').split(path.delimiter);
  for (const b of extraBins) if (!parts.includes(b)) parts.unshift(b);
  return { ...process.env, PATH: parts.join(path.delimiter), ...extra };
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: cp.ChildProcess;
    try {
      // stdin closed: several CLIs read piped stdin until EOF and would hang.
      child = cp.spawn(cmd, args, { cwd: opts.cwd, env: toolEnv(opts.env), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false });
      return;
    }
    let stdout = '', stderr = '', timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs) : undefined;
    child.stdout?.on('data', (d) => { stdout += d.toString(); if (stdout.length > 200_000) stdout = stdout.slice(0, 200_000); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 50_000) stderr = stderr.slice(0, 50_000); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e), timedOut }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

export async function which(cmd: string): Promise<string | undefined> {
  const r = await run('bash', ['-lc', `command -v ${cmd}`], { timeoutMs: 5000 });
  const out = r.stdout.trim().split('\n')[0];
  return r.code === 0 && out ? out : undefined;
}
