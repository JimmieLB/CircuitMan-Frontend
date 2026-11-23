import { useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, agentModel } from './models';

// The chosen model is a per-browser preference.
const MODEL_KEY = 'agent-model';
function loadModel() {
  try { return agentModel(localStorage.getItem(MODEL_KEY)).id; } catch { return DEFAULT_AGENT_MODEL; }
}

// Claude replies in Markdown. Tables scroll sideways inside the narrow panel; links open in a new tab.
const MD_PLUGINS = [remarkGfm];
const MD_COMPONENTS = {
  table: ({ node: _node, ...props }) => <div className="md-table"><table {...props} /></div>,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

// Chat with the circuit agent. The agent edits a copy of the circuit on the
// server and streams each change back, so the breadboard updates as it works.
// `capVoltages` (capacitor id → volts) tells the agent how charged the board's
// capacitors are; `onDischarge` empties them when the agent asks to.
// `onCircuit(components, boards)` replaces the circuit with the agent's version.
export default function AgentPanel({ components, boards, onCircuit, capVoltages, onDischarge }) {
  const [log, setLog] = useState([]);              // what the chat shows
  const [history, setHistory] = useState([]);      // API conversation, sent back unchanged each turn
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState(null);          // circuit before the last agent turn
  const [model, setModel] = useState(loadModel);
  const logRef = useRef(null);

  const add = entry => {
    setLog(l => [...l, entry]);
    requestAnimationFrame(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight));
  };

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setUndo(null);
    add({ kind: 'user', text });
    const before = { components, boards };
    let changed = false;

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Photos stay here: the agent doesn't need them, and they're megabytes each.
        body: JSON.stringify({ messages: history, userText: text, model, components, boards: boards.map(({ photo: _photo, ...b }) => b), capVoltages: Object.fromEntries(capVoltages) }),
      });
      if (!res.ok) throw new Error(res.status === 404
        ? 'The assistant only runs on the dev server (npm run dev).'
        : `Server error ${res.status}`);

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const event = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (event.type === 'text') add({ kind: 'assistant', text: event.text });
          else if (event.type === 'tool') add({ kind: 'tool', text: event.summary, error: event.error });
          else if (event.type === 'error') add({ kind: 'error', text: event.message });
          else if (event.type === 'circuit') { onCircuit(event.components, event.boards); changed = true; }
          else if (event.type === 'discharge') onDischarge();
          else if (event.type === 'done') {
            setHistory(event.messages);
            onCircuit(event.components, event.boards);
          }
        }
      }
    } catch (err) {
      add({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
      if (changed) setUndo(before);
    }
  }

  // Switching mid-conversation is fine: the next turn runs on the new model with the same history.
  function chooseModel(id) {
    setModel(id);
    try { localStorage.setItem(MODEL_KEY, id); } catch { /* storage blocked */ }
    if (log.length) add({ kind: 'tool', text: `Switched to ${agentModel(id).label}` });
  }

  function newChat() {
    setLog([]);
    setHistory([]);
    setUndo(null);
  }

  return (
    <div className="agent">
      <div className="agent-head">
        <h2>Assistant</h2>
        <select className="agent-model" value={model} disabled={busy} aria-label="Model"
          title={agentModel(model).hint} onChange={e => chooseModel(e.target.value)}>
          {AGENT_MODELS.map(m => <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>)}
        </select>
        {log.length > 0 && <button onClick={newChat} disabled={busy}>New chat</button>}
      </div>

      <div className="agent-log" ref={logRef}>
        {!log.length && (
          <p className="muted">
            Ask Claude to build or change the circuit, e.g. "Add a 5V supply and a green LED
            that lights up when a button is pressed."
          </p>
        )}
        {log.map((m, i) => m.kind === 'assistant'
          ? (
            <div key={i} className="msg assistant md">
              <Markdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>{m.text}</Markdown>
            </div>
          )
          : <p key={i} className={`msg ${m.kind}${m.error ? ' failed' : ''}`}>{m.text}</p>)}
        {busy && <p className="msg tool">Working… ({agentModel(model).label})</p>}
      </div>

      {undo && !busy && (
        <button onClick={() => { onCircuit(undo.components, undo.boards); setUndo(null); }}>Undo the assistant's changes</button>
      )}

      <form onSubmit={send}>
        <textarea value={input} rows={3} placeholder="Describe a circuit or a change…"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) send(e); }} />
        <button className="primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
