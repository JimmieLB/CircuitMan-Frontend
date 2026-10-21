import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, SYSTEM_PROMPT, createSession } from './circuitTools';

const MODEL = 'claude-sonnet-5-5';
const MAX_STEPS = 30;   // model calls per user message

let client, clientKey;

// Runs one user turn of the circuit agent.
//   messages   – the conversation so far, exactly as returned by the last turn (append-only)
//   userText   – what the user just typed
//   components – the circuit as it is in the editor right now
//   apiKey     – Anthropic API key (read from .env.local by the dev server)
// `emit` streams progress events to the browser: text, tool, circuit, done, error.
export async function runAgent({ messages = [], userText, components = [], apiKey }, emit) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  if (apiKey !== clientKey) {
    client = new Anthropic({ apiKey });
    clientKey = apiKey;
  }
  const session = createSession(components);

  const history = [...messages, {
    role: 'user',
    content: `${userText}\n\n<current_circuit>\n${JSON.stringify(session.describe())}\n</current_circuit>`,
  }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',   // if a safety classifier declines, retry on Anthropic's recommended model
      cache_control: { type: 'ephemeral' },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: history,
    });

    if (response.stop_reason === 'refusal') {
      emit({ type: 'error', message: 'Claude declined this request. Try rephrasing it.' });
      break;   // the refused turn isn't added to the history
    }

    // Keep the full content (thinking and fallback blocks included) so the next request replays it unchanged.
    history.push({ role: 'assistant', content: response.content });
    for (const block of response.content)
      if (block.type === 'text' && block.text.trim()) emit({ type: 'text', text: block.text });

    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason === 'max_tokens') {
      emit({ type: 'error', message: 'Claude ran out of room for its reply.' });
      break;
    }

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) break;   // end_turn

    const results = [];
    for (const use of toolUses) {
      try {
        const { result, summary } = await session.run(use.name, use.input);
        emit({ type: 'tool', name: use.name, summary });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) });
      } catch (err) {
        emit({ type: 'tool', name: use.name, summary: `${use.name} failed: ${err.message}`, error: true });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: err.message, is_error: true });
      }
    }
    history.push({ role: 'user', content: results });
    emit({ type: 'circuit', components: session.components });

    if (step === MAX_STEPS - 1)
      emit({ type: 'error', message: 'Stopped after too many steps. Ask Claude to continue if it wasn\'t finished.' });
  }

  emit({ type: 'done', messages: history, components: session.components });
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError)
    return 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY in frontend/.env.local, and that the terminal running the dev server doesn\'t set an old one.';
  if (/ANTHROPIC_API_KEY/.test(err.message ?? ''))
    return 'No Anthropic API key found. Put ANTHROPIC_API_KEY=... in frontend/.env.local.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Claude API. Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `The Claude API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`;
  return err.message ?? String(err);
}
