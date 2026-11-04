import { useEffect, useRef, useState } from 'react';
import { api, post, type ApplyReply, type ChatReply, type ProofMapData } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface Msg {
  role: 'human' | 'agent' | 'system' | 'verified';
  text: string;
  candidates?: { tactic: string; rationale?: string }[];
  attempts?: { round: number; tactic: string; outcome: 'closed' | 'advanced' | 'rejected'; detail: string }[];
  badge?: string;
  ok?: boolean;
}

export function ChatRail({ repoId, decl, goal, contextLabel, initialPrompt, onMapUpdate }: {
  repoId: string;
  decl?: string;
  goal?: string;
  contextLabel: string;
  initialPrompt?: string;
  onMapUpdate: (map: ProofMapData) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState(initialPrompt ?? '');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentStatus, setAgentStatus] = useState('…');
  const [keySaved, setKeySaved] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [model, setModel] = useState('muse-wonder-1.0');
  const [keyMsg, setKeyMsg] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (initialPrompt) setInput(initialPrompt); }, [initialPrompt]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [msgs]);

  async function refreshStatus() {
    try {
      const s = await api<any>('/api/agent/status');
      setAgentStatus(s.agent ? s.model : 'no API key');
      setKeySaved(!!s.hasMetaKey);
      if (s.model) setModel(s.model);
    } catch { setAgentStatus('server unreachable'); }
  }
  useEffect(() => { void refreshStatus(); }, []);

  async function applyTactic(tactic: string) {
    if (!decl) {
      setMsgs((m) => [...m, { role: 'system', text: 'Open a declaration and stand on its frontier first — then I can have Lean check a tactic there.' }]);
      return;
    }
    setBusy(true);
    setMsgs((m) => [...m, { role: 'system', text: `Looping with Lean & Agent from \`${tactic}\` at ${decl} until the frontier closes or advances…` }]);
    try {
      const r = await api<ApplyReply>(`/api/repos/${encodeURIComponent(repoId)}/apply`, post({ decl, goal, tactic, loop: true }));
      if (!r || (r as any).error) {
        setMsgs((m) => [...m, { role: 'system', text: `Could not apply: ${(r as any)?.error ?? 'empty response'}` }]);
        return;
      }
      setMsgs((m) => [...m, { role: r.ok ? 'verified' : 'system', text: r.explanation, attempts: r.attempts }]);
      if (r.ok && r.map) {
        onMapUpdate(r.map);
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: 'system', text: `Could not reach the server (${e instanceof Error ? e.message : String(e)}).` }]);
    } finally { setBusy(false); }
  }

  async function askQuestion(rawQuestion: string) {
    const q = rawQuestion.trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    setMsgs((m) => [...m, { role: 'human', text: q }, { role: 'system', text: 'Asking Meta AI…' }]);
    try {
      const r = await api<ChatReply>(`/api/repos/${encodeURIComponent(repoId)}/chat`, post({ decl, goal, question: q }));
      setMsgs((m) => {
        const out = m.slice(0, -1);
        if (!r || (r as any).error) {
          out.push({ role: 'system', text: `Server rejected the request: ${(r as any)?.error ?? 'empty response'}` });
          return out;
        }
        out.push({
          role: 'agent',
          text: r.answer,
          candidates: r.candidates ?? [],
          badge: r.verified ? '✓ citations verified' : `unverified${r.reason ? ` — ${r.reason}` : ''} · via ${r.agent || 'none'}`,
          ok: r.verified,
        });
        if ((r.candidates ?? []).length) out.push({ role: 'system', text: 'Suggestions are unverified. Pressing Try loops with Lean until a tactic closes or advances the frontier.' });
        return out;
      });
    } catch (err) {
      setMsgs((m) => [...m.slice(0, -1), { role: 'system', text: `Could not reach the server (${err instanceof Error ? err.message : String(err)}).` }]);
    } finally { setBusy(false); }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    await askQuestion(input);
  }

  async function saveKey() {
    if (!keyInput.trim()) { setKeyMsg('paste your key first'); return; }
    const s = await api<any>('/api/agent/key', post({ apiKey: keyInput }));
    if (s?.error) { setKeyMsg(s.error); return; }
    setKeyInput('');
    setKeyMsg('key saved on server');
    void refreshStatus();
  }

  return (
    <aside className="flex h-full flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 shadow-sm" aria-label="Agent chat">
      <div className="-m-4 mb-0 flex items-baseline justify-between gap-2 rounded-t-lg bg-forest px-4 py-3 text-stone-100">
        <strong className="font-serif text-lg">Agent</strong>
        <span className="text-xs text-stone-300">{agentStatus}</span>
        <Button variant="ghost" size="sm" className="text-stone-100 hover:bg-white/10" onClick={() => setSettingsOpen((o) => !o)}>API key</Button>
      </div>
      <p className="rounded-md border border-brass/40 bg-parchment px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-stone-700">⌖ {contextLabel}</p>

      {settingsOpen && (
        <div className="space-y-2 rounded-md border border-stone-200 p-3">
          {!keySaved ? (
            <div className="flex gap-2">
              <Input type="password" placeholder="Meta API key / MODEL_API_KEY" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} aria-label="Meta API key" />
              <Button size="sm" onClick={saveKey}>Save</Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={async () => { await api('/api/agent/key', post({ apiKey: '' })); setKeyMsg('key cleared'); void refreshStatus(); }}>Clear saved key</Button>
          )}
          <div className="flex items-center gap-2">
            <label className="text-xs text-stone-500" htmlFor="model-input">Model</label>
            <Input id="model-input" value={model} onChange={(e) => setModel(e.target.value)} className="h-8" />
            <Button size="sm" variant="secondary" onClick={async () => { await api('/api/agent/model', post({ model })); setKeyMsg(`model set to ${model}`); void refreshStatus(); }}>Set</Button>
          </div>
          {keyMsg && <p className="text-xs text-stone-500">{keyMsg}</p>}
          <p className="text-xs text-stone-400">Keys stay on the server and are never returned to the browser. Citations are checked against the graph; tactics are unverified until Lean checks them.</p>
        </div>
      )}

      <div ref={logRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 scroll-smooth" aria-live="polite">
        {msgs.length === 0 && (
          <p className="rounded-md border border-stone-200 p-3 text-sm text-stone-500">
            Ask about the current proof, a nearby landmark, or what remains open. From scratch, tell the agent what to prove.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn(
            'whitespace-pre-wrap break-words rounded-md border p-3 text-sm',
            m.role === 'human' && 'border-teal-100 bg-teal-50',
            m.role === 'system' && 'border-stone-200 bg-stone-50 text-xs text-stone-600',
            m.role === 'verified' && 'border-green-300 bg-green-50',
            m.role === 'agent' && 'border-stone-200 bg-white',
          )}>
            {m.role === 'human' && <b>You: </b>}{m.text}
            {m.badge && <div className="mt-1"><Badge variant={m.ok ? 'success' : 'warning'}>{m.badge}</Badge></div>}
            {m.attempts && m.attempts.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-stone-200/80 pt-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-stone-500">Lean Check Trail ({m.attempts.length} attempt{m.attempts.length === 1 ? '' : 's'})</p>
                {m.attempts.map((a, idx) => (
                  <div key={idx} className="flex items-start justify-between gap-2 rounded bg-white/80 px-2 py-1 font-mono text-[11px]">
                    <span className="break-all text-stone-800">#{idx + 1} <b>{a.tactic}</b></span>
                    <Badge variant={a.outcome === 'rejected' ? 'warning' : 'success'} className="shrink-0 px-1.5 py-0 text-[9px]">
                      {a.outcome === 'closed' ? '✓ closed' : a.outcome === 'advanced' ? '→ advanced' : '✗ rejected'}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
            {m.candidates?.map((c) => (
              <div key={c.tactic} className="mt-2 rounded-md border border-stone-300 bg-white p-2">
                <code className="block break-words rounded bg-forest-deep px-2 py-1.5 font-mono text-[13px] font-semibold text-teal-50">{c.tactic}</code>
                {c.rationale && <span className="block text-xs text-stone-500">{c.rationale}</span>}
                <Button size="sm" className="mt-1.5" disabled={busy} onClick={() => applyTactic(c.tactic)}>
                  {busy ? 'Lean is checking…' : 'Try this — Lean checks it'}
                </Button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        {(['Explain this place', 'Suggest next tactic', 'What landmarks combine here?'] as const).map((q) => (
          <button
            key={q}
            type="button"
            disabled={busy}
            onClick={() => void askQuestion(q)}
            className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 text-[11px] font-medium text-stone-700 transition-colors hover:border-teal-700 hover:bg-teal-50 disabled:opacity-50">
            {q}
          </button>
        ))}
      </div>

      <form onSubmit={send} className="flex gap-2">
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Direct the agent…" aria-label="Direct the agent" />
        <Button type="submit" disabled={busy}>Send</Button>
      </form>
    </aside>
  );
}
