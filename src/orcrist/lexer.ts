/**
 * Orcrist lexer — implements section 3 (TERMINALS) of orcrist.langium plus the
 * keyword and symbol set used by the grammar. Keywords win over ID, exactly as
 * they do in a Langium-generated lexer.
 */

export type TokenKind = 'id' | 'int' | 'string' | 'keyword' | 'symbol' | 'eof';

export interface Token {
  kind: TokenKind;
  /** For strings: the decoded value. For everything else: the raw text. */
  value: string;
  raw: string;
  line: number;
  col: number;
  offset: number;
}

export const KEYWORDS = new Set([
  'machine',
  'locations',
  'agent',
  'observed',
  'observe',
  'from',
  'matching',
  'tools',
  'none',
  'invariant',
  'record',
  'initial',
  'final',
  'state',
  'writes',
  'prompt',
  'set',
  'limit',
  'visits',
  'else',
  'on',
  'otherwise',
  'not',
  'and',
  'or',
  'true',
  'false',
  'Bool',
  'Nat',
  'Int',
  'Text',
  'File',
]);

/** Longest match first — '<=' must beat '<', '->' must beat '-'. */
const SYMBOLS = [
  '->',
  '==',
  '!=',
  '<=',
  '>=',
  '..',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '<',
  '>',
  ':',
  ';',
  ',',
  '.',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '#',
];

export class LexError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number,
  ) {
    super(`line ${line}:${col}: ${message}`);
    this.name = 'LexError';
  }
}

function decodeString(raw: string): string {
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    switch (n) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '\\':
        out += '\\';
        break;
      case '"':
        out += '"';
        break;
      case "'":
        out += "'";
        break;
      default:
        out += n ?? '';
    }
  }
  return out;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const col = () => i - lineStart + 1;

  while (i < source.length) {
    const c = source[i];

    // whitespace
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }

    // comments
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const startLine = line;
      const startCol = col();
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\n') {
          line++;
          i++;
          lineStart = i;
          continue;
        }
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new LexError('unterminated block comment', startLine, startCol);
      continue;
    }

    const startLine = line;
    const startCol = col();
    const startOffset = i;

    // string
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        if (source[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (i >= source.length) {
        throw new LexError('unterminated string literal', startLine, startCol);
      }
      i++; // closing quote
      const raw = source.slice(startOffset, i);
      tokens.push({
        kind: 'string',
        value: decodeString(raw),
        raw,
        line: startLine,
        col: startCol,
        offset: startOffset,
      });
      continue;
    }

    // number
    if (c >= '0' && c <= '9') {
      while (i < source.length && source[i] >= '0' && source[i] <= '9') i++;
      const raw = source.slice(startOffset, i);
      tokens.push({
        kind: 'int',
        value: raw,
        raw,
        line: startLine,
        col: startCol,
        offset: startOffset,
      });
      continue;
    }

    // identifier / keyword — terminal ID: /[_a-zA-Z][\w_]*/
    if (/[_a-zA-Z]/.test(c)) {
      while (i < source.length && /[\w_]/.test(source[i])) i++;
      const raw = source.slice(startOffset, i);
      tokens.push({
        kind: KEYWORDS.has(raw) ? 'keyword' : 'id',
        value: raw,
        raw,
        line: startLine,
        col: startCol,
        offset: startOffset,
      });
      continue;
    }

    // symbol
    const sym = SYMBOLS.find((s) => source.startsWith(s, i));
    if (sym) {
      i += sym.length;
      tokens.push({
        kind: 'symbol',
        value: sym,
        raw: sym,
        line: startLine,
        col: startCol,
        offset: startOffset,
      });
      continue;
    }

    throw new LexError(`unexpected character ${JSON.stringify(c)}`, startLine, startCol);
  }

  tokens.push({
    kind: 'eof',
    value: '<eof>',
    raw: '',
    line,
    col: col(),
    offset: i,
  });
  return tokens;
}
