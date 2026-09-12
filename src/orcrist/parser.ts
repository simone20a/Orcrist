/**
 * Orcrist parser — recursive descent over the concrete syntax defined in
 * section 2 of orcrist.langium.
 *
 * One deliberate deviation: the body of an active state is parsed by
 * dispatching on the leading keyword rather than by rigid sequence, and the
 * grammar's required ordering (writes -> prompt -> assignments -> limit ->
 * transitions -> otherwise) is then checked and reported as a precise
 * diagnostic. A file that would not parse in Langium is still rejected; it just
 * gets a message naming the clause that is out of place instead of a bare
 * "unexpected token".
 */

import type {
  Assignment,
  Expr,
  Fallback,
  Field,
  Invariant,
  Location,
  LocationRef,
  Machine,
  Observation,
  Ownership,
  PromptPart,
  PromptTemplate,
  State,
  Transition,
  TypeRef,
  VisitLimit,
} from './ast';
import { LexError, tokenize, type Token } from './lexer';

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  col?: number;
}

export class ParseError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number,
  ) {
    super(`line ${line}:${col}: ${message}`);
    this.name = 'ParseError';
  }
}

export interface ParseResult {
  machine?: Machine;
  errors: Diagnostic[];
}

const BODY_ORDER: Record<string, number> = {
  writes: 0,
  tools: 1,
  prompt: 2,
  // observations run after the model's turn, so they sit between the prompt and
  // the assignments that may read what they measured
  observe: 3,
  set: 4,
  limit: 5,
  on: 6,
  otherwise: 7,
};

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private at(value: string): boolean {
    const t = this.peek();
    return (t.kind === 'keyword' || t.kind === 'symbol') && t.value === value;
  }

  private atAny(...values: string[]): boolean {
    return values.some((v) => this.at(v));
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private fail(expected: string): never {
    const t = this.peek();
    throw new ParseError(
      `expected ${expected} but found ${t.kind === 'eof' ? 'end of file' : JSON.stringify(t.raw)}`,
      t.line,
      t.col,
    );
  }

  private expect(value: string): Token {
    if (!this.at(value)) this.fail(JSON.stringify(value));
    return this.next();
  }

  private expectId(what: string): Token {
    const t = this.peek();
    if (t.kind !== 'id') this.fail(`${what} (an identifier)`);
    return this.next();
  }

  private expectString(what: string): Token {
    const t = this.peek();
    if (t.kind !== 'string') this.fail(`${what} (a quoted string)`);
    return this.next();
  }

  private optionalSemi(): void {
    if (this.at(';')) this.next();
  }

  // --- entry ----------------------------------------------------------

  parseMachine(): Machine {
    this.expect('machine');
    const name = this.expectId('the machine name').value;
    this.expect('{');

    const machine: Machine = { name, locations: [], invariants: [], states: [] };

    if (this.at('locations')) {
      this.next();
      this.expect('{');
      while (!this.at('}')) {
        if (this.peek().kind === 'eof') this.fail("'}' closing the locations block");
        machine.locations.push(this.parseLocation());
      }
      this.expect('}');
    }

    while (this.at('invariant')) {
      machine.invariants.push(this.parseInvariant());
    }

    while (!this.at('}')) {
      if (this.peek().kind === 'eof') this.fail("'}' closing the machine");
      machine.states.push(this.parseState());
    }
    this.expect('}');

    if (this.peek().kind !== 'eof') {
      this.fail('end of file (a file declares exactly one machine)');
    }
    return machine;
  }

  // --- store ----------------------------------------------------------

  private parseLocation(): Location {
    const line = this.peek().line;
    let ownership: Ownership = 'assignable';
    if (this.at('agent')) {
      this.next();
      ownership = 'agent';
    } else if (this.at('observed')) {
      this.next();
      ownership = 'observed';
    }
    const name = this.expectId('a location name').value;
    this.expect(':');
    const type = this.parseTypeRef();
    let init: Expr | undefined;
    if (this.at('=')) {
      this.next();
      init = this.parseExpr();
    }
    this.optionalSemi();
    return { ownership, agentOwned: ownership === 'agent', name, type, init, line };
  }

  private parseTypeRef(): TypeRef {
    if (this.atAny('Bool', 'Nat', 'Int', 'Text', 'File')) {
      const kind = this.next().value as 'Bool' | 'Nat' | 'Int' | 'Text' | 'File';
      let lower: number | undefined;
      let upper: number | undefined;
      if (this.at('[')) {
        this.next();
        lower = this.parseSignedInt();
        this.expect('..');
        upper = this.parseSignedInt();
        this.expect(']');
      }
      return { $type: 'PrimitiveType', kind, lower, upper };
    }
    if (this.at('record')) {
      this.next();
      this.expect('{');
      const fields: Field[] = [this.parseField()];
      while (this.at(',')) {
        this.next();
        fields.push(this.parseField());
      }
      this.expect('}');
      return { $type: 'RecordType', fields };
    }
    if (this.at('{')) {
      this.next();
      const literals: string[] = [this.expectId('an enum literal').value];
      while (this.at(',')) {
        this.next();
        literals.push(this.expectId('an enum literal').value);
      }
      this.expect('}');
      return { $type: 'EnumType', literals };
    }
    this.fail("a type (Bool, Nat, Int, Text, File, an enum '{ a, b }' or 'record { ... }')");
  }

  private parseField(): Field {
    const name = this.expectId('a field name').value;
    this.expect(':');
    return { name, type: this.parseTypeRef() };
  }

  private parseSignedInt(): number {
    let sign = 1;
    if (this.at('-')) {
      this.next();
      sign = -1;
    }
    const t = this.peek();
    if (t.kind !== 'int') this.fail('an integer');
    this.next();
    return sign * Number(t.value);
  }

  private parseInvariant(): Invariant {
    const line = this.peek().line;
    this.expect('invariant');
    let name: string | undefined;
    // 'invariant' (name=ID ':')? condition=Expr
    if (this.peek().kind === 'id' && this.peek(1).kind === 'symbol' && this.peek(1).value === ':') {
      name = this.next().value;
      this.next();
    }
    const condition = this.parseExpr();
    this.optionalSemi();
    return { name, condition, line };
  }

  // --- states ---------------------------------------------------------

  private parseState(): State {
    const line = this.peek().line;

    if (this.at('final')) {
      this.next();
      this.expect('state');
      const name = this.expectId('a state name').value;
      this.expect('{');
      if (!this.at('}')) {
        this.fail("'}' — a final state has an empty body");
      }
      this.expect('}');
      return {
        initial: false,
        final: true,
        name,
        writes: [],
        observations: [],
        assignments: [],
        transitions: [],
        line,
      };
    }

    let initial = false;
    if (this.at('initial')) {
      this.next();
      initial = true;
    }
    this.expect('state');
    const name = this.expectId('a state name').value;
    this.expect('{');

    const state: State = {
      initial,
      final: false,
      name,
      writes: [],
      observations: [],
      assignments: [],
      transitions: [],
      line,
    };

    let seenTools = false;
    let seenPrompt = false;
    let seenWrites = false;
    let lastOrder = -1;

    while (!this.at('}')) {
      const t = this.peek();
      if (t.kind === 'eof') this.fail(`'}' closing state ${name}`);
      const clause = t.value;
      const order = BODY_ORDER[clause];
      if (order === undefined) {
        this.fail(
          `one of 'writes', 'tools', 'prompt', 'observe', 'set', 'limit', 'on', 'otherwise' or '}' in state ${name}`,
        );
      }
      // ordering is part of the grammar; report it precisely rather than as a
      // generic token error
      if (order < lastOrder) {
        throw new ParseError(
          `'${clause}' clause appears after a clause that must follow it — a state body is ordered: writes, tools, prompt, observe…, set…, limit, on…, otherwise`,
          t.line,
          t.col,
        );
      }
      lastOrder = order;

      switch (clause) {
        case 'writes': {
          if (seenWrites) {
            throw new ParseError(`state ${name} declares 'writes' twice`, t.line, t.col);
          }
          seenWrites = true;
          this.next();
          state.writes.push(this.expectId('a location name').value);
          while (this.at(',')) {
            this.next();
            state.writes.push(this.expectId('a location name').value);
          }
          this.optionalSemi();
          break;
        }
        case 'tools': {
          if (seenTools) {
            throw new ParseError(`state ${name} declares 'tools' twice`, t.line, t.col);
          }
          seenTools = true;
          this.next();
          state.tools = [];
          if (this.at('none')) {
            this.next();
          } else {
            state.tools.push(this.expectId('a tool name').value);
            while (this.at(',')) {
              this.next();
              state.tools.push(this.expectId('a tool name').value);
            }
          }
          this.optionalSemi();
          break;
        }
        case 'observe': {
          state.observations.push(this.parseObservation());
          break;
        }
        case 'prompt': {
          if (seenPrompt) {
            throw new ParseError(`state ${name} declares 'prompt' twice`, t.line, t.col);
          }
          seenPrompt = true;
          this.next();
          this.expect(':');
          state.prompt = this.parsePromptTemplate();
          this.optionalSemi();
          break;
        }
        case 'set': {
          state.assignments.push(this.parseAssignment());
          break;
        }
        case 'limit': {
          if (state.limit) {
            throw new ParseError(`state ${name} declares 'limit' twice`, t.line, t.col);
          }
          state.limit = this.parseVisitLimit();
          break;
        }
        case 'on': {
          state.transitions.push(this.parseTransition());
          break;
        }
        case 'otherwise': {
          if (state.fallback) {
            throw new ParseError(`state ${name} declares 'otherwise' twice`, t.line, t.col);
          }
          state.fallback = this.parseFallback();
          break;
        }
      }
    }
    this.expect('}');

    if (!state.prompt) {
      throw new ParseError(
        `active state ${name} has no 'prompt' — every non-final state must ask the LLM something`,
        line,
        1,
      );
    }
    if (!state.fallback) {
      throw new ParseError(
        `active state ${name} has no 'otherwise' — every non-final state must have a catch-all exit`,
        line,
        1,
      );
    }
    return state;
  }

  private parsePromptTemplate(): PromptTemplate {
    const parts: PromptPart[] = [];
    while (this.peek().kind === 'string' || this.at('<')) {
      if (this.peek().kind === 'string') {
        parts.push({ $type: 'PromptText', value: this.next().value });
      } else {
        this.next(); // '<'
        const ref = this.parseLocationRef();
        this.expect('>');
        parts.push({ $type: 'Interpolation', ref });
      }
    }
    if (parts.length === 0) {
      this.fail('a prompt template (a string, optionally with <location> interpolations)');
    }
    return { parts };
  }

  private parseObservation(): Observation {
    const line = this.peek().line;
    this.expect('observe');
    const target = this.expectId('a location name').value;
    this.expect('from');
    const command = this.expectString('the command to run').value;
    let pattern: string | undefined;
    let fallback: Expr | undefined;
    if (this.at('matching')) {
      this.next();
      pattern = this.expectString('a regular expression, as a string').value;
    }
    if (this.at('else')) {
      this.next();
      fallback = this.parseExpr();
    }
    this.optionalSemi();
    return { target, command, pattern, fallback, line };
  }

  private parseAssignment(): Assignment {
    const line = this.peek().line;
    this.expect('set');
    const target = this.parseLocationRef();
    this.expect('=');
    const value = this.parseExpr();
    this.optionalSemi();
    return { target, value, line };
  }

  private parseVisitLimit(): VisitLimit {
    const line = this.peek().line;
    this.expect('limit');
    this.expect('visits');
    this.expect('<=');
    const t = this.peek();
    if (t.kind !== 'int') this.fail('an integer visit budget');
    this.next();
    this.expect('else');
    this.expect('->');
    const onExceeded = this.expectId('a state name').value;
    this.optionalSemi();
    return { maxVisits: Number(t.value), onExceeded, line };
  }

  private parseTransition(): Transition {
    const line = this.peek().line;
    this.expect('on');
    const guard = this.parseExpr();
    this.expect('->');
    const target = this.expectId('a state name').value;
    this.optionalSemi();
    return { guard, target, line };
  }

  private parseFallback(): Fallback {
    const line = this.peek().line;
    this.expect('otherwise');
    this.expect('->');
    const target = this.expectId('a state name').value;
    this.optionalSemi();
    return { target, line };
  }

  // --- expressions ----------------------------------------------------

  parseExpr(): Expr {
    return this.parseDisjunction();
  }

  private parseDisjunction(): Expr {
    let left = this.parseConjunction();
    while (this.at('or')) {
      this.next();
      left = { $type: 'Binary', left, op: 'or', right: this.parseConjunction() };
    }
    return left;
  }

  private parseConjunction(): Expr {
    let left = this.parseComparison();
    while (this.at('and')) {
      this.next();
      left = { $type: 'Binary', left, op: 'and', right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): Expr {
    const left = this.parseAdditive();
    if (this.atAny('==', '!=', '<=', '>=', '<', '>')) {
      const op = this.next().value;
      return { $type: 'Binary', left, op, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.atAny('+', '-')) {
      const op = this.next().value;
      left = { $type: 'Binary', left, op, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.atAny('*', '/', '%')) {
      const op = this.next().value;
      left = { $type: 'Binary', left, op, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.at('not')) {
      this.next();
      return { $type: 'Not', operand: this.parseUnary() };
    }
    if (this.at('-')) {
      this.next();
      return { $type: 'Neg', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    if (this.at('(')) {
      this.next();
      const e = this.parseExpr();
      this.expect(')');
      return e;
    }
    if (this.at('true')) {
      this.next();
      return { $type: 'BoolLit', value: true };
    }
    if (this.at('false')) {
      this.next();
      return { $type: 'BoolLit', value: false };
    }
    if (this.at('#')) {
      this.next();
      return { $type: 'EnumLit', value: this.expectId('an enum literal').value };
    }
    const t = this.peek();
    if (t.kind === 'int') {
      this.next();
      return { $type: 'NumLit', value: Number(t.value) };
    }
    if (t.kind === 'string') {
      this.next();
      return { $type: 'StringLit', value: t.value };
    }
    if (t.kind === 'id') {
      return this.parseLocationRef();
    }
    this.fail('an expression');
  }

  private parseLocationRef(): LocationRef {
    const t = this.expectId('a location name');
    const path: string[] = [];
    while (this.at('.')) {
      this.next();
      path.push(this.expectId('a field name').value);
    }
    return { $type: 'LocationRef', location: t.value, path, line: t.line };
  }
}

export function parse(source: string): ParseResult {
  try {
    const tokens = tokenize(source);
    const machine = new Parser(tokens).parseMachine();
    return { machine, errors: [] };
  } catch (err) {
    if (err instanceof ParseError || err instanceof LexError) {
      return {
        errors: [
          {
            severity: 'error',
            message: err.message.replace(/^line \d+:\d+: /, ''),
            line: err.line,
            col: err.col,
          },
        ],
      };
    }
    throw err;
  }
}
