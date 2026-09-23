var Anthropic = require('@anthropic-ai/sdk');
var config = require('../config');

// The one place the OS talks to the Claude API (Anthropic's official SDK).
// Used by the AI Assistant (services/ai.service.js) and the marketing
// recommendations (services/marketing.service.js).
//
// Model: ANTHROPIC_MODEL, default claude-opus-5. On Opus 5 and Fable models
// the request asks for server-side fallbacks ("default"): if the model's
// safety classifiers decline a request — which occasionally happens to
// ordinary business questions too — Anthropic re-runs it on its recommended
// fallback model instead of returning a refusal.
//
// Effort: ANTHROPIC_EFFORT (low, medium, high, xhigh, max), default medium —
// how hard the model thinks before answering. Higher is slower and costs
// more; medium is plenty for looking things up in the OS.

var FALLBACK_BETA = 'server-side-fallback-2026-07-01';
var MAX_TOKENS = 8000;

var client = null;
var testClient = null;

function getClient() {
  if (testClient) return testClient;
  if (!client) client = new Anthropic({ apiKey: config.ai.apiKey, baseURL: config.ai.baseUrl, maxRetries: 2, timeout: 120 * 1000 });
  return client;
}

// Tests swap in a fake with the same messages.create / beta.messages.create
// shape, so no test ever calls the real API.
function setClientForTests(fake) { testClient = fake; }

function configured() { return !!(config.ai.apiKey || testClient); }

function usesFallbacks(model) { return /^claude-(opus-5|fable)/.test(model); }
function supportsEffort(model) { return !/haiku/.test(model); }

// params: { system, messages, tools?, max_tokens? } — model, effort and
// fallbacks are filled in here.
async function create(params) {
  var model = config.ai.model;
  var body = Object.assign({ model: model, max_tokens: MAX_TOKENS }, params);
  if (config.ai.effort && supportsEffort(model)) body.output_config = { effort: config.ai.effort };
  var c = getClient();
  if (usesFallbacks(model)) {
    return c.beta.messages.create(Object.assign(body, { betas: [FALLBACK_BETA], fallbacks: 'default' }));
  }
  return c.messages.create(body);
}

function textOf(response) {
  return (response.content || []).filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('\n\n').trim();
}

// A plain question → plain text answer. A refusal is returned as a sentence
// for the person rather than thrown, since both callers show it as the reply.
async function complete(system, messages, maxTokens) {
  var response = await create({ system: system, messages: messages, max_tokens: maxTokens || MAX_TOKENS });
  if (response.stop_reason === 'refusal') return REFUSAL_REPLY;
  return textOf(response);
}

var REFUSAL_REPLY = "I can't help with that request.";

// Turns an SDK error into something worth showing a person in the OS — the
// operator-facing detail (bad key, no credit) is said plainly because the
// people who can fix it are the people who see it.
function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key on the server was rejected. Check ANTHROPIC_API_KEY on Render.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'The Anthropic API key on the server is not allowed to use this model (' + config.ai.model + ').';
  if (err instanceof Anthropic.NotFoundError) return 'The model "' + config.ai.model + '" was not found. Check ANTHROPIC_MODEL on Render.';
  if (err instanceof Anthropic.RateLimitError) return 'The AI service is busy right now. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the AI service. Try again in a minute.';
  if (err instanceof Anthropic.InternalServerError) return 'The AI service had a problem. Try again in a minute.';
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) return 'The Anthropic account has run out of credit.';
  if (err instanceof Anthropic.APIError) return 'The AI service returned an error: ' + err.message;
  return null;
}

module.exports = {
  create: create, complete: complete, textOf: textOf, configured: configured, describeError: describeError,
  setClientForTests: setClientForTests, REFUSAL_REPLY: REFUSAL_REPLY
};
