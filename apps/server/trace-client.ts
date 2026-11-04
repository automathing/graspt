import * as cp from 'child_process';
import * as path from 'path';
import type { TraceResult } from '../../packages/core/types';
import { packageRoot } from './store';
import { toolEnv } from './exec';

/**
 * `graspt-trace --server` client, one tracer process per file.
 *
 * Measured behaviour that shapes this design: a tracer process elaborates
 * the first file it sees correctly and every *different* file after it
 * with a polluted parser environment (its notation fails to parse), while
 * repeated traces of the same file are correct and warm (~0.1s after a
 * ~3s cold trace). So the client spawns one process per file, restarts it
 * when the file changes, and serialises requests. A timed-out request
 * kills the process; the next request respawns it.
 */
export class TraceClient {
  private child: cp.ChildProcess | undefined;
  private childFile: string | undefined;
  private buffer = '';
  private waiters: ((line: string) => void)[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;

  private killCurrent(): void {
    try { this.child?.kill('SIGKILL'); } catch { /* already gone */ }
    this.child = undefined;
    this.childFile = undefined;
    this.waiters = [];
    this.buffer = '';
  }

  private ensure(file: string): cp.ChildProcess {
    if (this.child && !this.child.killed && this.childFile === file) return this.child;
    this.killCurrent();
    const project = path.join(packageRoot(), 'lean');
    const child = cp.spawn('lake', ['exe', 'graspt-trace', '--server'], {
      cwd: project, env: toolEnv(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.childFile = file;
    child.stdout?.on('data', (d) => {
      this.buffer += d.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.trim()) this.waiters.shift()?.(line);
      }
    });
    child.on('exit', () => { if (this.child === child) { this.child = undefined; this.childFile = undefined; } });
    return child;
  }

  private requestOnce(file: string, content: string, timeoutMs: number): Promise<TraceResult> {
    const child = this.ensure(file);
    const id = `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.killCurrent();
        reject(new Error(`graspt-trace timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const handle = (line: string) => {
        try {
          const parsed = JSON.parse(line) as TraceResult & { ready?: boolean };
          if (parsed.ready) { this.waiters.unshift(handle); return; }
          clearTimeout(timer);
          resolve(parsed);
        } catch {
          clearTimeout(timer);
          reject(new Error('graspt-trace returned non-JSON'));
        }
      };
      this.waiters.push(handle);
      child.stdin?.write(JSON.stringify({ id, file, content }) + '\n');
    });
  }

  trace(file: string, content: string, timeoutMs = 240_000): Promise<TraceResult> {
    const run = () => this.requestOnce(file, content, timeoutMs);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  close(): void { this.killCurrent(); }
}

let shared: TraceClient | undefined;
export function traceClient(): TraceClient {
  if (!shared) shared = new TraceClient();
  return shared;
}
