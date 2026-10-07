'use strict';
// Thin wrapper over the Anthropic SDK. Every call forces a single tool, so the
// reply always arrives as structured data instead of prose we would have to parse.

const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (balanced)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (most thorough)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest)' }
];
const DEFAULT_MODEL = MODELS[0].id;

function createClaude({ apiKey, model = DEFAULT_MODEL, client } = {}) {
  let sdk = client;
  if (!sdk) {
    if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    sdk = new Ctor({ apiKey });
  }

  async function callTool({ system, user, tool, maxTokens = 8000 }) {
    let response;
    try {
      response = await sdk.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name }
      });
    } catch (err) {
      throw new Error(friendlyError(err));
    }
    const block = (response.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (!block) throw new Error('Claude did not return a structured answer. Try again.');
    if (response.stop_reason === 'max_tokens') {
      throw new Error('The answer was cut off because it was too long. Try a smaller pull request.');
    }
    return {
      input: block.input,
      usage: {
        inputTokens: response.usage ? response.usage.input_tokens : 0,
        outputTokens: response.usage ? response.usage.output_tokens : 0
      }
    };
  }

  return { callTool, model };
}

function friendlyError(err) {
  const status = err && err.status;
  if (status === 401) return 'Anthropic rejected the API key. Check it in Settings.';
  if (status === 404) return 'Anthropic does not recognise that model. Pick another in Settings.';
  if (status === 429) return 'Anthropic is rate limiting this key. Wait a moment and try again.';
  if (status === 529 || status >= 500) return 'Anthropic is temporarily unavailable. Try again shortly.';
  if (status === 400 && /prompt is too long|too many tokens/i.test(String(err.message))) {
    return 'This pull request is too large to review in one pass.';
  }
  return `Claude request failed: ${err && err.message ? err.message : 'unknown error'}`;
}

module.exports = { createClaude, friendlyError, MODELS, DEFAULT_MODEL };
