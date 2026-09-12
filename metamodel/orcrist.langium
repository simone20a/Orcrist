// =====================================================================
// Orcrist — a DSL for state machines whose states are executed by an LLM
//
// File structure:
//   1. METAMODEL   — the declared AST types (the Ecore equivalent)
//   2. GRAMMAR     — the concrete syntax that instantiates the metamodel
//   3. TERMINALS
//
// The constraints a grammar cannot express (ownership, typing, totality,
// determinism, reachability) live in the validator: see the list at the
// end of this file.
// =====================================================================

grammar Orcrist

// =====================================================================
// 1. METAMODEL
// =====================================================================

interface Machine {
    name: string
    locations: Location[]
    invariants: Invariant[]
    states: State[]
}

// --- Store -----------------------------------------------------------

// Ownership is the hinge of the language: it decides who may write a
// location, and therefore how much a guard that reads it can be trusted.
// There are exactly three modes, and a location is in exactly one:
//   agent (marked)       : written by the LLM through 'writes' -> a guard
//                          reading it tests what the model CLAIMED
//   observed (marked)    : written by an 'observe' clause, which runs a
//                          command and takes its exit code or a capture from
//                          its output -> a guard reading it tests what the
//                          world DID
//   assignable (default) : written only by 'set' -> a deterministic guard,
//                          computed by the runtime from the store
//
// The middle one is what keeps a machine honest when the executing model is
// weak: a claim can be wrong and the machine will branch on it with full
// confidence, whereas a measurement is a measurement.
interface Location {
    ownership: string   // 'agent' | 'observed' | 'assignable'
    name: string
    type: TypeRef
    init?: Expr
}

type TypeRef = PrimitiveType | EnumType | RecordType

interface PrimitiveType {
    kind: string        // 'Bool' | 'Nat' | 'Int' | 'Text' | 'File'
    lower?: number      // optional bounds: they keep the model finite
    upper?: number      // and so model-checkable without abstraction
}

interface EnumType {
    literals: string[]
}

interface RecordType {
    fields: Field[]
}

interface Field {
    name: string
    type: TypeRef
}

interface Invariant {
    name?: string
    condition: Expr
}

// --- States ----------------------------------------------------------

// Two distinct syntactic forms:
//   - final state  : 'final state N {}', empty body, no way out;
//   - active state : prompt and 'otherwise' are MANDATORY, so every
//                    non-terminal state asks the LLM something and always
//                    has at least one exit it can take (no deadlock).
// In the AST prompt and fallback stay optional because final states do not
// have them: it is the grammar that makes them mandatory where they belong.
interface State {
    initial: boolean
    final: boolean
    name: string
    writes: @Location[]         // what the prompt produces; the targets of
                                // 'set' are already visible in assignments,
                                // so the frame is writes + those targets
    tools?: string[]            // the tools this state may use; absent means
                                // all of them. A boundary a model cannot
                                // cross by ignoring an instruction.
    prompt?: PromptTemplate
    observations: Observation[] // run after the model's turn, before 'set'
    assignments: Assignment[]   // run in order, after the observations
    limit?: VisitLimit          // fuel: it guarantees structural termination
    transitions: Transition[]
    fallback?: Fallback         // 'otherwise'
}

// A measurement taken by the runtime, not a value asked of the model. The
// command runs in the workspace; with no 'matching' pattern the value is the
// exit code (as a Bool, success is exit 0), and with one it is capture group 1
// of the first match. 'else' says what to use when the command ran but the
// pattern found nothing — a decision the model author has to make, because
// "no match" reads as zero for some tools and as breakage for others.
interface Observation {
    target: @Location       // must be declared 'observed'
    command: string
    pattern?: string        // a regular expression, as a string
    fallback?: Expr
}

// A prompt is a template with <name.field> interpolations: every reference
// has to resolve against the machine's locations.
interface PromptTemplate {
    parts: PromptPart[]
}

type PromptPart = PromptText | Interpolation

interface PromptText {
    value: string
}

interface Interpolation {
    ref: LocationRef
}

// The only non-LLM form of writing: the target must be a location that is
// NOT marked 'agent'.
interface Assignment {
    target: LocationRef         // the path is what allows 'set tests.failed = 0'
    value: Expr
}

interface VisitLimit {
    maxVisits: number
    onExceeded: @State
}

interface Transition {
    guard: Expr
    target: @State
}

interface Fallback {
    target: @State
}

// --- Expressions -----------------------------------------------------

type Expr = Binary | Neg | Not | LocationRef | EnumLit | BoolLit | NumLit | StringLit

interface Binary {
    left: Expr
    op: string
    right: Expr
}

interface Not {
    operand: Expr
}

// Arithmetic negation. Without it 'Int[-5..5]' could be declared but -3
// could never be written: the INT terminal is unsigned, and the bounds use
// SignedInt, which exists only in the type declaration.
interface Neg {
    operand: Expr
}

// path gives access to record fields: tests.failed
interface LocationRef {
    location: @Location
    path: string[]
}

interface EnumLit {
    value: string
}

interface BoolLit  { value: boolean }
interface NumLit   { value: number }
interface StringLit { value: string }


// =====================================================================
// 2. GRAMMAR (concrete syntax)
// =====================================================================

entry Machine returns Machine:
    'machine' name=ID '{'
        ('locations' '{'
            locations+=Location*
        '}')?
        invariants+=Invariant*
        states+=State*
    '}';

Location returns Location:
    (ownership=('agent' | 'observed'))?
    name=ID ':' type=TypeRef
    ('=' init=Expr)?
    ';'?;

TypeRef returns TypeRef:
    PrimitiveType | EnumType | RecordType;

PrimitiveType returns PrimitiveType:
    kind=('Bool' | 'Nat' | 'Int' | 'Text' | 'File')
    ('[' lower=SignedInt '..' upper=SignedInt ']')?;

EnumType returns EnumType:
    '{' literals+=ID (',' literals+=ID)* '}';

RecordType returns RecordType:
    'record' '{' fields+=Field (',' fields+=Field)* '}';

Field returns Field:
    name=ID ':' type=TypeRef;

Invariant returns Invariant:
    'invariant' (name=ID ':')? condition=Expr ';'?;

State returns State:
    FinalState | ActiveState;

FinalState returns State:
    final?='final' 'state' name=ID '{' '}';

ActiveState returns State:
    (initial?='initial')?
    'state' name=ID '{'
        ('writes' writes+=[Location:ID] (',' writes+=[Location:ID])* ';'?)?
        ('tools' ('none' | tools+=ID (',' tools+=ID)*) ';'?)?
        'prompt' ':' prompt=PromptTemplate ';'?
        observations+=Observation*
        assignments+=Assignment*
        (limit=VisitLimit)?
        transitions+=Transition*
        fallback=Fallback
    '}';

// The template is tokenized into parts so that every interpolation can be
// resolved and typed, instead of being treated as opaque text.
PromptTemplate returns PromptTemplate:
    parts+=PromptPart+;

PromptPart returns PromptPart:
      {PromptText}   value=STRING
    | {Interpolation} '<' ref=LocationRef '>';

Observation returns Observation:
    'observe' target=[Location:ID] 'from' command=STRING
    ('matching' pattern=STRING)?
    ('else' fallback=Expr)? ';'?;

Assignment returns Assignment:
    'set' target=LocationRef '=' value=Expr ';'?;

VisitLimit returns VisitLimit:
    'limit' 'visits' '<=' maxVisits=INT 'else' '->' onExceeded=[State:ID] ';'?;

Transition returns Transition:
    'on' guard=Expr '->' target=[State:ID] ';'?;

Fallback returns Fallback:
    'otherwise' '->' target=[State:ID] ';'?;

// --- Expressions: precedence by stratification ------------------------

Expr returns Expr:
    Disjunction;

Disjunction returns Expr:
    Conjunction ({Binary.left=current} op='or' right=Conjunction)*;

Conjunction returns Expr:
    Comparison ({Binary.left=current} op='and' right=Comparison)*;

Comparison returns Expr:
    Additive ({Binary.left=current}
        op=('==' | '!=' | '<=' | '>=' | '<' | '>')
        right=Additive)?;

Additive returns Expr:
    Multiplicative ({Binary.left=current} op=('+' | '-') right=Multiplicative)*;

Multiplicative returns Expr:
    Unary ({Binary.left=current} op=('*' | '/' | '%') right=Unary)*;

Unary returns Expr:
      {Not} 'not' operand=Unary
    | {Neg} '-' operand=Unary
    | Primary;

Primary returns Expr:
      '(' Expr ')'
    | {BoolLit}   (value?='true' | 'false')
    | {NumLit}    value=INT
    | {StringLit} value=STRING
    | {EnumLit}   '#' value=ID
    | LocationRef;

LocationRef returns LocationRef:
    location=[Location:ID] ('.' path+=ID)*;


// =====================================================================
// 3. TERMINALS
// =====================================================================

SignedInt returns number: '-'? INT;

terminal ID: /[_a-zA-Z][\w_]*/;
terminal INT returns number: /[0-9]+/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal WS: /\s+/;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;


// =====================================================================
// EXAMPLES
// =====================================================================
//
// The example models live in examples/ as .orc files, so that they are
// parseable and checkable rather than comments that drift away from the
// grammar:
//
//   minimo.orc              the smallest possible valid model
//   ciclo-sviluppo.orc      spec / implementation / test / triage
//   revisione-codice.orc    the oracle pattern, every loop bounded
//   pianifica-viaggio.orc   arithmetic in guards, a budget
//   moderazione.orc         an assignable record, 'set' on one field
//   triage-assistenza.orc   a tour of every construct
//   verifica-misurata.orc   'observed' locations and per-state 'tools'


// =====================================================================
// 4. THE CONSTRAINTS THE GRAMMAR DOES NOT EXPRESS
// =====================================================================
//
// A grammar can say what a model looks like; it cannot say what makes one
// sound. Everything below is checked by the validator (src/orcrist/
// validator.ts) on the parsed AST, and the same list is what the authoring
// guide elaborates. Errors reject the model; warnings are reported and let
// it run.
//
// --- ownership -------------------------------------------------------
//   E  'writes' may name only a location declared 'agent'.
//   E  'set' may name only an assignable location (unmarked) — never an
//      'agent' or 'observed' one.
//   E  'observe' may target only a location declared 'observed'.
//   W  a location declared 'observed' that no state observes: it can only
//      ever hold its initial value.
//   W  a location nothing ever writes (no 'writes', no 'observe', no
//      'set', no initialiser).
//
// --- observations ----------------------------------------------------
//   E  'observe' naming an unknown location.
//   E  an empty command.
//   E  a 'matching' pattern that is not a valid regular expression, or
//      that has no capture group.
//   E  a Text target with no 'matching' pattern: an exit code cannot be
//      converted to text.
//
// --- typing ----------------------------------------------------------
//   E  a guard, an invariant or an initialiser that is not well typed.
//   E  a 'set' whose value does not fit the target's declared type.
//   E  an initial value outside a declared [lower..upper] bound, an empty
//      bound, a negative lower bound on a Nat, a bound on a non-numeric
//      type, duplicate enum literals, duplicate record fields.
//   E  an interpolation naming an unknown location or a path that the
//      location's type does not have.
//
// --- totality --------------------------------------------------------
//   E  an active state with no prompt text.
//   E  a transition, fallback or 'limit ... else' naming an unknown state.
//   E  exactly one 'initial' state; at least one 'final' state.
//   (The parser already rejects an active state with no 'prompt' or no
//    'otherwise' — totality of the transition relation is syntactic.)
//
// --- determinism (heuristic) -----------------------------------------
//   W  two outgoing guards from one state that can hold at once, so the
//      run's next state depends on the order they were written in.
//   W  a guard that is a tautology or a contradiction over its location's
//      declared domain.
//
// --- reachability ----------------------------------------------------
//   E  a state unreachable from the initial state.
//   E  a state from which no path reaches a final state.
//
// --- termination -----------------------------------------------------
//   E  a cycle (a strongly connected component with an edge inside it)
//      none of whose states carries a 'limit'. The budget belongs to the
//      loop, not to the state: one 'limit' anywhere on the cycle bounds
//      it.
//   E  'limit visits <= 0', or an 'else' that points back at the state
//      whose budget it releases.
