(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JuLongMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[char]));
  }

  function renderInline(value) {
    return escapeHtml(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  function splitTableRow(line) {
    let value = String(line || '').trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);

    const cells = [];
    let cell = '';
    let escaped = false;
    for (const char of value) {
      if (escaped) {
        cell += char === '|' ? '|' : `\\${char}`;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '|') {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += char;
      }
    }
    if (escaped) cell += '\\';
    cells.push(cell.trim());
    return cells;
  }

  function separatorAlignment(cell) {
    const value = String(cell || '').replace(/\s/g, '');
    if (!/^:?-{3,}:?$/.test(value)) return null;
    if (value.startsWith(':') && value.endsWith(':')) return 'center';
    if (value.endsWith(':')) return 'right';
    return 'left';
  }

  function tableStart(lines, index) {
    if (index + 1 >= lines.length || !lines[index].includes('|')) return null;
    const headers = splitTableRow(lines[index]);
    const separators = splitTableRow(lines[index + 1]);
    if (!headers.length || separators.length !== headers.length) return null;
    const alignments = separators.map(separatorAlignment);
    return alignments.every(Boolean) ? { headers, alignments } : null;
  }

  function renderTable(lines, index, definition) {
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes('|')) {
      const cells = splitTableRow(lines[cursor]);
      while (cells.length < definition.headers.length) cells.push('');
      rows.push(cells.slice(0, definition.headers.length));
      cursor += 1;
    }

    const header = definition.headers.map((cell, column) =>
      `<th class="align-${definition.alignments[column]}" scope="col">${renderInline(cell)}</th>`
    ).join('');
    const body = rows.map(row => `<tr>${row.map((cell, column) =>
      `<td class="align-${definition.alignments[column]}">${renderInline(cell)}</td>`
    ).join('')}</tr>`).join('');

    return {
      html: `<div class="ai-table-scroll" role="region" aria-label="投研数据表格" tabindex="0"><table class="ai-markdown-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`,
      nextIndex: cursor,
    };
  }

  function render(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const output = [];
    let listType = null;
    let codeLines = null;
    const closeList = () => {
      if (listType) output.push(`</${listType}>`);
      listType = null;
    };

    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      if (/^```/.test(line)) {
        closeList();
        if (codeLines) {
          output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
          codeLines = null;
        } else {
          codeLines = [];
        }
        index += 1;
        continue;
      }
      if (codeLines) {
        codeLines.push(line);
        index += 1;
        continue;
      }

      const table = tableStart(lines, index);
      if (table) {
        closeList();
        const rendered = renderTable(lines, index, table);
        output.push(rendered.html);
        index = rendered.nextIndex;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      } else if (unordered || ordered) {
        const nextType = unordered ? 'ul' : 'ol';
        if (listType !== nextType) {
          closeList();
          output.push(`<${nextType}>`);
          listType = nextType;
        }
        output.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      } else if (/^>\s?/.test(line)) {
        closeList();
        output.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`);
      } else if (/^\s*---+\s*$/.test(line)) {
        closeList();
        output.push('<hr>');
      } else if (line.trim()) {
        closeList();
        output.push(`<p>${renderInline(line)}</p>`);
      } else {
        closeList();
      }
      index += 1;
    }

    if (codeLines) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    closeList();
    return output.join('');
  }

  return { escapeHtml, renderInline, splitTableRow, render };
});
