import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { loadDemoRepo } from '../apps/server/store';
import { answerChat } from '../apps/server/chat';
import { getMetaApiKey, setMetaApiKey, extractOutputText, extractApiKey, extractModel } from '../apps/server/meta';

test('chat without a Meta API key says so plainly (no fake local answer)', async () => {
  const prevModel = process.env.MODEL_API_KEY, prevMeta = process.env.META_API_KEY, prevHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-home-'));
  process.env.HOME = tmp; // never touch the developer's real saved key
  delete process.env.MODEL_API_KEY; delete process.env.META_API_KEY;
  setMetaApiKey('');
  try {
    const reply = await answerChat(loadDemoRepo(), '', undefined, 'what can I explore here?');
    assert.equal(reply.agent, 'none');
    assert.match(reply.answer, /No Meta API key saved/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevModel !== undefined) process.env.MODEL_API_KEY = prevModel;
    if (prevMeta !== undefined) process.env.META_API_KEY = prevMeta;
  }
});

test('chat calls the Meta Responses API directly (stub captures the exact curl shape)', async () => {
  const seen: { auth?: string; body?: string } = {};
  const stub = http.createServer((req, res) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
      seen.auth = req.headers.authorization; seen.body = d;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_stub', object: 'response', created_at: 0, model: 'muse-wonder-1.0', status: 'completed',
        output: [{ type: 'message', id: 'msg_stub', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Standing on (node: g:x) per the map.\n[{"tactic": "simp", "rationale": "stub"}]', annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as { port: number }).port;
  const prevBase = process.env.META_API_BASE_URL, prevHome2 = process.env.HOME;
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-home-'));
  process.env.HOME = tmp2;
  process.env.META_API_BASE_URL = `http://127.0.0.1:${port}/v1`;
  setMetaApiKey('test-model-key');
  try {
    // goal id g:x does not exist in the demo map, so ask at atlas level instead:
    // use a real declaration; the stub answer cites g:x which the guard must flag.
    const reply = await answerChat(loadDemoRepo(), 'stepSucc_ρ', undefined, 'what is near here?');
    assert.match(reply.agent, /Meta AI \(muse-wonder-1\.0\)/);
    assert.equal(seen.auth, 'Bearer test-model-key');
    const sent = JSON.parse(seen.body!) as { model: string; input: { role: string; content: { type: string; text: string }[] }[] };
    assert.equal(sent.model, 'muse-wonder-1.0');
    assert.equal(sent.input[0].content[0].type, 'input_text');
    assert.match(sent.input[0].content[0].text, /stepSucc_ρ/);
    assert.match(reply.answer, /Standing on/);
    assert.equal(reply.verified, false, 'fabricated node g:x must be flagged by the citation guard');
    assert.deepEqual(reply.invalidCitations, ['g:x']);
    assert.deepEqual(reply.candidates, [{ tactic: 'simp', rationale: 'stub' }]);
  } finally {
    stub.close();
    process.env.HOME = prevHome2;
    fs.rmSync(tmp2, { recursive: true, force: true });
    if (prevBase === undefined) delete process.env.META_API_BASE_URL; else process.env.META_API_BASE_URL = prevBase;
  }
});

test('extractApiKey accepts a bare token, a Bearer header, or a whole pasted curl — and rejects garbage', () => {
  assert.equal(extractApiKey('abc-DEF_123'), 'abc-DEF_123');
  assert.equal(extractApiKey('Bearer abc-DEF_123'), 'abc-DEF_123');
  const curl = `curl -X POST https://api.meta.ai/v1/responses -H "Authorization: Bearer real-token-42" -H "Content-Type: application/json" -d '{"model": "muse-wonder-1.0", "stream": false}'`;
  assert.equal(extractApiKey(curl), 'real-token-42');
  assert.equal(extractModel(curl), 'muse-wonder-1.0');
  assert.equal(extractApiKey('hello world this is not a key'), undefined);
  assert.equal(extractApiKey(''), undefined);
});

test('extractOutputText handles output_text and nested content shapes', () => {
  assert.equal(extractOutputText({ output_text: 'hi' }), 'hi');
  assert.equal(extractOutputText({ output: [{ content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }] }), 'a\nb');
  assert.equal(extractOutputText({}), '');
});

test('Meta API key is stored server-side only (0600 file, readable back, clearable)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    setMetaApiKey('test-key-123');
    assert.equal(getMetaApiKey(), 'test-key-123');
    const f = path.join(tmp, '.graspt', '.meta_api_key');
    assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
    setMetaApiKey('');
    // env may still provide a key in CI; the file must be gone either way
    assert.equal(fs.existsSync(f), false);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
