import * as cp from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import { toolEnv, tracerBinary } from './util';
import type { TraceResult } from './types';

/**
 * A long-lived `lake env graspt-trace --server` process.
 *
 * The first request pays for elaborating the imports (e.g. Mathlib); later requests with
 * the same header reuse the cached environment, which is what keeps the map responsive.
 */
export class TraceServer {
  private proc?: cp.ChildProcess;
  private pending = new Map<number, { resolve: (r: TraceResult) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly lakeRoot: string,
    readonly toolsProject: string,
    private log: (s: string) => void,
  ) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const bin = tracerBinary(this.toolsProject);
    if (!fs.existsSync(bin)) {
      return Promise.reject(new Error(`graspt-trace not built (${bin}). Run "Graspt: Build Lean Tooling".`));
    }
    this.ready = new Promise((resolve, reject) => {
      // `lake env` gives the tracer the LEAN_PATH of the project the file lives in.
      const proc = cp.spawn('lake', ['env', bin, '--server'], { cwd: this.lakeRoot, env: toolEnv() });
      this.proc = proc;
      const rl = readline.createInterface({ input: proc.stdout! });
      let started = false;
      rl.on('line', (line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          this.log(`[trace] ${line}`);
          return;
        }
        if (msg.ready) {
          started = true;
          resolve();
          return;
        }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg as TraceResult);
        }
      });
      proc.stderr!.on('data', (d) => this.log(`[trace:stderr] ${d.toString().trimEnd()}`));
      proc.on('exit', (code) => {
        this.log(`[trace] server exited (${code})`);
        if (!started) reject(new Error(`graspt-trace exited with code ${code}`));
        for (const p of this.pending.values()) p.reject(new Error('trace server exited'));
        this.pending.clear();
        this.proc = undefined;
        this.ready = undefined;
      });
      proc.on('error', (e) => reject(e));
    });
    return this.ready;
  }

  /** Requests are serialised: one Lean environment, one elaboration at a time. */
  trace(file: string, content?: string): Promise<TraceResult> {
    const job = this.queue.then(async () => {
      await this.start();
      const id = this.nextId++;
      return new Promise<TraceResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.proc!.stdin!.write(JSON.stringify({ id, file, content }) + '\n');
      });
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  dispose() {
    this.proc?.kill();
    this.proc = undefined;
    this.ready = undefined;
  }
}

/** A small pool of trace servers for verifying candidate branches in parallel. */
export class TracePool {
  private servers: TraceServer[] = [];
  private rr = 0;
  constructor(
    private lakeRoot: string,
    private toolsProject: string,
    private size: number,
    private log: (s: string) => void,
  ) {}

  get(): TraceServer {
    if (this.servers.length < this.size) {
      const s = new TraceServer(this.lakeRoot, this.toolsProject, this.log);
      this.servers.push(s);
      return s;
    }
    const s = this.servers[this.rr % this.servers.length];
    this.rr++;
    return s;
  }

  dispose() {
    for (const s of this.servers) s.dispose();
    this.servers = [];
  }
}
