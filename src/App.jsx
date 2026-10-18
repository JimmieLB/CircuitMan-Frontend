import { useEffect, useState } from 'react';
import './App.css';
import { PARTS, pinLabel } from './circuit/parts';
import { buildNetlist } from './circuit/netlist';
import { migrateRailId } from './circuit/holes';
import BreadboardEditor from './editor/BreadboardEditor';
import Schematic from './editor/Schematic';
import ScanView from './scan/ScanView';
import AgentPanel from './agent/AgentPanel';
import { useSimulation } from './sim/useSimulation';
import { formatCurrent, formatVoltage } from './sim/spice';

const STORE = 'breadboard-circuit';
const VERSION = 2;   // 2: rail holes are named by the column they line up with

function loadDoc() {
  try {
    const doc = JSON.parse(localStorage.getItem(STORE));
    if (!doc) return { components: [], photo: null };
    if (doc.version !== VERSION)
      doc.components = doc.components.map(c => ({ ...c, pins: c.pins.map(migrateRailId) }));
    return doc;
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
    try { localStorage.setItem(STORE, JSON.stringify({ version: VERSION, components, photo })); } catch { /* storage full or blocked */ }
  }, [components, photo]);

  const netlist = buildNetlist(components);
  const sim = useSimulation(components, netlist);
  const selected = components.find(c => c.id === selectedId);

  const setComponents = cs => setDoc(d => ({ ...d, components: cs }));
  // Functional update: slider drags fire faster than renders, so never patch a stale list.
  const updateComponent = (id, patch) =>
    setDoc(d => ({ ...d, components: d.components.map(c => (c.id === id ? { ...c, ...patch } : c)) }));
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
                onUpdatePart={updateComponent}
                netlist={netlist} sim={sim} selectedId={selectedId} onSelect={setSelectedId} tool={tool}
                photo={showPhoto ? photo : null} />
            </section>
            <section>
              <h2>Schematic</h2>
              <Schematic components={components} netlist={netlist} sim={sim}
                selectedId={selectedId} onSelect={setSelectedId} />
            </section>
          </main>

          <aside className="inspector">
            <AgentPanel components={components} onCircuit={setComponents} />

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
                <PartSim c={selected} sim={sim} onChange={patch => updateComponent(selected.id, patch)} />
                <button className="danger" onClick={() => removeComponent(selected.id)}>Delete part</button>
              </div>
            ) : <p className="muted">Click a part on the breadboard or schematic.</p>}

            <h2>Simulation</h2>
            <SimStatus sim={sim} />

            <h2>Nets</h2>
            {netlist.nets.length ? (
              <ul className="nets">
                {netlist.nets.map(net => (
                  <li key={net.name} className={net.floating ? 'floating' : ''}>
                    <strong style={{ color: net.color }}>{net.name}</strong>{' '}
                    {sim.nets.has(net.name) && <span className="volts">{formatVoltage(sim.nets.get(net.name))}</span>}{' '}
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

function SimStatus({ sim }) {
  const text = {
    off: sim.message,
    running: 'Simulating…',
    ok: 'DC operating point is up to date.',
    error: sim.message,
  }[sim.status];
  return (
    <div className={`sim-status ${sim.status}`}>
      <p>{text}</p>
      {sim.warnings.map(w => <p key={w} className="muted">{w}</p>)}
    </div>
  );
}

// Live readings and controls for the selected part.
function PartSim({ c, sim, onChange }) {
  const led = sim.leds.get(c.id);
  const supplied = sim.supplies.get(c.id);
  return (
    <>
      {c.type === 'button' && (
        <label className="check">
          <input type="checkbox" checked={!!c.pressed} onChange={e => onChange({ pressed: e.target.checked, latched: e.target.checked })} />
          Pressed
        </label>
      )}
      {c.type === 'pot' && (
        <label>Wiper position
          <input type="range" min={0} max={1} step={0.01} value={c.wiper ?? 0.5}
            onChange={e => onChange({ wiper: Number(e.target.value) })} />
        </label>
      )}
      {led && (
        <p className={led.over ? 'reading over' : 'reading'}>
          {led.over ? `Too much current (${formatCurrent(led.current)}): this LED would burn out. Add a series resistor.`
            : led.on ? `On: ${formatCurrent(led.current)} (${Math.round(led.brightness * 100)}% brightness)`
            : `Off: ${formatCurrent(led.current)}`}
        </p>
      )}
      {supplied !== undefined && <p className="reading">Supplying {formatCurrent(supplied)}</p>}
    </>
  );
}
