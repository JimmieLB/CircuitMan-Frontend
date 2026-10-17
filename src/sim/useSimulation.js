import { useEffect, useState } from 'react';
import { buildDeck, readResult } from './spice';
import { runSpice } from './engine';

const EMPTY = { nets: new Map(), leds: new Map(), supplies: new Map(), warnings: [] };

// Re-runs the DC operating point whenever the circuit changes.
// Keeps the previous results on screen (status "running") while a new run is in flight.
export function useSimulation(components, netlist) {
  const deck = buildDeck(components, netlist);
  const key = deck.netlist ?? null;
  const [last, setLast] = useState({ key: null, sim: null });

  useEffect(() => {
    if (!key) return;
    let stale = false;
    const timer = setTimeout(() => {
      runSpice(key).then(
        ({ result, errors }) => { if (!stale) setLast({ key, sim: { ...EMPTY, ...readResult(deck, result, errors) } }); },
        err => { if (!stale) setLast({ key, sim: { status: 'error', message: `Simulator failed: ${err.message}`, ...EMPTY } }); },
      );
    }, 120);   // debounce, e.g. while dragging a pot slider
    return () => { stale = true; clearTimeout(timer); };
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (deck.off) return { status: 'off', message: deck.off, ...EMPTY };
  if (deck.error) return { status: 'error', message: deck.error, ...EMPTY };
  if (!last.sim) return { status: 'running', ...EMPTY };
  return last.key === key ? last.sim : { ...last.sim, status: 'running' };
}
