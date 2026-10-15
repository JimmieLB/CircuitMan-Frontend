import { useEffect, useState } from 'react';
import './App.css';
import { PARTS, pinLabel } from './circuit/parts';
import { buildNetlist } from './circuit/netlist';
import BreadboardEditor from './editor/BreadboardEditor';
import Schematic from './editor/Schematic';
import ScanView from './scan/ScanView';

const STORE = 'breadboard-circuit';

function loadDoc() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? { components: [], photo: null };
  } catch {
    return { components: [], photo: null };
  }
}

export default function App() {
  const [mode, setMode] = useState('build');
  const [{ components, photo }, setDoc] = useState(loadDoc);
  const [selectedId, setSelectedId] = useState(null);
  const [tool, setTool] = useState(null);
  const [showPhoto, setShowPhoto] = useState(true);
  const [note, setNote] = useState('');

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ components, photo })); } catch { /* storage full or blocked */ }
  }, [components, photo]);

  const netlist = buildNetlist(components);
  const selected = components.find(c => c.id === selectedId);

  const setComponents = cs => setDoc(d => ({ ...d, components: cs }));
  const updateComponent = (id, patch) =>
    setComponents(components.map(c => (c.id === id ? { ...c, ...patch } : c)));
  const removeComponent = id => {
    setComponents(components.filter(c => c.id !== id));
    setSelectedId(null);
  };

  useEffect(() => {
    function onKey(e) {
      if (e.target.closest('input, textarea')) return;
      if (e.key === 'Escape') { setTool(null); setSelectedId(null); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) removeComponent(selectedId);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function pickTool(t) {
    setTool(t);
    setSelectedId(null);
  }

  function onScanned(scan) {
    if (components.length && !confirm('Replace the current circuit with the scanned one?')) return;
    setDoc({ components: scan.components, photo: scan.photo });
    setNote(scan.note);
    setShowPhoto(true);
    setSelectedId(null);
    setTool(null);
    setMode('build');
  }

  return (
    <div className="app">
      <header>
        <h1>Breadboard Studio</h1>
        <nav className="tabs">
          <button className={mode === 'build' ? 'on' : ''} onClick={() => setMode('build')}>Build</button>
          <button className={mode === 'scan' ? 'on' : ''} onClick={() => setMode('scan')}>Scan</button>
        </nav>
      </header>

      {mode === 'scan' ? <ScanView onScanned={onScanned} /> : (
        <div className="build">
          <aside className="palette">
            <h2>Parts</h2>
            <button className={!tool ? 'on' : ''} onClick={() => pickTool(null)}>Select</button>
            {Object.entries(PARTS).map(([type, p]) => (
              <button key={type} className={tool === type ? 'on' : ''} onClick={() => pickTool(type)}>
                <span className="swatch" style={{ background: p.color }} />{p.label}
              </button>
            ))}
            <hr />
            {photo && (
              <>
                <label className="check">
                  <input type="checkbox" checked={showPhoto} onChange={e => setShowPhoto(e.target.checked)} />
                  Show scanned photo
                </label>
                <button onClick={() => setDoc(d => ({ ...d, photo: null }))}>Remove photo</button>
              </>
            )}
            <button disabled={!components.length}
              onClick={() => { if (confirm('Remove every part?')) { setComponents([]); setSelectedId(null); } }}>
              Clear circuit
            </button>
          </aside>

          <main>
            {note && (
              <p className="note">{note} <button onClick={() => setNote('')} aria-label="Dismiss">×</button></p>
            )}
            <section>
              <h2>Breadboard</h2>
              <BreadboardEditor key={tool ?? 'select'} components={components} onChange={setComponents}
                netlist={netlist} selectedId={selectedId} onSelect={setSelectedId} tool={tool}
                photo={showPhoto ? photo : null} />
            </section>
            <section>
              <h2>Schematic</h2>
              <Schematic components={components} netlist={netlist}
                selectedId={selectedId} onSelect={setSelectedId} />
            </section>
          </main>

          <aside className="inspector">
            <h2>Properties</h2>
            {selected ? (
              <div className="props">
                <p><strong>{selected.ref}</strong> {PARTS[selected.type].label}</p>
                {selected.type !== 'wire' && (
                  <>
                    <label>Reference
                      <input value={selected.ref} onChange={e => updateComponent(selected.id, { ref: e.target.value })} />
                    </label>
                    <label>Value
                      <input value={selected.value} onChange={e => updateComponent(selected.id, { value: e.target.value })} />
                    </label>
                  </>
                )}
                <table>
                  <thead><tr><th>Pin</th><th>Hole</th><th>Net</th></tr></thead>
                  <tbody>
                    {selected.pins.map((hole, i) => {
                      const net = netlist.pinNet.get(`${selected.id}:${i}`);
                      return (
                        <tr key={i}>
                          <td>{PARTS[selected.type].pins[i]}</td>
                          <td className="mono">{hole}</td>
                          <td style={{ color: net?.color }}>{net?.name}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <button className="danger" onClick={() => removeComponent(selected.id)}>Delete part</button>
              </div>
            ) : <p className="muted">Click a part on the breadboard or schematic.</p>}

            <h2>Nets</h2>
            {netlist.nets.length ? (
              <ul className="nets">
                {netlist.nets.map(net => (
                  <li key={net.name} className={net.floating ? 'floating' : ''}>
                    <strong style={{ color: net.color }}>{net.name}</strong>{' '}
                    {net.pins.map(p => pinLabel(p.comp, p.pin)).join(', ') || '(wires only)'}
                    {net.floating && <em> unconnected</em>}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No connections yet.</p>}
          </aside>
        </div>
      )}
    </div>
  );
}
