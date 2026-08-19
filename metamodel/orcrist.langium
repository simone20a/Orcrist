// =====================================================================
// Orcrist — DSL for LLM-driven state machines
//
// File structure:
//   1. METAMODEL — declared AST types (Ecore equivalent)
//   2. GRAMMAR — concrete syntax that instantiates the metamodel
//   3. TERMINALS
//
// I vincoli non esprimibili in grammatica (ownership, tipi, totalita',
// determinismo, raggiungibilita') stanno nel validatore: vedi la lista
// in coda al file.
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

// ownership e' il cardine del linguaggio: determina chi puo' scrivere
// la locazione e quindi quanto e' affidabile una guardia che la legge.
// Due sole modalita':
//   agent (marcata)      : scritta dall'LLM -> guardia = self-report
//   assegnabile (default): scritta solo da 'set' -> guardia deterministica,
//                          calcolata dal runtime a partire dallo store
// Una locazione non puo' stare in entrambi i mondi: e' o l'una o l'altra.
interface Location {
    agentOwned: boolean
    name: string
    type: TypeRef
    init?: Expr
}

type TypeRef = PrimitiveType | EnumType | RecordType

interface PrimitiveType {
    kind: string        // 'Bool' | 'Nat' | 'Int' | 'Text' | 'File'
    lower?: number      // bound opzionali: rendono il modello finito
    upper?: number      // e quindi model-checkabile senza astrazione
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

// Due forme sintattiche distinte:
//   - stato finale : 'final state N {}', corpo vuoto, nessuna uscita;
//   - stato attivo : prompt e 'otherwise' OBBLIGATORI, cosi' ogni stato
//                    non terminale interroga l'LLM e ha sempre almeno
//                    un'uscita percorribile (nessun deadlock possibile).
// Nell'AST prompt e fallback restano opzionali perche' gli stati finali
// non li hanno: e' la grammatica a renderli obbligatori dove servono.
interface State {
    initial: boolean
    final: boolean
    name: string
    writes: @Location[]         // cosa produce il prompt; i bersagli dei
                                // 'set' sono gia' visibili nelle assignments,
                                // quindi il frame e' writes + quei bersagli
    prompt?: PromptTemplate
    assignments: Assignment[]   // eseguite in ordine, dopo il prompt
    limit?: VisitLimit          // fuel: garantisce terminazione strutturale
    transitions: Transition[]
    fallback?: Fallback         // 'otherwise'
}

// Il prompt e' un template con interpolazioni <nome.campo>: ogni
// riferimento va risolto contro le locazioni della macchina.
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

// L'unica forma di scrittura non-LLM: il bersaglio deve essere una
// locazione NON marcata 'agent'.
interface Assignment {
    target: LocationRef         // il path permette 'set tests.failed = 0'
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

// Negazione aritmetica. Senza, 'Int[-5..5]' si potrebbe dichiarare ma
// non si potrebbe mai scrivere -3: il terminale INT non ha segno e i
// bound usano SignedInt, che vive solo nella dichiarazione di tipo.
interface Neg {
    operand: Expr
}

// path permette l'accesso ai campi dei record: tests.failed
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
    (agentOwned?='agent')?
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
        'prompt' ':' prompt=PromptTemplate ';'?
        assignments+=Assignment*
        (limit=VisitLimit)?
        transitions+=Transition*
        fallback=Fallback
    '}';

// Il template e' tokenizzato in parti per poter risolvere e tipare
// ogni interpolazione invece di trattarla come testo opaco.
PromptTemplate returns PromptTemplate:
    parts+=PromptPart+;

PromptPart returns PromptPart:
      {PromptText}   value=STRING
    | {Interpolation} '<' ref=LocationRef '>';

Assignment returns Assignment:
    'set' target=LocationRef '=' value=Expr ';'?;

VisitLimit returns VisitLimit:
    'limit' 'visits' '<=' maxVisits=INT 'else' '->' onExceeded=[State:ID] ';'?;

Transition returns Transition:
    'on' guard=Expr '->' target=[State:ID] ';'?;

Fallback returns Fallback:
    'otherwise' '->' target=[State:ID] ';'?;

// --- Expressions: precedence by layering -----------------------------

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
// 3. TERMINALI
// =====================================================================

SignedInt returns number: '-'? INT;

terminal ID: /[_a-zA-Z][\w_]*/;
terminal INT returns number: /[0-9]+/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal WS: /\s+/;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;


// =====================================================================
// ESEMPI
// =====================================================================
//
// I modelli di esempio stanno in examples/ come file .orc, cosi'
// da essere parsabili e verificabili invece che restare commenti che
// divergono dalla grammatica:
//
//   minimal.orc             the smallest valid model
//   development-cycle.orc   specification / implementation / testing / triage
//   code-review.orc         oracle pattern and bounded cycles
//   trip-planner.orc        arithmetic guards and budget
//   moderation.orc          assignable record and single-field set
//   support-triage.orc      overview of all language constructs
