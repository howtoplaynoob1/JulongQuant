const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 4096;
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARACTERS = 40000;
const MAX_MESSAGE_CHARACTERS = 4000;
const ALLOWED_ORIGINS = new Set([
  'https://howtoplaynoob1.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://howtoplaynoob1.github.io';
  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'content-type': 'application/json; charset=utf-8',
    vary: 'Origin',
  };
}

function jsonResponse(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders(origin),
  });
}

function safeText(value, maximum) {
  return String(value == null ? '' : value).trim().slice(0, maximum);
}

export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const safe = history
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .map(item => ({
      role: item.role,
      content: safeText(item.content, item.role === 'assistant' ? 12000 : MAX_MESSAGE_CHARACTERS),
    }))
    .filter(item => item.content)
    .slice(-MAX_HISTORY_MESSAGES);

  let remaining = MAX_HISTORY_CHARACTERS;
  const result = [];
  for (let index = safe.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = safe[index];
    const content = item.content.length > remaining ? item.content.slice(-remaining) : item.content;
    if (content) result.unshift({ role: item.role, content });
    remaining -= content.length;
  }
  return result;
}

function systemPrompt(context, task) {
  const safeContext = context && typeof context === 'object' ? context : {};
  const safeTask = task && typeof task === 'object' ? task : {};
  return [
    '你是巨龙智策，一名严谨、连续对话的量化投研助手。',
    '必须结合历史对话理解指代与追问，不得把每轮问题当成新会话。',
    '所有数值只能来自提供的研究上下文；缺失时明确说明，不得编造。',
    '回答采用 Markdown，优先给结论、证据、解释和风险边界。',
    '除非用户明确要求简短，否则完整回答问题，不要因篇幅主动省略关键证据。',
    '内容仅供量化研究展示，不构成投资建议。',
    `当前任务：${JSON.stringify(safeTask)}`,
    `研究上下文：${JSON.stringify(safeContext)}`,
  ].join('\n');
}

export function buildMessages(payload) {
  const message = safeText(payload && payload.message, MAX_MESSAGE_CHARACTERS);
  return [
    { role: 'system', content: systemPrompt(payload && payload.context, payload && payload.task) },
    ...sanitizeHistory(payload && payload.history),
    { role: 'user', content: message },
  ];
}

async function requestCompletion(messages, env, fetchImpl) {
  const response = await fetchImpl(DEEPSEEK_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || DEFAULT_MODEL,
      messages,
      max_tokens: Number(env.DEEPSEEK_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
      temperature: 0.25,
      thinking: { type: 'disabled' },
      stream: false,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const upstreamMessage = body && body.error && body.error.message;
    throw new Error(upstreamMessage || `DeepSeek 请求失败（${response.status}）`);
  }
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const content = safeText(choice && choice.message && choice.message.content, 60000);
  if (!choice || !content) throw new Error('DeepSeek 未返回有效内容');
  return {
    content,
    finishReason: choice.finish_reason || 'stop',
    usage: body.usage || null,
  };
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/chat') {
    return jsonResponse({ error: 'Not found' }, 404, origin);
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, origin);
  }
  if (!env || !env.DEEPSEEK_API_KEY) {
    return jsonResponse({ error: 'AI 服务尚未配置' }, 503, origin);
  }

  try {
    const payload = await request.json();
    const message = safeText(payload && payload.message, MAX_MESSAGE_CHARACTERS);
    if (!message) return jsonResponse({ error: '请输入研究问题' }, 400, origin);

    const messages = buildMessages({ ...payload, message });
    const first = await requestCompletion(messages, env, fetchImpl);
    let answer = first.content;
    let finishReason = first.finishReason;
    let continued = false;
    const usage = [first.usage].filter(Boolean);

    if (finishReason === 'length' && payload.response_preferences?.allow_continuation !== false) {
      const continuationMessages = messages.concat([
        { role: 'assistant', content: first.content },
        { role: 'user', content: '请从刚才中断的位置直接继续，避免重复已经完成的内容，并完整收束结论与风险提示。' },
      ]);
      const continuation = await requestCompletion(continuationMessages, env, fetchImpl);
      answer = `${first.content}\n\n${continuation.content}`;
      finishReason = continuation.finishReason;
      continued = true;
      if (continuation.usage) usage.push(continuation.usage);
    }

    return jsonResponse({
      answer_markdown: answer,
      reply: answer,
      finish_reason: finishReason,
      truncated: finishReason === 'length',
      continued,
      usage,
    }, 200, origin);
  } catch (error) {
    return jsonResponse({ error: error && error.message ? error.message : 'AI 请求失败' }, 502, origin);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env, fetch);
  },
};
