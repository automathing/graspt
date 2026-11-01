import * as fs from 'fs';
import * as path from 'path';
import { Candidate } from './agent';
import { isSorryStep } from './model';
import { TracePool } from './tracer';
import { Step, TraceResult } from './types';
import { run, workspaceRoot } from './util';

export interface VerifiedBranch {
  idx: number;
  candidate: Candidate;
  worktreePath?: string;
  branchName?: string;
  feasible: boolean;
  closesGoal: boolean;
  remainingGoals: string[];
  errorText?: string;
  elapsedMs: number;
}

/**
 * Replaces the `sorry` step at `sorryStep` in `sourceText` with `candidateTactic`
 * (preserving indentation for multi-line tactic blocks).
 */
export function spliceCandidateAtStep(sourceText: string, step: Step, candidateTactic: string): string {
  const lines = sourceText.split('\n');
  const lineIdx = step.startLine - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return sourceText;
  const line = lines[lineIdx];
  const indentMatch = line.match(/^(\s*(?:·\s*)?)/);
  const baseIndent = indentMatch ? indentMatch[1] : '';
  const contIndent = ' '.repeat(baseIndent.length);

  const tacticLines = candidateTactic
    .split('\n')
    .map((l, i) => (i === 0 ? l.trim() : contIndent + l.trim()))
    .join('\n');

  if (step.startLine === step.endLine) {
    const before = line.slice(0, step.startCol);
    const after = line.slice(step.endCol);
    lines[lineIdx] = before + tacticLines + after;
  } else {
    const firstBefore = lines[step.startLine - 1].slice(0, step.startCol);
    const lastAfter = lines[step.endLine - 1].slice(step.endCol);
    lines.splice(step.startLine - 1, step.endLine - step.startLine + 1, firstBefore + tacticLines + lastAfter);
  }
  return lines.join('\n');
}

/**
 * Materialise a git worktree under `.graspt/worktrees/branch-k` and symlink `.lake`
 * so external CLI agents (`pi`, Claude Code, Codex, OpenCode) and humans can inspect
 * the candidate branch on disk with zero `.olean` duplication.
 */
export async function ensureBranchWorktree(
  lakeRoot: string,
  relFilePath: string,
  branchIdx: number,
  modifiedContent: string,
): Promise<{ worktreePath?: string; branchName?: string }> {
  const ws = workspaceRoot() ?? lakeRoot;
  const wtRoot = path.join(ws, '.graspt', 'worktrees');
  const wtDir = path.join(wtRoot, `branch-${branchIdx}`);
  const branchName = `graspt/lookahead-${branchIdx}`;
  try {
    fs.mkdirSync(wtRoot, { recursive: true });
    if (!fs.existsSync(wtDir)) {
      await run('git', ['worktree', 'add', '--detach', '-f', wtDir, 'HEAD'], { cwd: ws, timeoutMs: 8000 });
    }
    // Critical optimization: symlink `.lake` from the main Lake project into the worktree
    const relLakeRoot = path.relative(ws, lakeRoot);
    const wtLakeRoot = relLakeRoot ? path.join(wtDir, relLakeRoot) : wtDir;
    const mainLake = path.join(lakeRoot, '.lake');
    const targetLake = path.join(wtLakeRoot, '.lake');
    if (fs.existsSync(mainLake) && !fs.existsSync(targetLake)) {
      fs.mkdirSync(wtLakeRoot, { recursive: true });
      fs.symlinkSync(mainLake, targetLake, 'dir');
    }
    const targetFile = path.join(wtDir, path.relative(ws, path.join(lakeRoot, relFilePath)));
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, modifiedContent, 'utf8');
    return { worktreePath: wtDir, branchName };
  } catch {
    return {};
  }
}

/**
 * Verify a list of candidate branches in parallel against the `TracePool` (and optionally
 * materialise them in `.graspt/worktrees` with symlinked `.lake`).
 */
export async function verifyCandidatesParallel(opts: {
  file: string;
  lakeRoot: string;
  sourceText: string;
  declName: string;
  frontierStep: Step;
  candidates: Candidate[];
  pool: TracePool;
  useWorktrees: boolean;
}): Promise<VerifiedBranch[]> {
  const { file, lakeRoot, sourceText, declName, frontierStep, candidates, pool, useWorktrees } = opts;
  const relFile = path.relative(lakeRoot, file);

  const countSorries = (steps: Step[]) => steps.filter(isSorryStep).length;

  const tasks = candidates.map(async (candidate, idx): Promise<VerifiedBranch> => {
    const t0 = Date.now();
    const spliced = spliceCandidateAtStep(sourceText, frontierStep, candidate.tactic);
    let wt: { worktreePath?: string; branchName?: string } = {};
    if (useWorktrees) {
      wt = await ensureBranchWorktree(lakeRoot, relFile, idx + 1, spliced);
    }
    let trace: TraceResult;
    try {
      trace = await pool.get().trace(file, spliced);
    } catch (e) {
      return {
        idx,
        candidate,
        ...wt,
        feasible: false,
        closesGoal: false,
        remainingGoals: [],
        errorText: String(e),
        elapsedMs: Date.now() - t0,
      };
    }

    const decl = trace.decls.find((d) => d.name === declName) ?? trace.decls[0];
    const declStart = decl?.startLine ?? frontierStep.startLine;
    const declEnd = decl?.endLine ?? frontierStep.endLine + 10;
    const errors = (trace.messages ?? []).filter(
      (m) => m.severity === 'error' && m.line >= declStart && m.line <= declEnd + 4,
    );

    if (errors.length > 0 || !decl) {
      return {
        idx,
        candidate,
        ...wt,
        feasible: false,
        closesGoal: false,
        remainingGoals: [],
        errorText: errors[0]?.text ?? trace.error ?? 'tactic failed',
        elapsedMs: Date.now() - t0,
      };
    }

    // Compare open goals / sorries inside this declaration before and after
    const sorriesAfter = countSorries(decl.steps);
    const goalMap = new Map(decl.goals.map((g) => [g.id, g.target]));
    const consumed = new Set(decl.steps.filter((s) => !isSorryStep(s)).map((s) => s.before[0]));
    const openGoals: string[] = [];
    for (const s of decl.steps) {
      if (isSorryStep(s) && s.before[0]) {
        const tgt = goalMap.get(s.before[0]);
        if (tgt) openGoals.push(tgt);
      }
      for (const a of s.after) {
        if (!consumed.has(a)) {
          const tgt = goalMap.get(a);
          if (tgt && !openGoals.includes(tgt)) openGoals.push(tgt);
        }
      }
    }

    return {
      idx,
      candidate,
      ...wt,
      feasible: true,
      closesGoal: sorriesAfter === 0 && openGoals.length === 0,
      remainingGoals: openGoals.slice(0, 4),
      elapsedMs: Date.now() - t0,
    };
  });

  return Promise.all(tasks);
}
