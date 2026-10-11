(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JuLongAgentTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TOOL_CALLS = 5;
  const STRATEGY_IDS = Object.freeze(['baseline', 'defend', 'elite']);
  const STRATEGY_NAMES = Object.freeze({ baseline: '基准策略', defend: '防守策略', elite: '集中策略' });
  const TOOL_DEFINITIONS = Object.freeze([
    Object.freeze({ name: 'get_market_snapshot', read_only: true, description: '读取最新市场状态快照' }),
    Object.freeze({ name: 'summarize_market_range', read_only: true, description: '汇总最近一段时间的市场表现与状态分布' }),
    Object.freeze({ name: 'get_strategy_snapshot', read_only: true, description: '读取一个策略的最新账户快照' }),
    Object.freeze({ name: 'compare_strategies', read_only: true, description: '横向比较基准、防守和集中策略' }),
    Object.freeze({ name: 'summarize_strategy_range', read_only: true, description: '汇总一个策略最近一段时间的净值表现' }),
    Object.freeze({ name: 'get_portfolio_holdings', read_only: true, description: '读取一个策略的当前主要持仓' }),
    Object.freeze({ name: 'get_stock_snapshot', read_only: true, description: '读取一只股票的行情、表现、风险、估值和流动性快照' }),
    Object.freeze({ name: 'compare_stocks', read_only: true, description: '比较最多三只股票的研究快照' }),
    Object.freeze({ name: 'check_data_freshness', read_only: true, description: '检查网站各数据源的截止日期' }),
  ]);
  const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(item => item.name));

  function text(value, maximum) {
    return String(value == null ? '' : value).trim().slice(0, maximum || 120);
  }

  function number(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function rounded(value, digits) {
    const numeric = number(value);
    if (numeric == null) return null;
    const scale = 10 ** (digits == null ? 4 : digits);
    return Math.round(numeric * scale) / scale;
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(minimum, Math.min(maximum, numeric));
  }

  function strategyId(value) {
    const candidate = text(value, 20).toLowerCase();
    return STRATEGY_IDS.includes(candidate) ? candidate : 'baseline';
  }

  function sanitizeArgs(tool, args) {
    const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    switch (tool) {
      case 'summarize_market_range':
        return { days: boundedInteger(value.days, 20, 2, 120) };
      case 'get_strategy_snapshot':
        return { strategy: strategyId(value.strategy) };
      case 'summarize_strategy_range':
        return { strategy: strategyId(value.strategy), days: boundedInteger(value.days, 20, 2, 120) };
      case 'get_portfolio_holdings':
        return { strategy: strategyId(value.strategy), limit: boundedInteger(value.limit, 10, 1, 20) };
      case 'get_stock_snapshot':
        return { query: text(value.query || value.code || value.name, 80) };
      case 'compare_stocks': {
        const raw = Array.isArray(value.queries) ? value.queries : [];
        return { queries: raw.map(item => text(item, 80)).filter(Boolean).slice(0, 3) };
      }
      default:
        return {};
    }
  }

  function normalizePlan(input) {
    const candidate = input && typeof input === 'object' ? input : {};
    const rawCalls = Array.isArray(candidate.calls) ? candidate.calls : [];
    const calls = [];
    const ids = new Set();
    for (const raw of rawCalls) {
      if (calls.length >= MAX_TOOL_CALLS) break;
      const tool = text(raw && (raw.tool || raw.name), 60);
      if (!TOOL_NAMES.has(tool)) continue;
      let id = text(raw && raw.id, 60) || `call-${calls.length + 1}`;
      if (ids.has(id)) id = `call-${calls.length + 1}`;
      ids.add(id);
      calls.push({ id, tool, args: sanitizeArgs(tool, raw && (raw.args || raw.arguments)) });
    }
    return {
      objective: text(candidate.objective, 300) || '回答当前量化研究问题',
      calls,
    };
  }

  function marketSource(runtime) {
    const latest = runtime && runtime.market && runtime.market.latest;
    return { asset: 'market_data.json', as_of: latest && latest.date ? latest.date : null };
  }

  function strategySource(runtime, strategy) {
    const payload = runtime && runtime.strategies && runtime.strategies[strategy];
    return {
      asset: strategy === 'baseline' ? 'portfolio_data.json' : `portfolio_${strategy === 'defend' ? 's2' : 's3'}_data.json`,
      as_of: payload && payload.latest && payload.latest.date ? payload.latest.date : null,
    };
  }

  function stockSource(asOf) {
    return { asset: 'stock_research_data.json', as_of: asOf || null };
  }

  function pickMarket(row) {
    if (!row || typeof row !== 'object') return null;
    const keys = [
      'date', 'regime', 'regime_cn', 'advice', 'regime_score', 'market_ret_1d',
      'market_nav', 'drawdown', 'trend_score', 'breadth_score', 'vol_percentile',
      'state_age', 'switch_flag',
    ];
    return Object.fromEntries(keys.filter(key => row[key] != null).map(key => [key, row[key]]));
  }

  function maxDrawdown(values) {
    let peak = null;
    let worst = 0;
    for (const raw of values) {
      const value = number(raw);
      if (value == null) continue;
      peak = peak == null ? value : Math.max(peak, value);
      if (peak > 0) worst = Math.min(worst, value / peak - 1);
    }
    return rounded(worst * 100, 4);
  }

  function rangeSummary(rows, navKey, returnKey) {
    const valid = rows.filter(row => row && row.date);
    if (!valid.length) throw new Error('区间数据不可用');
    const first = valid[0];
    const last = valid.at(-1);
    const startNav = number(first[navKey]);
    const endNav = number(last[navKey]);
    const returns = valid
      .map(row => number(row[returnKey] != null ? row[returnKey] : row.ret_pct))
      .filter(value => value != null);
    const periodReturn = startNav != null && endNav != null && startNav !== 0
      ? (endNav / startNav - 1) * 100
      : null;
    return {
      start_date: first.date,
      end_date: last.date,
      observations: valid.length,
      start_nav: rounded(startNav, 6),
      end_nav: rounded(endNav, 6),
      period_return_pct: rounded(periodReturn, 4),
      max_drawdown_pct: maxDrawdown(valid.map(row => row[navKey])),
      average_daily_return_pct: returns.length
        ? rounded(returns.reduce((sum, value) => sum + value, 0) / returns.length * (returnKey === 'market_ret_1d' ? 100 : 1), 4)
        : null,
    };
  }

  function strategySnapshot(payload, id) {
    if (!payload || !payload.latest) throw new Error(`策略数据不可用：${id}`);
    const latest = payload.latest;
    return {
      strategy_id: id,
      strategy_name: STRATEGY_NAMES[id] || id,
      strategy_definition: payload.strategy || null,
      date: latest.date || null,
      nav: rounded(latest.nav, 6),
      daily_return_pct: rounded(latest.daily_return_pct, 4),
      cumulative_return_pct: rounded(latest.cum_return_pct, 4),
      equity: rounded(latest.equity, 2),
      invested_pct: rounded(latest.invested_pct, 4),
      positions: number(latest.n_positions),
      benchmark_nav: rounded(latest.zz1500_nav, 6),
      excess_nav: rounded(latest.excess_nav, 6),
    };
  }

  async function resolveStock(runtime, query) {
    if (!query) throw new Error('缺少股票名称或代码');
    if (!runtime || typeof runtime.resolveStock !== 'function') throw new Error('个股研究数据不可用');
    const match = await runtime.resolveStock(query);
    if (!match || !match.snapshot) throw new Error(`未找到证券：${query}`);
    const snapshot = match.snapshot;
    return {
      result: Object.assign({ code: match.code, name: match.name }, snapshot),
      source: stockSource(snapshot.as_of),
    };
  }

  async function executeCall(call, runtime) {
    switch (call.tool) {
      case 'get_market_snapshot': {
        const result = pickMarket(runtime && runtime.market && runtime.market.latest);
        if (!result) throw new Error('市场数据不可用');
        return { result, source: marketSource(runtime) };
      }
      case 'summarize_market_range': {
        const rows = runtime && runtime.market && Array.isArray(runtime.market.data) ? runtime.market.data : [];
        const selected = rows.slice(-call.args.days);
        const result = rangeSummary(selected, 'market_nav', 'market_ret_1d');
        result.latest_regime = selected.at(-1) && selected.at(-1).regime || null;
        result.regime_counts = selected.reduce((counts, row) => {
          const key = row.regime || 'Unknown';
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {});
        return { result, source: marketSource(runtime) };
      }
      case 'get_strategy_snapshot': {
        const payload = runtime && runtime.strategies && runtime.strategies[call.args.strategy];
        return { result: strategySnapshot(payload, call.args.strategy), source: strategySource(runtime, call.args.strategy) };
      }
      case 'compare_strategies': {
        const result = STRATEGY_IDS.map(id => strategySnapshot(runtime && runtime.strategies && runtime.strategies[id], id));
        return { result, source: { asset: 'portfolio_*_data.json', as_of: result.map(item => item.date).filter(Boolean).sort().at(0) || null } };
      }
      case 'summarize_strategy_range': {
        const payload = runtime && runtime.strategies && runtime.strategies[call.args.strategy];
        const rows = payload && Array.isArray(payload.nav_history) ? payload.nav_history.slice(-call.args.days) : [];
        const result = rangeSummary(rows, 'nav', 'daily_return_pct');
        result.strategy_id = call.args.strategy;
        result.strategy_name = STRATEGY_NAMES[call.args.strategy] || call.args.strategy;
        result.strategy_definition = payload && payload.strategy || null;
        return { result, source: strategySource(runtime, call.args.strategy) };
      }
      case 'get_portfolio_holdings': {
        const payload = runtime && runtime.strategies && runtime.strategies[call.args.strategy];
        if (!payload || !Array.isArray(payload.today_holdings)) throw new Error(`持仓数据不可用：${call.args.strategy}`);
        const result = payload.today_holdings.slice(0, call.args.limit).map(item => ({
          code: item.code || item.ts_code || item.stock_id || null,
          name: item.name || item.stock_name || null,
          weight_pct: rounded(item.weight_pct != null ? item.weight_pct : number(item.weight) != null ? number(item.weight) * 100 : null, 4),
          market_value: rounded(item.market_value, 2),
          prediction: rounded(item.prediction != null ? item.prediction : item.score, 6),
        }));
        return { result, source: strategySource(runtime, call.args.strategy) };
      }
      case 'get_stock_snapshot':
        return resolveStock(runtime, call.args.query);
      case 'compare_stocks': {
        if (call.args.queries.length < 2) throw new Error('股票比较至少需要两个标的');
        const resolved = [];
        for (const query of call.args.queries) resolved.push(await resolveStock(runtime, query));
        return {
          result: resolved.map(item => item.result),
          source: stockSource(resolved.map(item => item.source.as_of).filter(Boolean).sort().at(0) || null),
        };
      }
      case 'check_data_freshness': {
        const strategies = {};
        for (const id of STRATEGY_IDS) strategies[id] = strategySource(runtime, id).as_of;
        return {
          result: { market: marketSource(runtime).as_of, strategies },
          source: { asset: 'website exported snapshots', as_of: marketSource(runtime).as_of },
        };
      }
      default:
        throw new Error(`不允许的工具：${call.tool}`);
    }
  }

  async function executePlan(input, runtime) {
    const plan = normalizePlan(input);
    const entries = [];
    for (const call of plan.calls) {
      try {
        const executed = await executeCall(call, runtime || {});
        entries.push({
          id: call.id,
          tool: call.tool,
          arguments: call.args,
          status: 'ok',
          source: executed.source,
          result: executed.result,
        });
      } catch (error) {
        entries.push({
          id: call.id,
          tool: call.tool,
          arguments: call.args,
          status: 'error',
          source: null,
          error: error && error.message ? error.message : '工具执行失败',
        });
      }
    }
    return {
      schema_version: 1,
      objective: plan.objective,
      created_at: new Date().toISOString(),
      read_only: true,
      entries,
    };
  }

  return {
    MAX_TOOL_CALLS,
    TOOL_DEFINITIONS,
    normalizePlan,
    executePlan,
  };
});
