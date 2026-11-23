import { lazy, Suspense, useEffect, useState } from 'react';
import './App.css';
import { PARTS, pinLabel, LED_COLORS, ledColorName, seg7Anode } from './circuit/parts';
import { SEGMENTS, segStates } from './editor/SevenSegment';
import { buildNetlist } from './circuit/netlist';
import { migrateRailId, holeId, makeBoard, splitHole } from './circuit/holes';
import BreadboardEditor from './editor/BreadboardEditor';
import Schematic from './editor/Schematic';
// Scanning (camera + OpenCV + detector) is on in dev and off in production builds unless
// VITE_ENABLE_SCAN=true at build time. It's loaded on demand, so OpenCV isn't downloaded otherwise.
const SCAN_ENABLED = import.meta.env.VITE_ENABLE_SCAN === 'true'
  || (import.meta.env.DEV && import.meta.env.VITE_ENABLE_SCAN !== 'false');
// Conditional so a build without scanning leaves OpenCV out entirely.
const ScanView = SCAN_ENABLED ? lazy(() => import('./scan/ScanView')) : null;
import AgentPanel from './agent/AgentPanel';
import { exportTrainingSample, saveDatasetYaml } from './scan/trainingExport';
import { useSimulation } from './sim/useSimulation';
import { formatCurrent, formatVoltage } from './sim/spice';
import { parseChip, describeChip } from './sim/logic';

const STORE = 'breadboard-circuit';
// 2: rail holes are named by the column they line up with
// 3: many breadboards on a canvas; holes are "<board>:<hole>", and a scanned photo belongs to its board
const VERSION = 3;

const emptyDoc = () => ({ components: [], boards: [{ id: 'B1', x: 0, y: 0 }] });

function loadDoc() {
  try {
    const doc = JSON.parse(localStorage.getItem(STORE));
    if (!doc) return emptyDoc();
    if (!(doc.version >= 2))
      doc.components = doc.components.map(c => ({ ...c, pins: c.pins.map(migrateRailId) }));
    if (!(doc.version >= 3)) {
      doc.components = doc.components.map(c => ({ ...c, pins: c.pins.map(id => holeId('B1', id)) }));
      doc.boards = [{ id: 'B1', x: 0, y: 0, ...(doc.photo && { photo: doc.photo }) }];
    }
    if (!doc.boards?.length) doc.boards = emptyDoc().boards;
    return { components: doc.components, boards: doc.boards };
  } catch {
    return emptyDoc();
  }
}

const onBoard = (c, board) => c.pins.some(p => splitHole(p)[0] === board);

export default function App() {
  const [mode, setMode] = useState('build');
  const [{ components, boards }, setDoc] = useState(loadDoc);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedBoard, setSelectedBoard] = useState(null);
  const [tool, setTool] = useState(null);
  const [showPhoto, setShowPhoto] = useState(true);
  const [note, setNote] = useState('');

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ version: VERSION, components, boards })); } catch { /* storage full or blocked */ }
  }, [components, boards]);

  const netlist = buildNetlist(components);
  const sim = useSimulation(components, netlist);
  const selected = components.find(c => c.id === selectedId);

  const setComponents = cs => setDoc(d => ({ ...d, components: cs }));
  // Takes a list or an updater (board drags fire faster than renders).
  const setBoards = bs => setDoc(d => ({ ...d, boards: typeof bs === 'function' ? bs(d.boards) : bs }));
  const updateBoard = (id, patch) => setBoards(bs => bs.map(b => (b.id === id ? { ...b, ...patch } : b)));
  const board = boards.find(b => b.id === selectedBoard);

  function deleteBoard(id) {
    const parts = components.filter(c => onBoard(c, id));
    if (parts.length && !confirm(`Delete ${id} and the ${parts.length} part${parts.length > 1 ? 's' : ''} on it (wires to it included)?`)) return;
    setDoc(d => ({ boards: d.boards.filter(b => b.id !== id), components: d.components.filter(c => !onBoard(c, id)) }));
    if (selectedBoard === id) setSelectedBoard(null);
    if (parts.some(c => c.id === selectedId)) setSelectedId(null);
  }
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

  // Training files go to TRAINING_DIR when it's set (the promise gives the folder), else to downloads.
  const reportSave = (saving, what) => saving.then(
    dir => setNote(dir ? `Saved ${what} to ${dir}` : ''),
    err => setNote(`Couldn't save ${what}: ${err.message}`),
  );

  // A scan comes in as a new board with its photo (or fills the only board, if it's still empty).
  function onScanned(scan) {
    const reuse = boards.length === 1 && !components.length ? boards[0] : null;
    const b = reuse ? { ...reuse, photo: scan.photo } : makeBoard(boards, { photo: scan.photo });
    const parts = scan.components.map(c => ({ ...c, pins: c.pins.map(p => holeId(b.id, p)) }));
    setDoc(d => ({
      boards: reuse ? d.boards.map(x => (x.id === b.id ? b : x)) : [...d.boards, b],
      components: [...d.components, ...parts],
    }));
    setNote(`Scanned into ${b.id}. ${scan.note ?? ''}`);
    setShowPhoto(true);
    setSelectedBoard(b.id);
    setSelectedId(null);
    setTool(null);
    setMode('build');
  }

  // Training labels are in one board's own coordinates: the parts wholly on it, with the board prefix dropped.
  const boardParts = id => components
    .filter(c => c.pins.every(p => splitHole(p)[0] === id))
    .map(c => ({ ...c, pins: c.pins.map(p => splitHole(p)[1]) }));

  return (
    <div className="app">
      <header>
        <h1>Circuit Max</h1>
        {SCAN_ENABLED && (
          <nav className="tabs">
            <button className={mode === 'build' ? 'on' : ''} onClick={() => setMode('build')}>Build</button>
            <button className={mode === 'scan' ? 'on' : ''} onClick={() => setMode('scan')}>Scan</button>
          </nav>
        )}
      </header>

      {SCAN_ENABLED && mode === 'scan' ? (
        <Suspense fallback={<p className="muted">Loading the scanner…</p>}>
          <ScanView onScanned={onScanned} />
        </Suspense>
      ) : (
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
            {boards.some(b => b.photo) && (
              <label className="check">
                <input type="checkbox" checked={showPhoto} onChange={e => setShowPhoto(e.target.checked)} />
                Show scanned photos
              </label>
            )}
            {board?.photo && (
              <>
                <p className="muted">Photo on {board.id}</p>
                <button onClick={() => updateBoard(board.id, { photo: undefined })}>Remove photo</button>
                <button disabled={!boardParts(board.id).length}
                  title="Download the photo and YOLO-pose labels for the parts placed on this board"
                  onClick={() => reportSave(exportTrainingSample(board.photo, boardParts(board.id)), 'training sample')}>
                  Export training sample
                </button>
                <button onClick={() => reportSave(saveDatasetYaml(), 'dataset.yaml')}>Save dataset.yaml</button>
              </>
            )}
            <button disabled={!components.length}
              onClick={() => { if (confirm('Remove every part from every board?')) { setComponents([]); setSelectedId(null); } }}>
              Clear circuit
            </button>
          </aside>

          <main>
            {note && (
              <p className="note">{note} <button onClick={() => setNote('')} aria-label="Dismiss">×</button></p>
            )}
            <section>
              <h2>Breadboards</h2>
              <BreadboardEditor boards={boards} onBoardsChange={setBoards} onDeleteBoard={deleteBoard}
                selectedBoard={selectedBoard} onSelectBoard={setSelectedBoard}
                components={components} onChange={setComponents} onUpdatePart={updateComponent}
                netlist={netlist} sim={sim} selectedId={selectedId} onSelect={setSelectedId} tool={tool}
                showPhotos={showPhoto} />
            </section>
            <section>
              <h2>Schematic</h2>
              <Schematic components={components} netlist={netlist} sim={sim}
                selectedId={selectedId} onSelect={setSelectedId} />
            </section>
          </main>

          <aside className="inspector">
            <AgentPanel components={components} boards={boards}
              onCircuit={(cs, bs) => setDoc(d => ({
                components: cs,
                // The agent never sees photos; keep each board's own.
                boards: bs.map(b => ({ ...d.boards.find(x => x.id === b.id), ...b })),
              }))}
              capVoltages={sim.state} onDischarge={sim.discharge} />

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
                {(selected.type === 'led' || selected.type === 'capacitor') && (
                  <button onClick={() => updateComponent(selected.id, { pins: [...selected.pins].reverse() })}>
                    Reverse direction
                  </button>
                )}
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

// Type and colour pickers for a 7-segment display, and which segments are lit.
function Seg7Controls({ c, sim, onChange }) {
  const anode = seg7Anode(c.value), color = ledColorName(c.value);
  const set = (a, col) => onChange({ value: `${a ? 'common anode' : 'common cathode'} ${col}` });
  const segs = segStates(sim.leds, c.id);
  const lit = SEGMENTS.filter(s => segs[s]?.on);
  const over = SEGMENTS.filter(s => segs[s]?.over);
  const max = Math.max(0, ...SEGMENTS.map(s => segs[s]?.current ?? 0));
  return (
    <>
      <label>Type
        <select value={anode ? 'anode' : 'cathode'} onChange={e => set(e.target.value === 'anode', color)}>
          <option value="cathode">Common cathode (COM to −)</option>
          <option value="anode">Common anode (COM to +)</option>
        </select>
      </label>
      <label>Colour
        <select value={color} onChange={e => set(anode, e.target.value)}>
          {Object.keys(LED_COLORS).map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      {over.length ? (
        <p className="reading over">Too much current in {over.join(', ')} ({formatCurrent(max)}): give each segment its own resistor.</p>
      ) : (
        <p className="reading">{lit.length ? `Lit: ${lit.join(', ')} (up to ${formatCurrent(max)})` : 'All segments off'}</p>
      )}
    </>
  );
}

const formatSpeed = s => (s >= 0.01 ? `${Math.round(s * 100)}%` : `1/${Math.round(1 / s)}`);
const formatTime = t => (t >= 1 ? `${t.toFixed(2)} s` : `${(t * 1e3).toFixed(1)} ms`);

function SimStatus({ sim }) {
  const text = {
    off: sim.message,
    running: 'Simulating…',
    ok: sim.mode !== 'transient' ? 'DC operating point is up to date.'
      : sim.settled ? `Steady state reached (t = ${sim.time.toFixed(1)} s).`
      : sim.speed < 0.99 ? `Slow motion (${formatSpeed(sim.speed)} speed; the circuit changes too fast for real time): t = ${formatTime(sim.time)}`
      : `Running in real time: t = ${sim.time.toFixed(1)} s`,
    error: sim.message,
  }[sim.status];
  return (
    <div className={`sim-status ${sim.status}`}>
      <p>{text}</p>
      {sim.hasCaps && sim.status !== 'off' && (
        <button className="small" onClick={sim.discharge}>Discharge capacitors</button>
      )}
      {sim.warnings.map(w => <p key={w} className="muted">{w}</p>)}
    </div>
  );
}

// Live readings and controls for the selected part.
function PartSim({ c, sim, onChange }) {
  const led = sim.leds.get(c.id);
  const supplied = sim.supplies.get(c.id);
  const capV = sim.caps.get(c.id);
  const chip = c.type === 'ic_dip14' ? parseChip(c.value) : null;
  return (
    <>
      {c.type === 'seg7' && <Seg7Controls c={c} sim={sim} onChange={onChange} />}
      {c.type === 'ic_dip14' && (
        <p className="reading">
          {chip ? describeChip(chip) : 'Not a logic chip the simulator knows. Try 74HC00, 74LS04, CD4011…'}
        </p>
      )}
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
      {capV !== undefined && <p className="reading">Charged to {formatVoltage(capV)}</p>}
    </>
  );
}
