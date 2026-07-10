"use client";
import { Fragment, type ReactNode } from "react";

// Minimal, dependency-free Markdown renderer. Output is React nodes (never raw HTML), so
// untrusted SKILL.md content cannot inject markup — React escapes all text. Link hrefs are
// additionally protocol-guarded. Supports headings, fenced/inline code, lists, blockquotes,
// bold/italic, and links — enough to read a SKILL.md without pulling in a markdown engine.

function safeHref(url: string): string | undefined {
  const u = url.trim();
  if (/^(https?:)?\/\//i.test(u) || u.startsWith("/") || u.startsWith("#") || u.startsWith("mailto:")) return u;
  return undefined; // drop javascript:, data:, etc.
}

const isFence = (line: string | undefined) => line !== undefined && /^\s*```/.test(line);

// Inline: `code`, **bold**, *italic*, [text](href). Processed in precedence order.
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/;
  while (rest.length) {
    const m = re.exec(rest);
    const tok = m?.[0];
    if (!m || tok === undefined) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) {
      out.push(<code key={k} className="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    } else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      const linkText = mm?.[1] ?? tok;
      const href = mm?.[2] ? safeHref(mm[2]) : undefined;
      out.push(href ? <a key={k} href={href} target="_blank" rel="noreferrer noopener">{linkText}</a> : <Fragment key={k}>{linkText}</Fragment>);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={`p${key++}`}>{inline(para.join(" "), `p${key}`)}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const Tag = list.ordered ? "ol" : "ul";
      const items = list.items;
      blocks.push(<Tag key={`l${key++}`} className="md-list">{items.map((it, j) => <li key={j}>{inline(it, `li${key}-${j}`)}</li>)}</Tag>);
      list = null;
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? "";

    // Fenced code block
    if (isFence(line)) {
      flushPara();
      flushList();
      const buf: string[] = [];
      idx++;
      // NB: must advance idx inside the loop — omitting it hangs the browser on ANY code block
      // (stored client-side DoS, since SKILL.md is proposer-controlled). Audit P0-4.
      while (idx < lines.length && !isFence(lines[idx])) { buf.push(lines[idx] ?? ""); idx++; }
      blocks.push(<pre key={`c${key++}`} className="md-pre"><code>{buf.join("\n")}</code></pre>);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = (heading[1] ?? "#").length;
      const Tag = (`h${Math.min(level + 1, 6)}`) as "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={`h${key++}`} className="md-h">{inline(heading[2] ?? "", `h${key}`)}</Tag>);
      continue;
    }

    const uli = /^\s*[-*]\s+(.*)$/.exec(line);
    const oli = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (uli || oli) {
      flushPara();
      const ordered = Boolean(oli);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((uli ?? oli)?.[1] ?? "");
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      flushList();
      blocks.push(<blockquote key={`q${key++}`} className="md-quote">{inline(quote[1] ?? "", `q${key}`)}</blockquote>);
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  flushList();

  return <div className="md">{blocks}</div>;
}
