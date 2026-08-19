# The Orcrist language

This is the reference for the **Orcrist DSL**, used to write the state-machine
model that the coding agent loads and executes. Model files use the `.orc`
extension. The Langium grammar is in
[`metamodel/orcrist.langium`](../metamodel/orcrist.langium). For the
application overview, see the [README](../README.md).

## File structure

A model has one `machine` block, optional `locations`, zero or more
`invariant` declarations, and one or more `state` declarations:

```orcrist
machine MachineName {
    locations {
        // location declarations
    }

    invariant optional_name: <boolean expression>;

    initial state First {
        prompt: "...";
        otherwise -> Done;
    }

    final state Done {}
}
```

There must be exactly one `initial` state and at least one `final` state.

## Store locations

Every `location` is a named cell in the machine's global state. Its ownership
determines who may write it:

| Ownership | Declaration | Writer | Guard reliability |
|---|---|---|---|
| **agent** | `agent name: Type;` | The LLM, via `report` | Self-report |
| **assignable** (default) | `name: Type;` | Runtime `set` only | Deterministic |

```orcrist
locations {
    agent specification: Text;
    agent tests: record { total: Nat, passed: Nat, failed: Nat };

    attempts: Nat[0..10] = 0;
    booked: Bool = false;
}
```

An initializer is allowed only on assignable locations and must be a constant
expression. Assignable records cannot be initialized because the language has
no record literals; initialize their fields with `set` in the initial state.

## Types and expressions

```text
Bool
Nat                  Nat[0..3]        // optional bounds make the model finite
Int                  Int[-5..5]
Text
File                                  // path confined to the project workspace
{ first, second }                     // enum literals are written #first
record { field1: Type, field2: Type }
```

Bounds are semantic, not decorative: values outside a `Nat` or `Int` domain
are mapped back into the domain and reported. Record fields use dot notation,
such as `tests.failed`; a field is the only granularity at which a record may
be assigned.

Operators, from highest to lowest precedence, are unary `not` and `-`,
multiplicative `*` `/` `%`, additive `+` `-`, comparisons, `and`, and
`or`. Comparisons are non-associative, so `a < b < c` is invalid.

## States and execution

```orcrist
final state Done {}

initial state Work {
    writes result;
    prompt: "Inspect the request: " <request>;
    set attempts = attempts + 1;
    limit visits <= 5 else -> Fallback;
    on result == #retry -> Work;
    otherwise -> Done;
}
```

Non-final states must have both `prompt` and `otherwise`, so they always call
the LLM and always have a traversable exit.

- `writes` declares the `agent` locations the LLM must provide through
  `report` when the agent loop ends.
- `prompt` is a string template with typed `<location>` or
  `<location.field>` interpolation.
- `set` is the only way to write an assignable location. Assignments run in
  source order after the prompt and optional `report`.
- `limit` is structural fuel. Once exceeded, the machine transitions without
  asking the LLM.
- `on` guards are evaluated in source order; the first true guard wins.
- `otherwise` is the required fallback.

For every step, Orcrist counts the visit, renders the prompt, runs the agent
loop, processes `report`, performs `set` assignments, checks invariants, and
then evaluates guards. Violations are recorded rather than silently corrected.

## Read/write boundary

The agent can read every location, including individual record fields, using
`read_location`. It can write only the `agent` locations declared in the
current state's `writes`, and only through `report`. File writes, shell
commands, and free-form response text are not alternate global-state channels.

## Validation

The validator rejects invalid ownership (`set` on `agent` locations or
`writes` on assignable locations), incompatible types, unknown enum literals
or record fields, non-constant initializers, invalid initial/final-state
structure, unreachable finals, and self-referential limits. It warns about
dead code, duplicate or always-true guards, unbounded cycles, and assignable
locations that no state writes. A model with validation errors cannot compile.

## Minimal model

```orcrist
machine Minimal {
    initial state Ask {
        prompt: "Greet the user and ask how you can help.";
        otherwise -> Done;
    }

    final state Done {}
}
```

## Grammar cheat sheet

```text
machine <ID> { locations { ... } <invariant>* <state>* }
<location> ::= 'agent'? <ID> ':' <TypeRef> ('=' <Expr>)? ';'?
<state>    ::= 'final' 'state' <ID> '{' '}'
             | 'initial'? 'state' <ID> '{' ... '}'
<path>     ::= <ID> ('.' <ID>)*
<Expr>     ::= disjunction(conjunction(comparison(additive(multiplicative(unary)))))
```

