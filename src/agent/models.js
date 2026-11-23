// Models the circuit assistant can run on. Shared by the chat panel (the
// picker) and the server (which only accepts these ids).
//   serverFallback: whether the API can retry a safety-classifier decline on
//   another model (`fallbacks: "default"`). Haiku 5.5 has no server-side fallback.
export const AGENT_MODELS = [
  { id: 'claude-haiku-5-5',  label: 'Haiku 5.5',  hint: 'Fastest and cheapest', serverFallback: false },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Balanced (default)',   serverFallback: true },
  { id: 'claude-opus-5-5',   label: 'Opus 5.5',   hint: 'Most capable',         serverFallback: true },
];

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5-5';

export const agentModel = id => AGENT_MODELS.find(m => m.id === id) ?? AGENT_MODELS.find(m => m.id === DEFAULT_AGENT_MODEL);
