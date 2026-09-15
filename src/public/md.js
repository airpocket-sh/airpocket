"use strict";
// A small, safe Markdown renderer for chat messages on the phone. It builds DOM
// nodes and never uses innerHTML: every piece of text lands in a text node, so a
// message can't inject markup. It covers what Claude and Codex actually write:
// paragraphs with line breaks, headings, bullet and numbered lists (nested by
// indent), fenced code, tables, quotes, rules, **bold**, `code` and links.
(() => {
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  function link(label, href) {
    const a = el("a");
    a.textContent = label;
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  // Inline: `code`, **bold** / __bold__, [text](https://...), bare https:// links.
  const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1|\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*|__([^_]+)__|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()\]]+)/g;
  function inline(text, parent) {
    let last = 0, m;
    INLINE.lastIndex = 0;
    const src = String(text);
    while ((m = INLINE.exec(src))) {
      if (m.index > last) parent.append(src.slice(last, m.index));
      if (m[1]) { const c = el("code"); c.textContent = m[2]; parent.append(c); }
      else if (m[3] !== undefined || m[4] !== undefined) { const b = el("strong"); inlineNested(m[3] ?? m[4], b); parent.append(b); }
      else if (m[5]) parent.append(link(m[5], m[6]));
      else if (m[7]) {
        const url = m[7].replace(/[.,;:!?]+$/, "");
        parent.append(link(url, url));
        if (url.length < m[7].length) parent.append(m[7].slice(url.length));
      }
      last = INLINE.lastIndex;
    }
    if (last < src.length) parent.append(src.slice(last));
  }
  // Bold text can hold code and links but not another bold; use a fresh regex state.
  function inlineNested(text, parent) {
    const saved = INLINE.lastIndex;
    const sub = new RegExp(INLINE.source, "g");
    let last = 0, m;
    while ((m = sub.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1]) { const c = el("code"); c.textContent = m[2]; parent.append(c); }
      else if (m[5]) parent.append(link(m[5], m[6]));
      else if (m[7]) parent.append(link(m[7], m[7]));
      else parent.append(m[0]);
      last = sub.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
    INLINE.lastIndex = saved;
  }

  const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+.-]*)\s*$/;
  const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const QUOTE = /^\s*>\s?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const startsBlock = (l, next) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || ITEM.test(l) || QUOTE.test(l)
    || (l.includes("|") && next !== undefined && TABLE_SEP.test(next));
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  function list(lines, i, root) {
    const stack = [];
    while (i < lines.length) {
      const m = ITEM.exec(lines[i]);
      if (!m) {
        const top = stack[stack.length - 1];
        if (top && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !startsBlock(lines[i].trim(), lines[i + 1])) {
          const li = top.list.lastElementChild;
          if (li) { li.append(el("br")); inline(lines[i].trim(), li); }
          i++;
          continue;
        }
        break;
      }
      const indent = m[1].replace(/\t/g, "    ").length;
      const ordered = /\d/.test(m[2]);
      while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || indent > top.indent || top.ordered !== ordered) {
        if (top && indent === top.indent) stack.pop();
        const parentTop = stack[stack.length - 1];
        const listEl = el(ordered ? "ol" : "ul");
        if (ordered) { const n = parseInt(m[2], 10); if (n > 1) listEl.start = n; }
        const holder = parentTop && parentTop.list.lastElementChild;
        (holder && indent > parentTop.indent ? holder : root).append(listEl);
        top = { indent, ordered, list: listEl };
        stack.push(top);
      }
      const li = el("li");
      inline(m[3], li);
      top.list.append(li);
      i++;
    }
    return i;
  }

  function render(md, root) {
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if ((m = FENCE.exec(line))) {
        const fence = m[1][0], buf = [];
        i++;
        while (i < lines.length && !new RegExp("^\\s*" + (fence === "`" ? "`" : "~") + "{3,}\\s*$").test(lines[i])) buf.push(lines[i++]);
        i++;
        const pre = el("pre"), code = el("code");
        code.textContent = buf.join("\n");
        pre.append(code);
        root.append(pre);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      if ((m = HEADING.exec(line))) { const h = el("div", "mh"); inline(m[2], h); root.append(h); i++; continue; }
      if (RULE.test(line)) { root.append(el("hr")); i++; continue; }
      if (line.includes("|") && TABLE_SEP.test(lines[i + 1] || "")) {
        const wrap = el("div", "tw"), table = el("table"), thead = el("thead"), tbody = el("tbody"), hr = el("tr");
        for (const c of cells(line)) { const th = el("th"); inline(c, th); hr.append(th); }
        thead.append(hr);
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          const tr = el("tr");
          for (const c of cells(lines[i])) { const td = el("td"); inline(c, td); tr.append(td); }
          tbody.append(tr);
          i++;
        }
        table.append(thead, tbody);
        wrap.append(table);
        root.append(wrap);
        continue;
      }
      if (QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && (m = QUOTE.exec(lines[i]))) { buf.push(m[1]); i++; }
        const q = el("blockquote");
        render(buf.join("\n"), q);
        root.append(q);
        continue;
      }
      if (ITEM.test(line)) { i = list(lines, i, root); continue; }
      const p = el("p");
      let first = true;
      while (i < lines.length && lines[i].trim() && !(i > 0 && !first && startsBlock(lines[i], lines[i + 1]))) {
        if (!first) p.append(el("br"));
        inline(lines[i].trim(), p);
        first = false;
        i++;
        if (i < lines.length && startsBlock(lines[i], lines[i + 1])) break;
      }
      root.append(p);
    }
    return root;
  }

  window.renderMarkdown = render;
})();
