import { LLM_NETWORK_RETRY_DELAYS_MS, isTransientLlmError, llmRequestOptions } from '../cli/harvest-lib.mjs';

export class LlmSchemaError extends Error {}

function publicError(error) {
  if (Number.isInteger(error?.httpStatus)) {
    const result = new Error(`LLM HTTP ${error.httpStatus}`);
    result.httpStatus = error.httpStatus;
    result.cause = error;
    return result;
  }
  if (error?.name === 'TimeoutError') {
    const result = new Error('LLM timeout');
    result.name = 'TimeoutError';
    result.cause = error;
    return result;
  }
  const result = new Error('LLM network error');
  result.cause = error;
  return result;
}

export async function requestJson(env, messages, {
  model = env.OBSERVE_MODEL,
  maxTokens = 16_384,
  timeoutMs = 120_000,
  retryDelays = LLM_NETWORK_RETRY_DELAYS_MS,
  fetchImpl = fetch,
} = {}) {
  const body = { model, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages };
  let responseJson;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImpl(`${env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
        ...llmRequestOptions(body, timeoutMs),
      });
      if (!response.ok) {
        const error = new Error(`LLM HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
      }
      try { responseJson = await response.json(); }
      catch { throw new LlmSchemaError('invalid LLM JSON'); }
      break;
    } catch (error) {
      if (error instanceof LlmSchemaError) throw error;
      const delay = retryDelays[attempt];
      if (!isTransientLlmError(error) || delay === undefined) throw publicError(error);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  const content = responseJson?.choices?.[0]?.message?.content;
  const reportedReason = responseJson?.choices?.[0]?.finish_reason;
  const reason = ['length', 'stop', 'content_filter', 'tool_calls', 'function_call'].includes(reportedReason) ? reportedReason : 'unknown';
  if (!content) throw new LlmSchemaError(`empty content (finish_reason=${reason})`);
  let data;
  try { data = JSON.parse(content); }
  catch { throw new LlmSchemaError(`invalid LLM JSON (finish_reason=${reason})`); }
  const usage = responseJson?.usage ?? {};
  return {
    data,
    usage: {
      input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? null,
      output_tokens: usage.output_tokens ?? usage.completion_tokens ?? null,
    },
    model: responseJson?.model ?? model,
  };
}
