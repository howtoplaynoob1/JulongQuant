(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JuLongConversation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'julong-research-conversation-v1';
  const TTL_MS = 30 * 60 * 1000;
  const MAX_MESSAGES = 8;
  const MAX_CONTENT_LENGTH = 1500;

  function createId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `julong-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function defaultTask() {
    return { subject: 'market', goal: 'research', time_range: 'today' };
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
    return history
      .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
      .map(item => ({
        role: item.role,
        content: String(item.content || '').trim().slice(0, MAX_CONTENT_LENGTH),
      }))
      .filter(item => item.content)
      .slice(-MAX_MESSAGES);
  }

  function sanitizeTask(task) {
    const base = defaultTask();
    if (!task || typeof task !== 'object') return base;
    return {
      subject: String(task.subject || base.subject).slice(0, 40),
      goal: String(task.goal || base.goal).slice(0, 80),
      time_range: String(task.time_range || base.time_range).slice(0, 40),
    };
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
      next.task = sanitizeTask(Object.assign({}, next.task, taskUpdate));
    }
    next.expires_at = new Date(timestamp + TTL_MS).toISOString();
    return next;
  }

  function buildRequest(conversation, message, context, now) {
    const normalized = normalizeConversation(conversation, now);
    return {
      message: String(message || '').trim().slice(0, MAX_CONTENT_LENGTH),
      context: context || {},
      conversation_id: normalized.conversation_id,
      history: sanitizeHistory(normalized.history),
      task: sanitizeTask(normalized.task),
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
    createConversation,
    sanitizeHistory,
    restore,
    persist,
    appendExchange,
    buildRequest,
    reset,
  };
});
