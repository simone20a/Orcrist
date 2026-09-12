import { Fragment, type ReactNode } from 'react';
import { api } from '../api';

/**
 * A small Markdown renderer for what the model says.
 *
 * Written here rather than pulled from npm for two reasons. The first is that
 * it builds React nodes directly and never touches `dangerouslySetInnerHTML`,
 * so there is no HTML-injection surface at all to sanitise — model output is
 * untrusted text, and the safest parser is one that cannot emit markup. The
 * second is that a library would mean another `npm install` on a machine where
 * that has already been painful once.
 *
 * It covers the subset an agent actually produces: fenced and inline code,
 * headings, ordered and unordered lists (nested by indent), blockquotes, rules,
 * bold, italic, strikethrough, links and bare URLs. Anything it does not know
 * survives as the literal text it was, which is the right failure for a log.
 */

interface Props {
  source: string;
  className?: string;
}

export function Markdown({ source, className }: Props) {
  return <div className={`md ${className ?? ''}`}>{blocks(source.replace(/\r\n?/g, '\n'))}</div>;
}

// --- block level --------------------------------------------------------

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL = /^(\s*)[-*+]\s+(.*)$/;
const OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function blocks(src: string, keyBase = 'b'): ReactNode[] {
  const lines = src.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `${keyBase}${n++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // fenced code — taken verbatim, including anything that looks like markup
    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[1][0];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${close === '`' ? '```+' : '~~~+'}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // the closing fence, if there was one
      out.push(
        <pre className="md-code" key={key()}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      const Tag = `h${level}` as 'h1';
      out.push(
        <Tag className={`md-h md-h${level}`} key={key()}>
          {inline(heading[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr className="md-hr" key={key()} />);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])![1]);
        i++;
      }
      out.push(
        <blockquote className="md-quote" key={key()}>
          {blocks(body.join('\n'), `${keyBase}q`)}
        </blockquote>,
      );
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const [list, next] = takeList(lines, i, `${keyBase}l${n}`);
      out.push(<Fragment key={key()}>{list}</Fragment>);
      i = next;
      continue;
    }

    // paragraph: everything up to a blank line or the start of another block
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !UL.test(lines[i]) &&
      !OL.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p className="md-p" key={key()}>
        {inline(para.join('\n'))}
      </p>,
    );
  }

  return out;
}

/** Consumes one list, recursing into anything indented under an item. */
function takeList(lines: string[], start: number, keyBase: string): [ReactNode, number] {
  const first = UL.exec(lines[start]) ?? OL.exec(lines[start]);
  const ordered = !UL.test(lines[start]);
  const baseIndent = (first![1] ?? '').length;

  const items: string[][] = [];
  let i = start;

  while (i < lines.length) {
    const ul = UL.exec(lines[i]);
    const ol = OL.exec(lines[i]);
    const m = ul ?? ol;
    if (m) {
      const indent = m[1].length;
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        // deeper: belongs to the item we are already collecting
        if (!items.length) break;
        items[items.length - 1].push(lines[i].slice(baseIndent + 2));
        i++;
        continue;
      }
      // a list of the other kind at the same level starts a new list
      if (Boolean(ol) !== ordered) break;
      items.push([ul ? ul[2] : ol![3]]);
      i++;
      continue;
    }
    if (!lines[i].trim()) {
      // a blank line ends the list unless an item continues after it
      const next = lines[i + 1];
      if (next && (UL.test(next) || OL.test(next) || /^\s{2,}\S/.test(next))) {
        i++;
        continue;
      }
      break;
    }
    // a continuation line of the current item
    if (items.length && /^\s{2,}/.test(lines[i])) {
      items[items.length - 1].push(lines[i].trim());
      i++;
      continue;
    }
    break;
  }

  const Tag = ordered ? 'ol' : 'ul';
  const node = (
    <Tag className="md-list">
      {items.map((item, k) => (
        <li className="md-li" key={`${keyBase}i${k}`}>
          {itemContent(item, `${keyBase}i${k}`)}
        </li>
      ))}
    </Tag>
  );
  return [node, i];
}

/** A list item is inline text unless it carries blocks of its own. */
function itemContent(item: string[], keyBase: string): ReactNode {
  const body = item.join('\n');
  const hasBlocks = item
    .slice(1)
    .some((l) => FENCE.test(l) || UL.test(l) || OL.test(l) || QUOTE.test(l));
  return hasBlocks ? blocks(body, keyBase) : inline(body);
}

// --- inline level -------------------------------------------------------

const CODE = /^(`+)([\s\S]*?[^`])\1(?!`)/;
const LINK = /^\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/;
const BARE = /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;

/** Only these can be opened; anything else renders as plain text. */
function safeHref(url: string): string | undefined {
  return /^(https?:|mailto:)/i.test(url) ? url : undefined;
}

function inline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let n = 0;
  const key = () => `${keyBase}${n++}`;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);
    const c = text[i];

    if (c === '`') {
      const m = CODE.exec(rest);
      if (m) {
        flush();
        out.push(
          <code className="md-inline-code" key={key()}>
            {m[2].replace(/^ | $/g, '')}
          </code>,
        );
        i += m[0].length;
        continue;
      }
    }

    if (c === '[') {
      const m = LINK.exec(rest);
      if (m) {
        const href = safeHref(m[2]);
        flush();
        out.push(
          href ? (
            <Link href={href} key={key()}>
              {inline(m[1], `${keyBase}a${n}`)}
            </Link>
          ) : (
            <Fragment key={key()}>{m[0]}</Fragment>
          ),
        );
        i += m[0].length;
        continue;
      }
    }

    if (c === 'h') {
      const m = BARE.exec(rest);
      if (m) {
        flush();
        out.push(
          <Link href={m[1]} key={key()}>
            {m[1]}
          </Link>,
        );
        i += m[0].length;
        continue;
      }
    }

    if ((c === '*' || c === '_') && text[i + 1] === c) {
      const m = new RegExp(`^\\${c}\\${c}([\\s\\S]+?)\\${c}\\${c}`).exec(rest);
      if (m) {
        flush();
        out.push(<strong key={key()}>{inline(m[1], `${keyBase}s${n}`)}</strong>);
        i += m[0].length;
        continue;
      }
    }

    if (c === '*' || c === '_') {
      const m = new RegExp(`^\\${c}([^\\s${c === '*' ? '*' : '_'}][\\s\\S]*?)\\${c}`).exec(rest);
      if (m) {
        flush();
        out.push(<em key={key()}>{inline(m[1], `${keyBase}e${n}`)}</em>);
        i += m[0].length;
        continue;
      }
    }

    if (c === '~' && text[i + 1] === '~') {
      const m = /^~~([\s\S]+?)~~/.exec(rest);
      if (m) {
        flush();
        out.push(<del key={key()}>{inline(m[1], `${keyBase}d${n}`)}</del>);
        i += m[0].length;
        continue;
      }
    }

    if (c === '\n') {
      flush();
      out.push(<br key={key()} />);
      i++;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

/**
 * A link opens in the system browser. Navigating the window itself would
 * replace the app, and this one is not a page you can go back from.
 */
function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="md-link"
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void api.env.openExternal(href).catch(() => undefined);
      }}
    >
      {children}
    </a>
  );
}
