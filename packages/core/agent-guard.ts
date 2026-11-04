// Agent guardrails: agent output is untrusted.
// Citations must name nodes that exist in the graph; tactic suggestions are
// never "proven" until Lean verifies them; oversized output is rejected.

export const MAX_AGENT_CHARS = 8000;
export const AGENT_TIMEOUT_MS = 15000;

/** Node ids are cited as `(node: <id>)` or bare ids like `g:...`, `lm:...`, `mv:...`. */
export function extractCitations(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\(node:\s*([^)\s]+)\)/g)) ids.add(m[1]);
  for (const m of text.matchAll(/\b(?:g|lm|mv):[^\s,;)]+/g)) ids.add(m[0]);
  if (/\bknown\b/.test(text)) ids.add('known');
  return [...ids];
}

export interface GuardResult {
  verified: boolean;
  citations: string[];
  invalidCitations: string[];
  reason?: string;
}

export function validateCitations(text: string, validNodeIds: ReadonlySet<string>): GuardResult {
  if (text.length > MAX_AGENT_CHARS) {
    return { verified: false, citations: [], invalidCitations: [], reason: `response exceeds ${MAX_AGENT_CHARS} chars` };
  }
  const citations = extractCitations(text);
  const invalidCitations = citations.filter((c) => !validNodeIds.has(c));
  return {
    verified: citations.length > 0 && invalidCitations.length === 0,
    citations,
    invalidCitations,
    reason: invalidCitations.length ? `cites unknown nodes: ${invalidCitations.join(', ')}` : citations.length === 0 ? 'no citations' : undefined,
  };
}

/** Run an agent call with a hard timeout; rejection is a value, not a throw. */
export async function withAgentTimeout<T>(work: Promise<T>, ms = AGENT_TIMEOUT_MS): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('agent timeout')), ms); }),
    ]);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
