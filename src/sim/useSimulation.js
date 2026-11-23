import { useCallback, useEffect, useRef, useState } from 'react';
import { buildDeck, opDeck, readResult, tranDeck } from './spice';
import { runSpice } from './engine';

const EMPTY = { nets: new Map(), leds: new Map(), supplies: new Map(), caps: new Map(), state: new Map(), warnings: [] };

const FRAME = 33;          // ms between transient steps (~30 updates/s)
const MAX_STEP = 0.2;      // s — after a stall, skip ahead rather than run a huge step
const SETTLED_DV = 1e-5;   // V per step below which a capacitor counts as settled
const SETTLED_STEPS = 10;  // pause the loop after this many settled steps in a row
const SLOW_MS = 60;        // a step costing more than this halves the simulation speed
const FAST_MS = 15;        // a step cheaper than this lets the speed recover towards real time
const MIN_SPEED = 1e-4;

// Simulates the circuit as it changes.
// Without capacitors nothing depends on time, so a DC operating point is run
// once per change. With capacitors the circuit is stepped in real time: each
// step simulates the wall-clock time since the previous one, starting every
// capacitor at the voltage it ended the last step with. That charge survives
// edits (pressing a button, moving a pot), so a capacitor charges, holds and
// discharges the way it would on a real breadboard. The loop pauses once
// nothing is changing any more, and restarts on the next edit.
// Keeps the previous results on screen (status "running") while a new run is in flight.
export function useSimulation(components, netlist) {
  const deck = buildDeck(components, netlist);
  const key = deck.key ?? null;
  const transient = !!deck.caps?.length;
  const [last, setLast] = useState({ key: null, sim: null });
  const [resets, setResets] = useState(0);
  const capV = useRef(new Map());   // capacitor id → volts across it (+ minus −), logic-gate states included
  const speed = useRef(1);          // simulated seconds per real second
  const clock = useRef({ time: 0, wall: null });

  useEffect(() => {
    if (!key) return;
    let stale = false, timer;
    const fail = err => { if (!stale) setLast({ key, sim: { ...EMPTY, status: 'error', message: `Simulator failed: ${err.message}` } }); };

    if (!transient) {
      const run = () => runSpice(opDeck(deck)).then(
        ({ result, errors }) => { if (!stale) setLast({ key, sim: { ...EMPTY, ...readResult(deck, result, errors), mode: 'dc' } }); },
        fail,
      );
      timer = setTimeout(run, 120);   // debounce, e.g. while dragging a pot slider
      return () => { stale = true; clearTimeout(timer); };
    }

    let settled = 0;
    const step = () => {
      const now = performance.now();
      const wallDt = clock.current.wall === null ? FRAME / 1000
        : Math.min(MAX_STEP, Math.max(1e-3, (now - clock.current.wall) / 1000));
      const dt = wallDt * speed.current;
      runSpice(tranDeck(deck, capV.current, dt)).then(({ result, errors }) => {
        if (stale) return;
        // A fast oscillator can need far more solver steps than fit in a frame:
        // run in slow motion rather than freeze the page, and speed back up when it's cheap again.
        const cost = performance.now() - now;
        if (cost > SLOW_MS) speed.current = Math.max(MIN_SPEED, speed.current / 2);
        else if (cost < FAST_MS && speed.current < 1) speed.current = Math.min(1, speed.current * 1.5);

        const sim = readResult(deck, result, errors);
        if (sim.status !== 'ok') { setLast({ key, sim: { ...EMPTY, ...sim } }); return; }

        const dv = Math.max(0, ...deck.caps.map(c => Math.abs(sim.state.get(c.id) - (capV.current.get(c.id) ?? 0))));
        capV.current = sim.state;
        clock.current = { time: clock.current.time + dt, wall: now };
        settled = dv < SETTLED_DV ? settled + 1 : 0;
        const done = settled >= SETTLED_STEPS;
        setLast({ key, sim: { ...EMPTY, ...sim, mode: 'transient', time: clock.current.time, speed: speed.current, settled: done } });
        if (!done) timer = setTimeout(step, FRAME);
        else clock.current.wall = null;   // paused: don't count the idle time as a step later
      }, fail);
    };
    // Don't count time spent on a previous circuit (or paused) as part of this one's first step.
    if (clock.current.wall !== null && performance.now() - clock.current.wall > MAX_STEP * 1000) clock.current.wall = null;
    timer = setTimeout(step, 0);
    return () => { stale = true; clearTimeout(timer); };
  }, [key, resets]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Empties every capacitor and restarts the clock. Logic gates keep their state.
  const discharge = useCallback(() => {
    capV.current = new Map([...capV.current].filter(([id]) => id.includes('#')));
    clock.current = { time: 0, wall: null };
    setResets(r => r + 1);
  }, []);

  const extra = { discharge, hasCaps: !!deck.caps?.some(c => !c.hidden) };
  if (deck.off) return { status: 'off', message: deck.off, ...EMPTY, ...extra };
  if (deck.error) return { status: 'error', message: deck.error, ...EMPTY, ...extra };
  if (!last.sim) return { status: 'running', ...EMPTY, ...extra };
  return last.key === key ? { ...last.sim, ...extra } : { ...last.sim, ...extra, status: 'running' };
}
