(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JuLongResearchTask = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DOMAINS = Object.freeze(['market', 'stock', 'industry', 'strategy', 'portfolio', 'project']);
  const ACTIONS = Object.freeze(['overview', 'analyze', 'compare', 'explain', 'screen', 'attribute']);
  const DIMENSIONS = Object.freeze([
    'trend', 'return', 'volatility', 'risk', 'drawdown', 'liquidity',
    'valuation', 'financial', 'capital_flow', 'model_signal',
  ]);
  const SOURCES = Object.freeze(['explicit', 'inherited', 'defaulted', 'inferred']);
  const SECURITY_CODE = /^(?:\d{6}\.(?:SH|SZ|BJ)|(?:SH|SZ|BJ)\.\d{6})$/i;

  function clampConfidence(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.min(1, numeric));
  }

  function text(value, maxLength) {
    return String(value == null ? '' : value).trim().slice(0, maxLength);
  }

  function field(value, allowed, fallback, fallbackSource) {
    const sourceValue = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
    const candidate = text(sourceValue.value, 40).toLowerCase();
    const normalized = allowed.includes(candidate) ? candidate : fallback;
    const requestedSource = text(sourceValue.source, 20).toLowerCase();
    return {
      value: normalized,
      source: SOURCES.includes(requestedSource) ? requestedSource : fallbackSource,
      confidence: clampConfidence(sourceValue.confidence, normalized === candidate ? 1 : 0.5),
    };
  }

  function freeField(value, fallback, fallbackSource, maxLength) {
    const sourceValue = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
    const candidate = text(sourceValue.value, maxLength || 40) || fallback;
    const requestedSource = text(sourceValue.source, 20).toLowerCase();
    return {
      value: candidate,
      source: SOURCES.includes(requestedSource) ? requestedSource : fallbackSource,
      confidence: clampConfidence(sourceValue.confidence, 1),
    };
  }

  function sanitizeCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    const value = text(candidate.value, 40);
    if (!value) return null;
    return { value, name: text(candidate.name, 80) };
  }

  function sanitizeEntity(entity, sourceOverride) {
    if (!entity || typeof entity !== 'object') return null;
    const value = text(entity.value, 40);
    if (!value) return null;
    const requestedSource = text(sourceOverride || entity.source, 20).toLowerCase();
    const candidates = Array.isArray(entity.candidates)
      ? entity.candidates.map(sanitizeCandidate).filter(Boolean).slice(0, 5)
      : [];
    return {
      value,
      name: text(entity.name, 80),
      source: SOURCES.includes(requestedSource) ? requestedSource : 'inferred',
      confidence: clampConfidence(entity.confidence, 0.5),
      candidates,
    };
  }

  function sanitizeEntities(entities) {
    if (!Array.isArray(entities)) return [];
    return entities.map(entity => sanitizeEntity(entity)).filter(Boolean).slice(0, 4);
  }

  function sanitizeDimensions(dimensions) {
    if (!Array.isArray(dimensions)) return [];
    return Array.from(new Set(dimensions
      .map(value => text(value, 30).toLowerCase())
      .filter(value => DIMENSIONS.includes(value))));
  }

  function inheritedEntities(previousTask) {
    if (!previousTask || !Array.isArray(previousTask.entities)) return [];
    return previousTask.entities
      .map(entity => sanitizeEntity(entity, 'inherited'))
      .filter(Boolean)
      .slice(0, 2);
  }

  function clarificationFor(task) {
    const ambiguous = task.entities.find(entity => entity.candidates.length > 1);
    if (ambiguous) {
      return {
        missing_slot: 'primary_entity',
        question: `“${ambiguous.value}”可能对应多个标的，请选择你要研究的证券。`,
        candidates: ambiguous.candidates,
      };
    }

    const primary = task.entities[0];
    if (task.domain.value === 'stock' && (!primary || primary.confidence < 0.6)) {
      return {
        missing_slot: 'primary_entity',
        question: '请输入要研究的股票名称或六位代码。',
        candidates: primary ? primary.candidates : [],
      };
    }

    if (task.domain.value === 'stock' && primary && !SECURITY_CODE.test(primary.value) && primary.candidates.length === 0) {
      return {
        missing_slot: 'primary_entity',
        question: `请确认“${primary.value}”对应的六位证券代码。`,
        candidates: [],
      };
    }

    if (task.action.value === 'compare' && task.entities.length < 2 && !task.benchmark) {
      return {
        missing_slot: 'comparison_target',
        question: '你希望和哪只股票比较？',
        candidates: [],
      };
    }

    return null;
  }

  function resolveTask(input, previousTask) {
    const candidate = input && typeof input === 'object' ? input : {};
    const domain = field(candidate.domain, DOMAINS, 'market', 'defaulted');
    const action = field(candidate.action, ACTIONS, 'overview', 'defaulted');
    let entities = sanitizeEntities(candidate.entities);
    if (!entities.length && candidate.inherit_entity === true) entities = inheritedEntities(previousTask);

    const defaultRange = domain.value === 'stock' ? '60d' : 'today';
    const task = {
      domain,
      action,
      entities,
      dimensions: sanitizeDimensions(candidate.dimensions),
      time_range: freeField(candidate.time_range, defaultRange, 'defaulted', 40),
      frequency: freeField(candidate.frequency, 'daily', 'defaulted', 20),
      benchmark: candidate.benchmark ? text(candidate.benchmark, 40) : null,
      output_format: freeField(candidate.output_format, 'brief', 'defaulted', 20),
      constraints: Array.isArray(candidate.constraints)
        ? candidate.constraints.map(item => text(item, 120)).filter(Boolean).slice(0, 8)
        : [],
      original_message: text(candidate.original_message, 1500),
      need_clarification: false,
      pending_clarification: null,
    };

    const pending = clarificationFor(task);
    task.need_clarification = Boolean(pending);
    task.pending_clarification = pending;
    return task;
  }

  function applyClarification(task, answer) {
    const current = task && typeof task === 'object' ? task : resolveTask({});
    const pending = current.pending_clarification;
    if (!pending) return resolveTask(current);

    const entity = sanitizeEntity(answer, 'explicit');
    if (!entity) return current;
    const entities = sanitizeEntities(current.entities);
    if (pending.missing_slot === 'comparison_target') entities.push(entity);
    else if (pending.missing_slot === 'primary_entity') entities[0] = entity;

    return resolveTask({
      domain: current.domain,
      action: current.action,
      entities,
      dimensions: current.dimensions,
      time_range: current.time_range,
      frequency: current.frequency,
      benchmark: current.benchmark,
      output_format: current.output_format,
      constraints: current.constraints,
      original_message: current.original_message,
    });
  }

  return {
    DOMAINS,
    ACTIONS,
    DIMENSIONS,
    resolveTask,
    applyClarification,
    sanitizeEntity,
    sanitizeDimensions,
  };
});
