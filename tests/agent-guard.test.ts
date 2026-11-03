import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCitations, validateCitations, withAgentTimeout, MAX_AGENT_CHARS } from '../packages/core/agent-guard';

test('agent guard: citations to real nodes verify; fabricated nodes do not', () => {
  const valid = new Set(['g:1', 'lm:Nat.add_comm', 'known']);
  const ok = validateCitations('Standing on (node: g:1), try (node: lm:Nat.add_comm).', valid);
  assert.equal(ok.verified, true);
  const bad = validateCitations('Standing on (node: g:999), trust me.', valid);
  assert.equal(bad.verified, false);
  assert.deepEqual(bad.invalidCitations, ['g:999']);
  const none = validateCitations('No citations here.', valid);
  assert.equal(none.verified, false);
});

test('agent guard: oversized output is rejected, timeout is a value', async () => {
  const big = validateCitations('x'.repeat(MAX_AGENT_CHARS + 1), new Set());
  assert.equal(big.verified, false);
  const slow = await withAgentTimeout(new Promise(() => {}), 20);
  assert.equal(slow.ok, false);
  const fast = await withAgentTimeout(Promise.resolve(42), 1000);
  assert.deepEqual(fast, { ok: true, value: 42 });
});

test('extractCitations finds parenthesised and bare node ids', () => {
  assert.deepEqual(new Set(extractCitations('see (node: g:1) and lm:Foo.bar and known')), new Set(['g:1', 'lm:Foo.bar', 'known']));
});
