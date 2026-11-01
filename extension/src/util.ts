import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** PATH augmented with the default elan install location, so lake/lean are found even
 * when VS Code was started before elan was installed. */
export function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const elanBin = path.join(os.homedir(), '.elan', 'bin');
  const p = process.env.PATH ?? '';
  return { ...process.env, PATH: p.split(path.delimiter).includes(elanBin) ? p : `${elanBin}${path.delimiter}${p}`, ...extra };
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(cmd, args, { cwd: opts.cwd, env: toolEnv(), shell: false });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

export async function which(cmd: string): Promise<string | undefined> {
  const r = await run('bash', ['-lc', `command -v ${cmd}`], { timeoutMs: 5000 });
  const out = r.stdout.trim();
  if (r.code === 0 && out) return out;
  const elan = path.join(os.homedir(), '.elan', 'bin', cmd);
  return fs.existsSync(elan) ? elan : undefined;
}

export function findLakeRoot(file: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'lakefile.lean')) || fs.existsSync(path.join(dir, 'lakefile.toml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The Lake project that hosts graspt-trace / graspt-atlas. */
export function toolsProject(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('graspt').get<string>('toolsProject');
  if (cfg) return path.isAbsolute(cfg) ? cfg : path.join(workspaceRoot() ?? '', cfg);
  const ws = workspaceRoot();
  if (!ws) return undefined;
  const candidate = path.join(ws, 'lean');
  if (fs.existsSync(path.join(candidate, 'lakefile.lean'))) return candidate;
  if (fs.existsSync(path.join(ws, 'lakefile.lean'))) return ws;
  return undefined;
}

export function tracerBinary(project: string): string {
  return path.join(project, '.lake', 'build', 'bin', 'graspt-trace');
}

export function atlasBinary(project: string): string {
  return path.join(project, '.lake', 'build', 'bin', 'graspt-atlas');
}

export function atlasDir(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('graspt').get<string>('atlasDir');
  if (cfg) return path.isAbsolute(cfg) ? cfg : path.join(workspaceRoot() ?? '', cfg);
  const p = toolsProject();
  return p ? path.join(p, '.graspt', 'atlas') : undefined;
}

export function grasptStateDir(): string | undefined {
  const ws = workspaceRoot();
  return ws ? path.join(ws, '.graspt') : undefined;
}
