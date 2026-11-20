// ngspice (WebAssembly) via eecircuit-engine. The engine is ~20 MB, so it's
// loaded on first use, and runs are queued because one instance runs one deck at a time.
let enginePromise;
let queue = Promise.resolve();

const EMPTY_RESULT = { header: '', numVariables: 0, variableNames: [], numPoints: 0, dataType: 'real', data: [] };

function engine() {
  enginePromise ??= import('eecircuit-engine').then(async ({ Simulation }) => {
    const sim = new Simulation();
    // When an analysis fails (e.g. "timestep too small"), the engine reads
    // whatever out.raw is lying around (the previous run's results), or, if
    // there is none, never settles its promise. So delete out.raw before each
    // run, and when the engine finishes a run without having resolved it,
    // resolve it with an empty result so the caller sees the error.
    sim.log_debug = msg => {
      if (msg === 'output completed' && sim.runPromiseResolve) {
        const resolve = sim.runPromiseResolve;
        sim.runPromiseResolve = null;
        resolve(EMPTY_RESULT);
      }
    };
    await sim.start();
    return sim;
  });
  return enginePromise;
}

export function runSpice(netlist) {
  const job = queue.then(async () => {
    const sim = await engine();
    try { sim.__getSpiceModuleForTests()?.FS?.unlink('out.raw'); } catch { /* no previous output */ }
    sim.setNetList(netlist);
    const result = await sim.runSim();
    return { result, errors: sim.getError() };
  });
  queue = job.catch(() => {});
  return job;
}
