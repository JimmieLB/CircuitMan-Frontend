// ngspice (WebAssembly) via eecircuit-engine. The engine is ~20 MB, so it's
// loaded on first use, and runs are queued because one instance runs one deck at a time.
let enginePromise;
let queue = Promise.resolve();

function engine() {
  enginePromise ??= import('eecircuit-engine').then(async ({ Simulation }) => {
    const sim = new Simulation();
    await sim.start();
    return sim;
  });
  return enginePromise;
}

export function runSpice(netlist) {
  const job = queue.then(async () => {
    const sim = await engine();
    sim.setNetList(netlist);
    const result = await sim.runSim();
    return { result, errors: sim.getError() };
  });
  queue = job.catch(() => {});
  return job;
}
