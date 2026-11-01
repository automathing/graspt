import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  askAgent,
  Candidate,
  chatPrompt,
  explorePrompt,
  getMetaAiConfig,
  Position,
  setRuntimeMetaApiKey,
  sweepCandidates,
} from './agent';
import { DoctorReport, runDoctor } from './doctor';
import { buildProofMap, declAtLine, interiorGoals, isSorryStep } from './model';
import { TracePool, TraceServer } from './tracer';
import { Atlas, DeclTrace, Importance, ProofMap, Step, TraceResult } from './types';
import { atlasDir, findLakeRoot, grasptStateDir, run, toolsProject, workspaceRoot } from './util';
import { spliceCandidateAtStep, VerifiedBranch, verifyCandidatesParallel } from './worktree';

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Graspt');
  const log = (s: string) => out.appendLine(s);

  const controller = new GrasptController(context, log);

  context.subscriptions.push(
    out,
    controller,
    vscode.commands.registerCommand('graspt.openMap', () => controller.openPanel(false)),
    vscode.commands.registerCommand('graspt.openMapWindow', () => controller.openPanel(true)),
    vscode.commands.registerCommand('graspt.setMetaApiKey', () => controller.promptMetaApiKey()),
    vscode.commands.registerCommand('graspt.doctor', () => controller.showDoctor()),
    vscode.commands.registerCommand('graspt.buildTools', () => controller.buildTools()),
    vscode.commands.registerCommand('graspt.buildAtlas', () => controller.buildAtlas()),
    vscode.commands.registerCommand('graspt.refresh', () => controller.traceActiveEditor(true)),
    vscode.commands.registerCommand('graspt.exploreAtCursor', () => controller.exploreFrontier()),
    vscode.window.onDidChangeActiveTextEditor((ed) => controller.onActiveEditorChanged(ed)),
    vscode.window.onDidChangeTextEditorSelection((ev) => controller.onSelectionChanged(ev)),
    vscode.workspace.onDidSaveTextDocument((doc) => controller.onDocumentSaved(doc)),
  );
}

export function deactivate() {}

class GrasptController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private servers = new Map<string, TraceServer>();
  private pools = new Map<string, TracePool>();
  private currentFile?: string;
  private currentSource = '';
  private currentTrace?: TraceResult;
  private currentDecl?: string;
  private currentLine = 1;
  private level: 1 | 2 | 3 = 2;
  private pinned = new Set<string>();
  private chunked = new Set<string>();
  private ghostBranches = new Map<string, VerifiedBranch[]>();
  private importance?: Importance | null;
  private atlas?: Atlas | null;
  private lastDoctor?: DoctorReport;
  private focusChatMode = false;

  constructor(
    private context: vscode.ExtensionContext,
    private log: (s: string) => void,
  ) {
    this.level = (vscode.workspace.getConfiguration('graspt').get<number>('level') ?? 2) as 1 | 2 | 3;
    this.loadAtlasFromDisk();
    this.context.secrets.get('graspt.metaApiKey').then((k) => {
      if (k) setRuntimeMetaApiKey(k, getMetaAiConfig().model);
    });
  }

  async promptMetaApiKey() {
    const current = getMetaAiConfig();
    const key = await vscode.window.showInputBox({
      title: 'Graspt — Set Meta AI (Muse) API Key for pi',
      prompt: `Enter your META_API_KEY (configures ~/.pi/agent/auth.json for pi --model meta/${current.model})`,
      password: true,
      placeHolder: 'META_API_KEY …',
      ignoreFocusOut: true,
    });
    if (key === undefined) return; // cancelled
    await this.saveMetaApiKey(key.trim(), current.model);
  }

  private async saveMetaApiKey(key: string, model?: string) {
    const chosenModel = model || getMetaAiConfig().model;
    setRuntimeMetaApiKey(key, chosenModel);
    if (key) {
      await this.context.secrets.store('graspt.metaApiKey', key);
    } else {
      await this.context.secrets.delete('graspt.metaApiKey');
    }
    const cfg = vscode.workspace.getConfiguration('graspt');
    if (model) await cfg.update('metaAi.model', model, vscode.ConfigurationTarget.Global);

    this.lastDoctor = await runDoctor();
    this.post({
      type: 'doctor',
      report: this.lastDoctor,
      metaConfig: { hasKey: !!getMetaAiConfig().apiKey, model: getMetaAiConfig().model },
    });
    vscode.window.showInformationMessage(
      key
        ? `Graspt: Meta API key saved for pi (--model meta/${getMetaAiConfig().model}).`
        : 'Graspt: Meta API key cleared.',
    );
  }

  dispose() {
    for (const s of this.servers.values()) s.dispose();
    for (const p of this.pools.values()) p.dispose();
    this.panel?.dispose();
  }

  private loadAtlasFromDisk() {
    const dir = atlasDir();
    if (!dir) return;
    try {
      const impPath = path.join(dir, 'importance.json');
      if (fs.existsSync(impPath)) {
        this.importance = JSON.parse(fs.readFileSync(impPath, 'utf8')) as Importance;
      }
      const atPath = path.join(dir, 'atlas.json');
      if (fs.existsSync(atPath)) {
        this.atlas = JSON.parse(fs.readFileSync(atPath, 'utf8')) as Atlas;
      }
    } catch (e) {
      this.log(`[atlas] load error: ${e}`);
    }
  }

  private getServer(lakeRoot: string): TraceServer | undefined {
    const tp = toolsProject();
    if (!tp) return undefined;
    let s = this.servers.get(lakeRoot);
    if (!s) {
      s = new TraceServer(lakeRoot, tp, this.log);
      this.servers.set(lakeRoot, s);
    }
    return s;
  }

  private getPool(lakeRoot: string): TracePool | undefined {
    const tp = toolsProject();
    if (!tp) return undefined;
    let p = this.pools.get(lakeRoot);
    if (!p) {
      const size = vscode.workspace.getConfiguration('graspt').get<number>('lookahead.parallelism') ?? 2;
      p = new TracePool(lakeRoot, tp, Math.max(1, size), this.log);
      this.pools.set(lakeRoot, p);
    }
    return p;
  }

  async openPanel(windowMode: boolean) {
    this.focusChatMode = windowMode;
    if (this.panel) {
      this.panel.reveal(windowMode ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'graspt.map',
        windowMode ? 'Graspt — Map + Agent Window' : 'Graspt — Allocentric Proof Map',
        windowMode ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
        },
      );
      this.panel.webview.html = this.renderHtml(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((msg) => this.onWebviewMessage(msg));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    if (windowMode) {
      try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      } catch {
        // Fallback gracefully if host environment doesn't support floating windows
      }
    }

    this.lastDoctor = await runDoctor();
    this.post({ type: 'doctor', report: this.lastDoctor, mode: this.focusChatMode ? 'window' : 'split' });
    if (this.atlas) this.post({ type: 'atlas', atlas: this.atlas });
    await this.traceActiveEditor(false);
  }

  private post(msg: unknown) {
    this.panel?.webview.postMessage(msg);
  }

  async onActiveEditorChanged(ed?: vscode.TextEditor) {
    if (!this.panel || !ed || !ed.document.fileName.endsWith('.lean')) return;
    if (ed.document.fileName !== this.currentFile) {
      await this.traceDocument(ed.document);
    }
  }

  onSelectionChanged(ev: vscode.TextEditorSelectionChangeEvent) {
    if (!this.panel || !ev.textEditor.document.fileName.endsWith('.lean')) return;
    const line = ev.selections[0]?.active.line + 1;
    if (!line || line === this.currentLine) return;
    this.currentLine = line;
    if (this.currentTrace) {
      const d = declAtLine(this.currentTrace.decls, line);
      if (d && d.name !== this.currentDecl) {
        this.currentDecl = d.name;
        this.sendProofMap();
      }
      this.post({ type: 'cursorLine', line });
    }
  }

  async onDocumentSaved(doc: vscode.TextDocument) {
    if (!this.panel || !doc.fileName.endsWith('.lean')) return;
    await this.traceDocument(doc);
  }

  async traceActiveEditor(force: boolean) {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.fileName.endsWith('.lean')) {
      this.currentLine = ed.selection.active.line + 1;
      await this.traceDocument(ed.document, force);
      return;
    }
    // If no active .lean editor, try opening the demo file
    const tp = toolsProject();
    if (tp) {
      const demo = path.join(tp, 'Demo', 'LocalLayout.lean');
      if (fs.existsSync(demo)) {
        const doc = await vscode.workspace.openTextDocument(demo);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, true);
        await this.traceDocument(doc, force);
      }
    }
  }

  private async traceDocument(doc: vscode.TextDocument, _force = false) {
    const file = doc.fileName;
    const lakeRoot = findLakeRoot(file) ?? toolsProject();
    if (!lakeRoot) {
      this.post({ type: 'status', text: 'No lakefile.lean found for this file.' });
      return;
    }
    const srv = this.getServer(lakeRoot);
    if (!srv) return;
    this.currentFile = file;
    this.currentSource = doc.getText();
    this.post({ type: 'status', text: `Tracing ${path.basename(file)} …`, busy: true });
    try {
      const trace = await srv.trace(file, this.currentSource);
      this.currentTrace = trace;
      const d = declAtLine(trace.decls, this.currentLine);
      this.currentDecl = d?.name;
      this.persistStateSnapshot(trace);
      this.sendProofMap();
      this.post({
        type: 'status',
        text: `Traced ${path.basename(file)} in ${trace.elapsedMs} ms${trace.headerCached ? ' (cached header)' : ''}`,
        busy: false,
      });
    } catch (e) {
      this.post({ type: 'status', text: `Trace error: ${e}`, busy: false });
    }
  }

  private persistStateSnapshot(trace: TraceResult) {
    const dir = grasptStateDir();
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(trace, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }

  private activeDecl(): DeclTrace | undefined {
    if (!this.currentTrace) return undefined;
    return (
      this.currentTrace.decls.find((d) => d.name === this.currentDecl) ??
      declAtLine(this.currentTrace.decls, this.currentLine)
    );
  }

  private sendProofMap() {
    const decl = this.activeDecl();
    if (!decl || !this.currentTrace) return;
    const threshold = vscode.workspace.getConfiguration('graspt').get<number>('landmarkThreshold') ?? 30;
    const localNames = new Set(this.currentTrace.decls.map((d) => d.name));
    const map: ProofMap = buildProofMap(decl, {
      level: this.level,
      importance: this.importance,
      landmarkThreshold: threshold,
      pinned: this.pinned,
      chunked: this.chunked,
      localNames,
    });

    // Attach any verified ghost branches for frontier nodes in this declaration
    for (const [frontierGoalId, branches] of this.ghostBranches.entries()) {
      const srcId = `g:${frontierGoalId}`;
      if (!map.nodes.some((n) => n.id === srcId)) continue;
      for (const b of branches) {
        if (!b.feasible) continue;
        const gmvId = `ghost:mv:${frontierGoalId}:${b.idx}`;
        map.nodes.push({
          id: gmvId,
          kind: 'ghost-move',
          label: `✦ ${b.candidate.tactic.split('\n')[0]}`,
          detail: `${b.candidate.tactic}${b.candidate.rationale ? `\n— ${b.candidate.rationale}` : ''}\n(${b.elapsedMs} ms${b.worktreePath ? ` · ${path.basename(b.worktreePath)}` : ''})`,
          sorryStep: b.idx,
        });
        map.edges.push({ id: `e:${srcId}->${gmvId}`, source: srcId, target: gmvId, kind: 'ghost' });
        if (b.closesGoal) {
          if (!map.nodes.some((n) => n.id === 'known')) {
            map.nodes.push({ id: 'known', kind: 'known', label: 'grounded in the known' });
          }
          map.edges.push({ id: `e:${gmvId}->known`, source: gmvId, target: 'known', kind: 'ghost' });
        } else {
          const ggId = `ghost:g:${frontierGoalId}:${b.idx}`;
          map.nodes.push({
            id: ggId,
            kind: 'ghost-goal',
            label: b.remainingGoals[0] ?? 'subgoal',
            detail: b.remainingGoals.join('\n\n'),
          });
          map.edges.push({ id: `e:${gmvId}->${ggId}`, source: gmvId, target: ggId, kind: 'ghost' });
        }
      }
    }

    this.post({
      type: 'proofMap',
      map,
      decls: this.currentTrace.decls.map((d) => ({
        name: d.name,
        complete: !d.steps.some(isSorryStep),
      })),
      cursorLine: this.currentLine,
    });
  }

  private async onWebviewMessage(msg: any) {
    switch (msg.type) {
      case 'ready': {
        this.lastDoctor = await runDoctor();
        const mc = getMetaAiConfig();
        this.post({
          type: 'doctor',
          report: this.lastDoctor,
          mode: this.focusChatMode ? 'window' : 'split',
          metaConfig: { hasKey: !!mc.apiKey, model: mc.model },
        });
        if (this.atlas) this.post({ type: 'atlas', atlas: this.atlas });
        await this.traceActiveEditor(false);
        break;
      }
      case 'saveMetaKey': {
        await this.saveMetaApiKey(String(msg.key ?? '').trim(), msg.model);
        break;
      }
      case 'promptMetaKey': {
        await this.promptMetaApiKey();
        break;
      }
      case 'setLevel': {
        this.level = msg.level as 1 | 2 | 3;
        this.pinned.clear();
        this.chunked.clear();
        this.sendProofMap();
        break;
      }
      case 'selectDecl': {
        this.currentDecl = msg.name;
        this.sendProofMap();
        const d = this.activeDecl();
        if (d && this.currentFile) this.revealRange(this.currentFile, d.startLine, 0);
        break;
      }
      case 'revealRange': {
        if (this.currentFile && msg.range) {
          this.revealRange(this.currentFile, msg.range.startLine, msg.range.startCol);
        }
        break;
      }
      case 'unpackMove': {
        const d = this.activeDecl();
        if (!d || !Array.isArray(msg.steps)) break;
        for (const g of interiorGoals(d, msg.steps)) {
          this.pinned.add(g);
          this.chunked.delete(g);
        }
        this.sendProofMap();
        break;
      }
      case 'chunkGoal': {
        const gid = String(msg.goalId ?? '').replace(/^g:/, '');
        if (gid) {
          this.chunked.add(gid);
          this.pinned.delete(gid);
          this.sendProofMap();
        }
        break;
      }
      case 'exploreFrontier': {
        await this.exploreFrontier(msg.goalId, msg.selectedLandmarks ?? [], msg.userHint);
        break;
      }
      case 'applyGhostBranch': {
        await this.applyGhostBranch(msg.frontierGoalId, msg.branchIdx);
        break;
      }
      case 'chat': {
        await this.handleAgentChat(msg.text, msg.goalId, msg.selectedLandmarks ?? []);
        break;
      }
      case 'runFix': {
        await this.runDoctorFix(msg.command);
        break;
      }
      case 'refreshDoctor': {
        this.lastDoctor = await runDoctor();
        this.post({ type: 'doctor', report: this.lastDoctor, mode: this.focusChatMode ? 'window' : 'split' });
        break;
      }
    }
  }

  private async revealRange(file: string, line1: number, col: number) {
    const doc = await vscode.workspace.openTextDocument(file);
    const pos = new vscode.Position(Math.max(0, line1 - 1), Math.max(0, col));
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
      selection: new vscode.Range(pos, pos),
    });
  }

  private buildPositionContext(decl: DeclTrace, frontierStep: Step, selectedLandmarks: string[]): Position {
    const goalId = frontierStep.before[0];
    const goalView = decl.goals.find((g) => g.id === goalId);
    const trail = decl.steps
      .filter((s) => s.idx < frontierStep.idx && !isSorryStep(s))
      .slice(-8)
      .map((s) => s.tactic);
    const landmarks = [...new Set(decl.steps.flatMap((s) => s.constants))].slice(0, 12);
    const lines = this.currentSource.split('\n');
    const excerpt = lines.slice(Math.max(0, decl.startLine - 1), Math.min(lines.length, decl.endLine + 2)).join('\n');
    return {
      declName: decl.name,
      goal: goalView?.pp ?? goalView?.target ?? '?',
      trail,
      landmarks,
      selected: selectedLandmarks,
      fileExcerpt: excerpt,
    };
  }

  async exploreFrontier(rawGoalId?: string, selectedLandmarks: string[] = [], userHint?: string) {
    const decl = this.activeDecl();
    if (!decl || !this.currentFile) return;
    const goalId = rawGoalId ? rawGoalId.replace(/^g:/, '') : undefined;
    const sorrySteps = decl.steps.filter(isSorryStep);
    const frontierStep =
      (goalId ? sorrySteps.find((s) => s.before[0] === goalId) : undefined) ?? sorrySteps[0];
    if (!frontierStep) {
      this.post({ type: 'chatReply', agent: 'graspt', text: 'All branches in this theorem are already grounded in the known (no frontier `sorry`).' });
      return;
    }
    const fGoalId = frontierStep.before[0];
    const lakeRoot = findLakeRoot(this.currentFile) ?? toolsProject();
    if (!lakeRoot) return;
    const pool = this.getPool(lakeRoot);
    if (!pool) return;

    this.post({
      type: 'status',
      text: `Exploring frontier ${fGoalId} in parallel worktrees …`,
      busy: true,
    });

    const pos = this.buildPositionContext(decl, frontierStep, selectedLandmarks);
    const prompt = userHint
      ? `${explorePrompt(pos, 4)}\nAdditional guidance from human: ${userHint}`
      : explorePrompt(pos, 4);

    // 1. Ask configured CLI agent (`pi`, `claude`, `codex`, `opencode`) if available + deterministic sweep
    const agentReply = await askAgent(prompt);
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const c of [...agentReply.candidates, ...sweepCandidates(selectedLandmarks)]) {
      const k = c.tactic.trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      candidates.push(c);
      if (candidates.length >= 6) break;
    }

    const useWorktrees = vscode.workspace.getConfiguration('graspt').get<boolean>('lookahead.useWorktrees') ?? true;
    const verified = await verifyCandidatesParallel({
      file: this.currentFile,
      lakeRoot,
      sourceText: this.currentSource,
      declName: decl.name,
      frontierStep,
      candidates,
      pool,
      useWorktrees,
    });

    this.ghostBranches.set(fGoalId, verified);
    this.sendProofMap();

    const feasible = verified.filter((v) => v.feasible);
    const summary = feasible.length
      ? `Found ${feasible.length}/${verified.length} feasible branch(es) at frontier (${feasible.filter((v) => v.closesGoal).length} close the goal). Click a ghost branch on the map to commit it.`
      : `Tested ${verified.length} candidate branch(es); none passed Lean verification yet.`;
    this.post({
      type: 'exploreResult',
      frontierGoalId: fGoalId,
      agent: agentReply.agent,
      branches: verified,
      summary,
    });
    this.post({ type: 'status', text: summary, busy: false });
  }

  private async applyGhostBranch(frontierGoalId: string, branchIdx: number) {
    const decl = this.activeDecl();
    if (!decl || !this.currentFile) return;
    const branches = this.ghostBranches.get(frontierGoalId);
    const b = branches?.find((x) => x.idx === branchIdx);
    const step = decl.steps.find((s) => isSorryStep(s) && s.before[0] === frontierGoalId);
    if (!b || !step) return;

    const doc = await vscode.workspace.openTextDocument(this.currentFile);
    const newText = spliceCandidateAtStep(doc.getText(), step, b.candidate.tactic);
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    this.ghostBranches.delete(frontierGoalId);
    await this.traceDocument(doc, true);
  }

  private async handleAgentChat(question: string, rawGoalId?: string, selectedLandmarks: string[] = []) {
    const decl = this.activeDecl();
    if (!decl) return;
    const goalId = rawGoalId ? rawGoalId.replace(/^g:/, '') : undefined;
    const step =
      (goalId ? decl.steps.find((s) => s.before[0] === goalId) : undefined) ??
      decl.steps.find(isSorryStep) ??
      decl.steps[0];
    if (!step) return;
    this.post({ type: 'status', text: 'Asking agent …', busy: true });
    const pos = this.buildPositionContext(decl, step, selectedLandmarks);
    const reply = await askAgent(chatPrompt(pos, question));
    this.post({
      type: 'chatReply',
      agent: reply.agent,
      text: reply.error ? `${reply.text ? reply.text + '\n' : ''}(${reply.error})` : reply.text,
      candidates: reply.candidates,
    });
    if (reply.candidates.length > 0 && isSorryStep(step) && this.currentFile) {
      const lakeRoot = findLakeRoot(this.currentFile) ?? toolsProject();
      const pool = lakeRoot ? this.getPool(lakeRoot) : undefined;
      if (lakeRoot && pool) {
        const verified = await verifyCandidatesParallel({
          file: this.currentFile,
          lakeRoot,
          sourceText: this.currentSource,
          declName: decl.name,
          frontierStep: step,
          candidates: reply.candidates,
          pool,
          useWorktrees: true,
        });
        this.ghostBranches.set(step.before[0], verified);
        this.sendProofMap();
      }
    }
    this.post({ type: 'status', text: 'Ready', busy: false });
  }

  private async runDoctorFix(cmd: string) {
    if (cmd.startsWith('workbench.extensions.installExtension:')) {
      const ext = cmd.split(':')[1];
      await vscode.commands.executeCommand('workbench.extensions.installExtension', ext);
    } else if (cmd.startsWith('vscode.open:')) {
      await vscode.env.openExternal(vscode.Uri.parse(cmd.slice('vscode.open:'.length)));
    } else if (cmd.startsWith('graspt.terminal:')) {
      const sh = cmd.slice('graspt.terminal:'.length);
      const t = vscode.window.createTerminal({ name: 'Graspt Setup', cwd: toolsProject() ?? workspaceRoot() });
      t.show();
      t.sendText(sh);
    } else {
      await vscode.commands.executeCommand(cmd);
    }
  }

  async showDoctor() {
    await this.openPanel(false);
    this.lastDoctor = await runDoctor();
    this.post({ type: 'doctor', report: this.lastDoctor, showModal: true });
  }

  async buildTools() {
    const tp = toolsProject();
    if (!tp) {
      vscode.window.showErrorMessage('No Graspt Lean project found.');
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Graspt: Building Lean tooling (graspt-trace, graspt-atlas) …' },
      async () => {
        const r = await run('lake', ['build', 'graspt-trace', 'graspt-atlas'], { cwd: tp, timeoutMs: 600000 });
        if (r.code === 0) {
          vscode.window.showInformationMessage('Graspt Lean tooling built.');
        } else {
          vscode.window.showErrorMessage(`Build failed: ${r.stderr.slice(-300)}`);
        }
      },
    );
    this.lastDoctor = await runDoctor();
    this.post({ type: 'doctor', report: this.lastDoctor });
  }

  async buildAtlas() {
    const tp = toolsProject();
    const ad = atlasDir();
    if (!tp || !ad) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Graspt: Pre-mapping Mathlib into Landmark Atlas …' },
      async () => {
        const r = await run('lake', ['exe', 'graspt-atlas', ad, 'Mathlib'], { cwd: tp, timeoutMs: 600000 });
        if (r.code === 0) {
          this.loadAtlasFromDisk();
          if (this.atlas) this.post({ type: 'atlas', atlas: this.atlas });
          this.sendProofMap();
          vscode.window.showInformationMessage('Graspt Mathlib Atlas built.');
        } else {
          vscode.window.showErrorMessage(`Atlas build failed: ${r.stderr.slice(-300)}`);
        }
      },
    );
    this.lastDoctor = await runDoctor();
    this.post({ type: 'doctor', report: this.lastDoctor });
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview.js')));
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Graspt — Allocentric Proof Map</title>
  <style>
    :root {
      --bg: #0b0f17;
      --panel: #131a26;
      --border: #233047;
      --text: #e5ecf6;
      --muted: #8b9bb4;
      --accent: #38bdf8;
      --gold: #f59e0b;
      --green: #10b981;
      --violet: #a855f7;
      --coral: #f43f5e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      height: 100vh; display: flex; flex-direction: column; overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 12px; background: var(--panel);
      border-bottom: 1px solid var(--border); flex-wrap: wrap;
    }
    .brand { font-weight: 700; letter-spacing: 0.4px; color: var(--accent); font-size: 13px; }
    select, button, input {
      background: #1a2436; color: var(--text);
      border: 1px solid var(--border); border-radius: 6px;
      padding: 4px 8px; font-size: 12px;
    }
    button { cursor: pointer; transition: border-color 0.15s, background 0.15s; }
    button:hover { border-color: var(--accent); background: #213049; }
    button.active { background: #1e3a5f; border-color: var(--accent); color: #fff; }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .seg button { border: none; border-radius: 0; padding: 4px 9px; }
    .spacer { flex: 1; }
    .status-pill { font-size: 11px; color: var(--muted); }
    .doctor-strip {
      display: none; padding: 8px 12px; background: #101722;
      border-bottom: 1px solid var(--border); font-size: 12px;
    }
    .doctor-strip.open { display: block; }
    .doctor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px; }
    .check-card {
      padding: 6px 8px; border-radius: 6px; background: #162030;
      border-left: 3px solid var(--muted);
    }
    .check-card.ok { border-left-color: var(--green); }
    .check-card.warn { border-left-color: var(--gold); }
    .check-card.missing { border-left-color: var(--coral); }
    .check-title { font-weight: 600; font-size: 11px; display: flex; justify-content: space-between; }
    .check-detail { font-size: 11px; color: var(--muted); margin-top: 2px; }
    main { flex: 1; position: relative; display: flex; overflow: hidden; }
    #cy { flex: 1; height: 100%; background: radial-gradient(circle at 50% 35%, #131c2b 0%, #0b0f17 75%); }
    #inspector {
      width: 300px; background: var(--panel); border-left: 1px solid var(--border);
      padding: 12px; overflow-y: auto; font-size: 12px; display: flex; flex-direction: column; gap: 10px;
    }
    .card {
      background: #172131; border: 1px solid var(--border); border-radius: 8px; padding: 9px;
    }
    .card h4 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
    pre {
      margin: 0; white-space: pre-wrap; word-break: break-word;
      font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 11px;
      color: #dbeafe; background: #0e1520; padding: 7px; border-radius: 6px;
    }
    .badge {
      display: inline-block; padding: 2px 6px; border-radius: 4px;
      font-size: 10px; font-weight: 600; margin-right: 4px;
    }
    .legend { display: flex; gap: 8px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
    .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 4px; }
    /* Minimalistic Floating Agent Chatbar */
    #chatbar {
      position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
      width: min(680px, calc(100% - 340px));
      background: rgba(19, 26, 38, 0.94); backdrop-filter: blur(10px);
      border: 1px solid #2e415f; border-radius: 10px;
      padding: 8px 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.55);
      display: flex; flex-direction: column; gap: 6px; z-index: 20;
    }
    #chat-reply {
      font-size: 11.5px; color: #cbd5e1; max-height: 110px; overflow-y: auto;
      display: none; border-bottom: 1px solid var(--border); padding-bottom: 6px;
      white-space: pre-wrap;
    }
    #chat-row { display: flex; gap: 6px; align-items: center; }
    #chat-input { flex: 1; background: #0e1520; border: 1px solid var(--border); padding: 6px 10px; }
  </style>
</head>
<body>
  <header>
    <span class="brand">◆ GRASPT</span>
    <div class="seg" title="Switch between Active Proof Map and Pre-mapped Mathlib Continent Atlas">
      <button id="tab-proof" class="active">Proof Map</button>
      <button id="tab-atlas">Mathlib Atlas</button>
    </div>
    <select id="decl-select" title="Theorem / Declaration"></select>
    <div class="seg" title="Adaptive Coarse-Graining Level (Tailored to Knowledge Level)">
      <button data-level="1">L1 Micro</button>
      <button data-level="2" class="active">L2 Meso</button>
      <button data-level="3">L3 Macro</button>
    </div>
    <button id="btn-explore" title="Spawn parallel worktree lookaheads at frontier">✦ Explore Frontier</button>
    <button id="btn-fit" title="Fit map to screen">Fit</button>
    <span class="spacer"></span>
    <span id="status-text" class="status-pill">Ready</span>
    <button id="btn-meta-key" title="Configure Meta AI (Muse) API Key for pi">🔑 Meta Muse Key</button>
    <button id="btn-doctor" title="Check Lean 4 Extension, Mathlib, Atlas, Meta Muse + pi.dev">Doctor</button>
  </header>

  <section id="meta-key-strip" class="doctor-strip">
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <strong style="color:#38bdf8;">🔑 Meta Muse in <code>pi</code>:</strong>
      <input id="meta-key-input" type="password" placeholder="Paste META_API_KEY for pi …" style="width:260px;" />
      <select id="meta-model-select" title="Meta Muse Model in pi (--model meta/...)">
        <option value="muse-spark-1.3">meta/muse-spark-1.3 (1M ctx)</option>
        <option value="muse-wonder-1.0">meta/muse-wonder-1.0 (1M ctx)</option>
        <option value="muse-spark-1.3-contributor">meta/muse-spark-1.3-contributor</option>
        <option value="muse-spark-1.2">meta/muse-spark-1.2</option>
        <option value="muse-spark-1.2-contributor">meta/muse-spark-1.2-contributor</option>
        <option value="muse-spark-1.1">meta/muse-spark-1.1</option>
      </select>
      <button id="btn-save-meta-key" style="border-color:#10b981;">Save to pi</button>
      <button id="btn-vscode-prompt-key" title="Open VS Code Secret Input Box">Use VS Code Prompt</button>
      <span id="meta-key-status" style="font-size:11px; color:var(--muted);"></span>
    </div>
  </section>

  <section id="doctor-strip" class="doctor-strip">
    <div id="doctor-grid" class="doctor-grid"></div>
  </section>

  <main>
    <div id="cy"></div>
    <aside id="inspector">
      <div class="card">
        <h4>Convex Hull Legend</h4>
        <div class="legend">
          <span><i class="dot" style="background:#38bdf8"></i>Theorem / Goal</span>
          <span><i class="dot" style="background:#a855f7"></i>Landmark (Mathlib)</span>
          <span><i class="dot" style="background:#f59e0b"></i>Frontier (sorry)</span>
          <span><i class="dot" style="background:#10b981"></i>Grounded in Known</span>
          <span><i class="dot" style="background:#22d3ee"></i>Ghost Lookahead</span>
        </div>
      </div>
      <div class="card" id="node-card">
        <h4 id="node-kind">Selected Node</h4>
        <div id="node-title" style="font-weight:600; margin-bottom:6px;">Click any landmark, goal, or move on the map</div>
        <pre id="node-detail">Select a node to inspect its Lean goal state, unpack coarse steps into micro-steps, or shift-click landmarks to combine them.</pre>
        <div id="node-actions" style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;"></div>
      </div>
      <div class="card" id="selected-landmarks-card" style="display:none;">
        <h4>Landmarks Selected to Combine</h4>
        <div id="selected-landmarks-list" style="margin-bottom:6px;"></div>
        <button id="btn-combine">✦ Combine at Frontier</button>
        <button id="btn-clear-lm">Clear</button>
      </div>
    </aside>

    <div id="chatbar">
      <div id="chat-reply"></div>
      <div id="chat-row">
        <span id="chat-context" class="badge" style="background:#1e3a5f; color:#93c5fd;">@frontier</span>
        <input id="chat-input" type="text" placeholder="Whisper to agent (pi / claude / codex): combine landmarks, unpack leap, or ask why …" />
        <button id="chat-send">Ask Agent ⏎</button>
      </div>
    </div>
  </main>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
