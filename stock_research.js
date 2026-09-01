(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JuLongStockResearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DATA_URL = 'stock_research_data.json';
  const FOLLOW_UP = /(?:它|这只|该股|这家公司|估值|市盈率|市净率|走势|波动|回撤|风险|表现|成交|换手)/;
  let catalogPromise = null;

  function normalize(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
  }

  function normalizeCode(value) {
    const match = normalize(value).match(/(?:^|\D)(\d{6})(?:\.(?:SH|SZ|BJ))?(?:\D|$)/);
    return match ? match[1] : null;
  }

  function createCatalog(payload) {
    if (!payload || typeof payload !== 'object' || !payload.stocks || !payload.aliases) {
      throw new Error('个股研究数据格式无效');
    }
    const aliases = Object.entries(payload.aliases)
      .map(([alias, code]) => ({ alias: String(alias).trim(), code: String(code) }))
      .filter(item => item.alias && payload.stocks[item.code]);
    const names = aliases
      .filter(item => !/^\d{6}(?:\.(?:SH|SZ|BJ))?$/i.test(item.alias) && item.alias.length >= 2)
      .sort((left, right) => right.alias.length - left.alias.length);
    return {
      as_of: payload.as_of || null,
      stocks: payload.stocks,
      aliases: new Map(aliases.map(item => [normalize(item.alias), item.code])),
      names,
    };
  }

  function explicitCode(catalog, query) {
    const raw = normalize(query);
    const code = normalizeCode(raw);
    if (!code) return null;
    const aliasCode = catalog.aliases.get(code) || catalog.aliases.get(`${code}.SH`)
      || catalog.aliases.get(`${code}.SZ`) || catalog.aliases.get(`${code}.BJ`);
    return aliasCode && catalog.stocks[aliasCode] ? aliasCode : null;
  }

  function explicitName(catalog, query) {
    const raw = String(query == null ? '' : query);
    const match = catalog.names.find(item => raw.includes(item.alias));
    return match ? match.code : null;
  }

  function matchQuery(catalog, query, activeCode) {
    if (!catalog || !catalog.stocks) return null;
    const code = explicitCode(catalog, query) || explicitName(catalog, query);
    if (code) return { code, stock: catalog.stocks[code], source: 'explicit' };

    const inheritedCode = normalizeCode(activeCode);
    if (inheritedCode && catalog.stocks[inheritedCode] && FOLLOW_UP.test(String(query || ''))) {
      return { code: inheritedCode, stock: catalog.stocks[inheritedCode], source: 'inherited' };
    }
    return null;
  }

  async function load(fetchImpl, url) {
    const fetcher = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new Error('当前环境无法加载个股研究数据');
    if (!catalogPromise) {
      catalogPromise = fetcher(url || DATA_URL, { cache: 'no-cache' })
        .then(response => {
          if (!response.ok) throw new Error(`个股数据加载失败（${response.status}）`);
          return response.json();
        })
        .then(createCatalog)
        .catch(error => {
          catalogPromise = null;
          throw error;
        });
    }
    return catalogPromise;
  }

  async function resolve(query, activeCode, fetchImpl, url) {
    const catalog = await load(fetchImpl, url);
    return matchQuery(catalog, query, activeCode);
  }

  function resetCache() {
    catalogPromise = null;
  }

  return {
    DATA_URL,
    createCatalog,
    matchQuery,
    normalizeCode,
    load,
    resolve,
    resetCache,
  };
});
