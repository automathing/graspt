import type { Repo } from './store';
import { allDeclNames, atlasFor, declTrace, proofMapFor } from './store';
import { neighbourhood } from '../../packages/core/nav';
import { validateCitations } from '../../packages/core/agent-guard';
import { metaStatus, askMeta, chatPrompt, type Candidate, type Position } from './meta';

export interface ChatReply {
  answer: string;
  verified: boolean;
  citations: string[];
  invalidCitations: string[];
  reason?: string;
  agent: string;
  candidates: Candidate[];
}

const NO_KEY_HINT = 'Paste your Meta API key (MODEL_API_KEY) in the box next to the chat — chat calls api.meta.ai directly, no agent install needed.';

function buildPosition(repo: Repo, declName: string, goalId?: string): { position: Position; valid: Set<string> } | undefined {
  const decl = declTrace(repo, declName);
  const map = proofMapFor(repo, declName);
  if (!decl || !map) return undefined;
  const nb = neighbourhood(decl, map, goalId);
  if (!nb) return undefined;
  const position: Position = {
    declName,
    goal: nb.centre.pp || nb.centre.target,
    goalNodeId: `g:${nb.centre.goalId}`,
    trail: nb.trail,
    landmarks: nb.neighbours.filter((n) => n.kind === 'landmark').map((n) => ({ name: n.label, nodeId: n.nodeId, area: n.area ?? 'Core', tacticSuggestion: n.tacticSuggestion })),
    neighbours: nb.neighbours.map((n) => `${n.relation} (node: ${n.nodeId}) ${n.label}`),
  };
  return { position, valid: new Set(map.nodes.map((n) => n.id)) };
}

/**
 * The chatbox is a conversation with Meta AI, called directly at
 * api.meta.ai/v1/responses (no pi or any other agent CLI in between).
 * The server supplies the DTT map context and validation:
 * - agent citations are checked against graph node ids (fabricated = flagged),
 * - tactic candidates are surfaced as unverified suggestions, never as proven,
 * - when no API key is saved, the reply says so plainly — there is no
 *   fake local answer impersonating Meta AI.
 */
export async function answerChat(repo: Repo, declName: string, goalId: string | undefined, question: string): Promise<ChatReply> {
  const status = metaStatus();
  if (!status.agent) {
    const where = declName ? `declaration ${declName}` : `the atlas of ${repo.name} (${allDeclNames(repo).join(', ')})`;
    return {
      answer: `No Meta API key saved, so I cannot chat yet.\n\nYou are looking at ${where}. ${NO_KEY_HINT}`,
      verified: false, citations: [], invalidCitations: [], reason: status.hint, agent: 'none', candidates: [],
    };
  }

  let position: Position;
  let valid = new Set<string>();
  if (!declName) {
    const atlas = atlasFor(repo);
    position = {
      declName: '(atlas — no declaration selected)',
      goal: `Atlas of ${repo.name}: ${atlas.declarations} declarations (${allDeclNames(repo).join(', ')}), ${atlas.landmarks.length} landmarks. No specific goal selected yet; answer at territory level and suggest which declaration to open.`,
      trail: [],
      landmarks: atlas.landmarks.slice(0, 10).map((l) => ({ name: l.name, nodeId: `lm:${l.name}`, area: l.area })),
      neighbours: [],
    };
    valid = new Set(atlas.landmarks.map((l) => `lm:${l.name}`));
  } else {
    const built = buildPosition(repo, declName, goalId);
    if (!built) {
      return { answer: `Unknown declaration ${declName} in this repo.`, verified: false, citations: [], invalidCitations: [], reason: 'unknown declaration', agent: status.agent, candidates: [] };
    }
    position = built.position; valid = built.valid;
  }

  const reply = await askMeta(chatPrompt(position, question));
  if (reply.error === 'NO_KEY') {
    return { answer: `No Meta API key saved, so I cannot chat yet.\n\n${NO_KEY_HINT}`, verified: false, citations: [], invalidCitations: [], reason: status.hint, agent: 'none', candidates: [] };
  }
  if (reply.error && !reply.text) {
    return { answer: `Meta AI (${reply.agent}) failed: ${reply.error}`, verified: false, citations: [], invalidCitations: [], reason: reply.error, agent: reply.agent, candidates: [] };
  }
  const guard = validateCitations(reply.text, valid);
  const reason = reply.error ?? (guard.invalidCitations.length ? `Meta AI cites unknown nodes: ${guard.invalidCitations.join(', ')}` : guard.citations.length === 0 ? 'Meta AI answer has no graph citations' : undefined);
  return {
    answer: reply.text,
    verified: guard.verified,
    citations: guard.citations,
    invalidCitations: guard.invalidCitations,
    reason,
    agent: reply.agent,
    candidates: reply.candidates,
  };
}

/** Scripted navigator walk: the actual elaborated tactic trail to a goal. Pre-verified by Lean's own trace. */
export function navigatorWalk(repo: Repo, declName: string, goalId?: string) {
  const decl = declTrace(repo, declName);
  const map = proofMapFor(repo, declName);
  if (!decl || !map) return undefined;
  const nb = neighbourhood(decl, map, goalId);
  if (!nb) return undefined;
  return {
    decl: declName,
    centre: nb.centre,
    steps: decl.steps.map((s) => ({ i: s.idx, tactic: s.tactic, verifiedBy: 'lean-trace' as const })),
    note: 'Each step is a tactic Lean actually elaborated in this trace — the walk is pre-verified, not agent-invented.',
  };
}
