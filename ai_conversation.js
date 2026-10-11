(function (root, factory) {
  const researchTask = typeof module === 'object' && module.exports
    ? require('./ai_research_task.js')
    : root && root.JuLongResearchTask;
  const api = factory(researchTask);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JuLongConversation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ResearchTask) {
  'use strict';

  const STORAGE_KEY = 'julong-research-conversation-v2';
  const TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_MESSAGES = 20;
  const MAX_USER_CONTENT_LENGTH = 4000;
  const MAX_ASSISTANT_CONTENT_LENGTH = 12000;
  const MAX_HISTORY_CHARACTERS = 40000;

  function createId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `julong-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function defaultTask() {
    const task = { subject: 'market', goal: 'research', time_range: 'today' };
    if (ResearchTask) {
      task.research_task = ResearchTask.resolveTask({ domain: 'market', action: 'overview', time_range: 'today' });
    }
    return task;
  }

  function createConversation(now, id) {
    const timestamp = Number.isFinite(now) ? now : Date.now();
    return {
      conversation_id: id || createId(),
      task: defaultTask(),
      history: [],
      expires_at: new Date(timestamp + TTL_MS).toISOString(),
    };
  }

  function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    const safe = history
      .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
      .map(item => ({
        role: item.role,
        content: String(item.content || '').trim().slice(
          0,
          item.role === 'assistant' ? MAX_ASSISTANT_CONTENT_LENGTH : MAX_USER_CONTENT_LENGTH,
        ),
      }))
      .filter(item => item.content)
      .slice(-MAX_MESSAGES);

    let remaining = MAX_HISTORY_CHARACTERS;
    const withinBudget = [];
    for (let index = safe.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const item = safe[index];
      const content = item.content.length > remaining ? item.content.slice(-remaining) : item.content;
      if (content) withinBudget.unshift({ role: item.role, content });
      remaining -= content.length;
    }
    return withinBudget;
  }

  function sanitizeTask(task) {
    const base = defaultTask();
    if (!task || typeof task !== 'object') return base;
    const sanitized = {
      subject: String(task.subject || base.subject).slice(0, 40),
      goal: String(task.goal || base.goal).slice(0, 80),
      time_range: String(task.time_range || base.time_range).slice(0, 40),
    };
    if (ResearchTask) {
      const candidate = task.research_task && typeof task.research_task === 'object'
        ? task.research_task
        : {
          domain: sanitized.subject,
          action: sanitized.goal === 'research' ? 'overview' : 'analyze',
          time_range: sanitized.time_range,
        };
      sanitized.research_task = ResearchTask.resolveTask(candidate, base.research_task);
    }
    return sanitized;
  }

  function normalizeConversation(value, now) {
    const timestamp = Number.isFinite(now) ? now : Date.now();
    if (!value || typeof value !== 'object') return createConversation(timestamp);
    const expiry = Date.parse(value.expires_at || '');
    if (!Number.isFinite(expiry) || expiry <= timestamp) return createConversation(timestamp);
    return {
      conversation_id: String(value.conversation_id || createId()),
      task: sanitizeTask(value.task),
      history: sanitizeHistory(value.history),
      expires_at: new Date(timestamp + TTL_MS).toISOString(),
    };
  }

  function restore(storage, now) {
    if (!storage || typeof storage.getItem !== 'function') return createConversation(now);
    try {
      const raw = storage.getItem(STORAGE_KEY);
      return raw ? normalizeConversation(JSON.parse(raw), now) : createConversation(now);
    } catch (_) {
      return createConversation(now);
    }
  }

  function persist(storage, conversation, now) {
    const normalized = normalizeConversation(conversation, now);
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }
    return normalized;
  }

  function appendExchange(conversation, userContent, assistantContent, taskUpdate, now) {
    const timestamp = Number.isFinite(now) ? now : Date.now();
    const next = normalizeConversation(conversation, timestamp);
    next.history = sanitizeHistory(next.history.concat([
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ]));
    if (taskUpdate && typeof taskUpdate === 'object') {
      const mergedTask = Object.assign({}, next.task, taskUpdate);
      if (taskUpdate.research_task && next.task.research_task) {
        const researchUpdate = Object.assign({}, taskUpdate.research_task);
        if (!Object.prototype.hasOwnProperty.call(researchUpdate, 'time_range') && taskUpdate.time_range) {
          researchUpdate.time_range = {
            value: taskUpdate.time_range,
            source: 'inferred',
            confidence: 1,
          };
        }
        mergedTask.research_task = Object.assign({}, next.task.research_task, researchUpdate);
      }
      next.task = sanitizeTask(mergedTask);
    }
    next.expires_at = new Date(timestamp + TTL_MS).toISOString();
    return next;
  }

  function buildRequest(conversation, message, context, now) {
    const normalized = normalizeConversation(conversation, now);
    return {
      message: String(message || '').trim().slice(0, MAX_USER_CONTENT_LENGTH),
      context: context || {},
      conversation_id: normalized.conversation_id,
      history: sanitizeHistory(normalized.history),
      task: sanitizeTask(normalized.task),
      response_preferences: {
        format: 'markdown',
        detail: 'comprehensive',
        allow_continuation: true,
      },
    };
  }

  function contextWindow(conversation, now) {
    const normalized = normalizeConversation(conversation, now);
    return {
      conversation_id: normalized.conversation_id,
      history: sanitizeHistory(normalized.history),
      active_task: sanitizeTask(normalized.task),
      instruction: '结合历史对话回答当前问题，继承已确认的研究对象、时间范围与用户约束；不要把当前问题当作全新会话。',
    };
  }

  function reset(storage, now) {
    if (storage && typeof storage.removeItem === 'function') storage.removeItem(STORAGE_KEY);
    return createConversation(now);
  }

  return {
    STORAGE_KEY,
    TTL_MS,
    MAX_MESSAGES,
    MAX_USER_CONTENT_LENGTH,
    MAX_ASSISTANT_CONTENT_LENGTH,
    createConversation,
    sanitizeHistory,
    restore,
    persist,
    appendExchange,
    buildRequest,
    contextWindow,
    reset,
  };
});
