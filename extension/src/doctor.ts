import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getMetaAiConfig } from './agent';
import { atlasBinary, atlasDir, run, toolsProject, tracerBinary, which, workspaceRoot } from './util';

export type CheckStatus = 'ok' | 'warn' | 'missing';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: { label: string; command: string };
}

export interface DoctorReport {
  checks: Check[];
  agent?: string;
  ok: boolean;
}

export const AGENTS: { id: string; bin: string; label: string }[] = [
  { id: 'pi', bin: 'pi', label: 'pi (pi.dev)' },
  { id: 'claude', bin: 'claude', label: 'Claude Code' },
  { id: 'codex', bin: 'codex', label: 'Codex CLI' },
  { id: 'opencode', bin: 'opencode', label: 'OpenCode' },
];

/** Check every piece Graspt glues together: Lean extension, toolchain, Mathlib, tooling, atlas, agents. */
export async function runDoctor(): Promise<DoctorReport> {
  const checks: Check[] = [];

  // 1. The official Lean 4 VS Code extension (LSP, infoview, diagnostics)
  const leanExt = vscode.extensions.getExtension('leanprover.lean4');
  checks.push(
    leanExt
      ? {
          id: 'lean4-ext',
          label: 'Lean 4 VS Code extension',
          status: 'ok',
          detail: `leanprover.lean4 v${leanExt.packageJSON.version}${leanExt.isActive ? ' (active)' : ' (installed, activates on .lean files)'}`,
        }
      : {
          id: 'lean4-ext',
          label: 'Lean 4 VS Code extension',
          status: 'missing',
          detail: 'leanprover.lean4 is not installed — Graspt uses it for the editor-side LSP experience.',
          fix: { label: 'Install', command: 'workbench.extensions.installExtension:leanprover.lean4' },
        },
  );

  // 2. elan / lake / lean
  const lake = await which('lake');
  const elan = await which('elan');
  if (lake) {
    const v = await run(lake, ['--version'], { timeoutMs: 20000, cwd: toolsProject() });
    checks.push({ id: 'lake', label: 'Lean toolchain (elan + lake)', status: 'ok', detail: `${v.stdout.trim().split('\n')[0]}${elan ? '' : ' — elan not found'}` });
  } else {
    checks.push({
      id: 'lake',
      label: 'Lean toolchain (elan + lake)',
      status: 'missing',
      detail: 'lake not found on PATH or in ~/.elan/bin.',
      fix: { label: 'How to install', command: 'vscode.open:https://lean-lang.org/install/' },
    });
  }

  // 3. Tools project + Mathlib
  const proj = toolsProject();
  if (!proj) {
    checks.push({ id: 'project', label: 'Graspt Lean project', status: 'missing', detail: 'No lakefile found (expected <workspace>/lean). Set graspt.toolsProject.' });
  } else {
    const toolchain = readMaybe(path.join(proj, 'lean-toolchain'))?.trim() ?? '?';
    checks.push({ id: 'project', label: 'Graspt Lean project', status: 'ok', detail: `${path.relative(workspaceRoot() ?? '', proj) || '.'} (${toolchain})` });
    const manifest = readMaybe(path.join(proj, 'lake-manifest.json'));
    const hasMathlibDep = !!manifest && /"name":\s*"mathlib"/.test(manifest);
    const mathlibBuild = path.join(proj, '.lake', 'packages', 'mathlib', '.lake', 'build', 'lib');
    const cached = fs.existsSync(mathlibBuild);
    let rev = '';
    if (manifest) {
      try {
        const m = JSON.parse(manifest);
        rev = (m.packages ?? []).find((p: any) => p.name === 'mathlib')?.rev?.slice(0, 10) ?? '';
      } catch {
        /* ignore */
      }
    }
    checks.push(
      !hasMathlibDep
        ? { id: 'mathlib', label: 'Mathlib', status: 'missing', detail: 'mathlib is not a dependency in lake-manifest.json (run `lake update`).' }
        : cached
          ? { id: 'mathlib', label: 'Mathlib', status: 'ok', detail: `mathlib @ ${rev} — compiled cache present` }
          : { id: 'mathlib', label: 'Mathlib', status: 'warn', detail: `mathlib @ ${rev} — no compiled cache yet`, fix: { label: 'lake exe cache get', command: 'graspt.terminal:lake exe cache get' } },
    );

    // 4. Graspt tooling binaries
    const tr = fs.existsSync(tracerBinary(proj));
    const at = fs.existsSync(atlasBinary(proj));
    checks.push({
      id: 'tooling',
      label: 'Graspt Lean tooling',
      status: tr && at ? 'ok' : tr ? 'warn' : 'missing',
      detail: `graspt-trace ${tr ? '✓' : '✗'} · graspt-atlas ${at ? '✓' : '✗'}`,
      fix: tr && at ? undefined : { label: 'Build', command: 'graspt.buildTools' },
    });

    // 5. Atlas (pre-mapped Mathlib)
    const ad = atlasDir();
    const atlasFile = ad ? path.join(ad, 'atlas.json') : '';
    if (ad && fs.existsSync(atlasFile)) {
      let summary = '';
      try {
        const a = JSON.parse(fs.readFileSync(atlasFile, 'utf8'));
        summary = `${a.declarations} declarations · ${a.areas.length} areas · ${a.landmarks.length} landmarks`;
      } catch {
        summary = 'unreadable';
      }
      checks.push({ id: 'atlas', label: 'Mathlib atlas (pre-map)', status: 'ok', detail: summary });
    } else {
      checks.push({ id: 'atlas', label: 'Mathlib atlas (pre-map)', status: 'warn', detail: 'Not built yet — landmarks fall back to explicitly named constants.', fix: { label: 'Build atlas', command: 'graspt.buildAtlas' } });
    }
  }

  // 6. Meta AI (Muse models in `pi`) + CLI Agents
  const meta = getMetaAiConfig();
  if (meta.apiKey) {
    const masked = meta.apiKey.length > 8 ? `${meta.apiKey.slice(0, 4)}…${meta.apiKey.slice(-4)}` : '••••';
    checks.push({
      id: 'meta-ai',
      label: 'Meta Muse in pi (META_API_KEY)',
      status: 'ok',
      detail: `Key configured (${masked}) · pi --model meta/${meta.model}`,
      fix: { label: 'Change Key / Muse Model', command: 'graspt.setMetaApiKey' },
    });
  } else {
    checks.push({
      id: 'meta-ai',
      label: 'Meta Muse in pi (META_API_KEY)',
      status: 'warn',
      detail: `No META_API_KEY set for pi (target: meta/${meta.model}). Click to enter your key.`,
      fix: { label: '🔑 Enter Meta Muse Key', command: 'graspt.setMetaApiKey' },
    });
  }

  let agent: string | undefined = meta.apiKey ? `pi (meta/${meta.model})` : undefined;
  const found: string[] = meta.apiKey ? [`pi + meta/${meta.model}`] : [];
  for (const a of AGENTS) {
    const p = await which(a.bin);
    if (p) {
      found.push(a.label);
      agent ??= a.id;
    }
  }
  const pi = await which('pi');
  if (pi) {
    const v = await run(pi, ['--version'], { timeoutMs: 10000 });
    checks.push({
      id: 'pi',
      label: 'pi coding agent (pi.dev)',
      status: 'ok',
      detail: `pi ${v.stdout.trim()} · provider: meta (${meta.model})${meta.apiKey ? ' ✓ authenticated' : ' (awaiting META_API_KEY)'}`,
    });
  } else {
    checks.push({ id: 'pi', label: 'pi coding agent (pi.dev)', status: 'warn', detail: 'pi not installed', fix: { label: 'npm i -g', command: 'graspt.terminal:npm install -g --ignore-scripts @earendil-works/pi-coding-agent' } });
  }
  checks.push({
    id: 'agents',
    label: 'Agents available',
    status: found.length ? 'ok' : 'warn',
    detail: found.length ? found.join(', ') : 'No agent CLI found — Graspt will still run its built-in tactic sweep.',
  });

  // 7. git (for worktree branches)
  const ws = workspaceRoot();
  const git = ws ? await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ws, timeoutMs: 5000 }) : undefined;
  checks.push({
    id: 'git',
    label: 'git worktrees',
    status: git?.stdout.trim() === 'true' ? 'ok' : 'warn',
    detail: git?.stdout.trim() === 'true' ? 'workspace is a git repo — branches can be materialised as worktrees' : 'not a git repo — falling back to scratch files',
  });

  return { checks, agent, ok: checks.every((c) => c.status !== 'missing') };
}

function readMaybe(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}
