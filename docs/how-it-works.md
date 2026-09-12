<p align="center">
  <img src="../brand/orcrist-logo.png" alt="Orcrist" width="440">
</p>

# Orcrist Agent

A desktop coding agent whose runs are structured as **Orcrist state machines** instead of to-do lists.

You give it a task. Before doing anything, it authors an Orcrist model for that task — grounded in `metamodel/orcrist.langium` and `metamodel/authoring-guide.md`, read live from the repo — and then executes that machine one state at a time: each state's prompt goes to the model, the model works with real tools, reports the values that state is responsible for, and the machine's guards decide what happens next. The run ends when it reaches a `final` state.

The point is the one the authoring guide makes: a to-do list only contains what was explicitly asked for and has no answer for what happens when a step doesn't go as planned. A machine has to declare its failure paths, its retry budgets and its escalation states before the work starts.

```
orcrist/
├── metamodel/
│   ├── orcrist.langium        ← the grammar, ground truth for the authoring step
│   └── authoring-guide.md     ← the criteria the authoring step is told to follow
├── examples/*.orc             ← canonical syntax, shown to the authoring model
├── src/  electron/  scripts/  ← the app
└── brand/  screens/  docs/
```

The app finds those files by walking up from its own folder, so keep them at the root of the repo.

## Running it

```bash
npm install
npm start
```

`npm start` compiles the main process with `tsc`, bundles the renderer with Vite, and launches Electron. For iterative work, `npm run dev` runs the Vite dev server with hot reload and points Electron at it.

`npm test` parses and validates every `.orc` in `examples/`, checks that a set of deliberately-broken models is rejected for the right reasons, and runs a machine end to end against a scripted mock provider.

Then open **Settings → Providers** and put in an API key.

### If it says "Electron failed to install correctly"

`npm install` downloads the Electron binary in a postinstall step, and that step can fail on its own (network hiccup, a proxy, a GitHub rate limit) while the rest of the install reports success. The symptom is `node_modules/electron/` existing but with no `dist/` folder and no `path.txt`.

You don't need to reinstall everything — just re-run that one step:

```bash
npm run fix:electron
```

If the download fails again, the error message says why. Two common ones:

- **Behind a proxy** — set `HTTPS_PROXY` and retry.
- **GitHub unreachable or rate-limited** — use a mirror:
  `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm run fix:electron`

`npm run test` and `npm run build` do not need the binary, so you can check that the code is sound before sorting out the download.

## What you see

<img src="../screens/session.png" alt="A run in progress: the transcript on the left, the machine and its store on the right" width="100%">

*A run in progress, with the machine panel open: the thumbnail of the whole machine with the executing state lit, that state's details, and the live store.*

**Projects.** A project is a name plus a workspace folder. Every shell command and every file operation the agent performs is sandboxed to that folder — paths outside it are refused, not silently redirected. Sessions and run history live inside the workspace under `.orcrist-agent/`, so a project's history travels with the project.

**Sessions.** Inside a project you can open as many sessions as you like. A session is a conversation: every message you send runs, and the whole thing accumulates in one transcript — your message, the states the machine went through, the tools it used, the values it reported, where it ended.

**The machine belongs to the session, not the message.** The first message that needs one authors it. Every message after that is shown the current machine and decides what to do with it:

- **keep it** — the new message is more work of the kind the machine already describes, so it is re-run from its initial state with the new instruction ("now do the same for the docs folder");
- **revise it** — the message asks for a different *process*: another phase, a different retry budget, a new terminal outcome. The whole revised machine is emitted and replaces the old one;
- **replace it** — a different job altogether;
- **neither** — a single question with no process to it, answered by an ordinary agent loop with the same tools and the same log. Forcing a one-state machine onto "what does this function do" would be ceremony.

The transcript says which of these happened each time, and a revision is marked as such. Right-clicking a session in the list offers **Rename** and **Delete**; the delete confirmation says what goes with it. A session with a run going carries a spinner in the list with the name of the state it is executing beside it, so leaving it does not mean losing sight of it; opening another session does not disturb it — runs are read from the copy the main process holds in memory, which has every event, rather than from the disk copy, which is only written at a handful of checkpoints and would hand back a blank transcript for anything still in flight. Files the agent wrote in the workspace are never touched — only the session record. A run the app was executing when it closed is settled on the next read rather than left claiming to be in flight: it is marked cancelled and says it was interrupted, because nothing else would ever come along to correct it and the session would open showing a Stop button for a run that died with the process.

**What the model says is rendered as Markdown** — headings, lists, blockquotes, fenced and inline code, links, emphasis. The renderer is written out by hand in `src/renderer/components/Markdown.tsx` rather than pulled from npm: it builds React nodes directly and never touches `dangerouslySetInnerHTML`, so model output — which is untrusted text — has no HTML-injection surface to sanitise in the first place. Links open in the system browser, and only `http:`, `https:` and `mailto:` are followed; anything else stays inert text. A final answer that is a single line keeps the full weight of the ANSWER level, but one with structure to it drops to a reading weight at the same size — a dozen lines set in 700 stops being emphasis, and leaves bold nowhere to go inside it.

**Send and stop are the same button.** One mark sits beside the composer: a solid triangle while the session is idle, a solid square for as long as a run is going. Nothing behind either — no disc, no fill, no second colour — just the shape, in the same ink every other mark in the app is drawn in, so it belongs to the palette instead of sitting on top of it. The shape carries the whole difference; it does not need a colour as well. There is nothing else you can do from there while a run goes, so there is no reason to make you look elsewhere for the one thing you can: stop is in the place your hand is already going. Stopping leaves the transcript as it stands and marks the run cancelled.

Stop means stop: the cancel signal is carried into the provider adapters and aborts the HTTP request the model is answering on. Without that it would only land at the executor's next checkpoint — which is *after* the reply being composed right now, and against a real model a tool-using turn is easily a minute. The run then ends as cancelled rather than failed, because pressing Stop is not a fault and should not read like one in the log.

**A state's instruction arrives folded.** The transcript is read for what happened, not for what was asked, so the prompt a state was given shows its first two lines and opens on a click. The control to open it appears only when something is actually hidden, which means measuring the rendered box rather than the string — a two-line prompt with a "show more" under it would be a lie.

**The interface says little.** The screens carry almost no explanatory prose: the empty transcript is one faint line, the composer says "Message", the project list has no subtitle. What a machine is and how a session works are in this README, where they can be read once, rather than in text that has to be read past on every visit. Settings keeps its help — it is the one screen you arrive at not knowing what a field wants, and you arrive at it rarely.

**Scrollbars appear while you scroll and fade a moment after.** There is no CSS state for "is scrolling" and `:hover` is the wrong proxy — it would leave a bar on screen for as long as the pointer rests anywhere over the transcript — so a single capture-phase listener marks whichever element just scrolled and clears the mark after 900ms of quiet. The gutter is reserved either way, so nothing reflows when a thumb appears.

**Approval before execution.** A newly authored or revised machine is shown to you before anything runs: the whole machine drawn full size, and hovering a state shows the prompt that state will give, along with what it writes, what it sets, and every outgoing guard. That hover is the point of the dialog — a diagram of boxes and arrows tells you the shape of the process, but the prompts are what the model is actually asked to do, and a machine can be perfectly well-formed and still ask for the wrong thing.

Nothing is committed until you approve: a discarded machine leaves the session exactly as it was, rather than half-adopting a process you rejected, and the transcript invites you to send another message. A machine re-used unchanged is not asked about again — you already approved it. The gate can be switched off in Settings → Tools & limits.

**Settings** is three screens in the same language as the rest of the app, not a form. *Models* is the two roles the app has — the model that writes the machine and the model that runs it — each with its provider as a row of choices rather than a dropdown, the model id set at reading size, and a missing key said there rather than left for the run to discover. *Providers* is one block per provider: the key, the base URL, and a one-word answer to whether it can be called at all. *Tools & limits* is a list of things that are on or off, read as rows. Ruled fields, no boxes, and the same nine type levels the transcript uses.

**Palettes.** The whole app is drawn from six colours, each a role rather than a colour: `--brand` the field everything sits on, `--ink` every mark on it, `--accent` for "this went well", `--warn`, `--danger`, and `--marginalia` for the woodcut figures and nothing else. Every other value in the stylesheet — the recessed surfaces, the muted text, the hairlines, the colour of text on a filled shape — is derived from those six with `color-mix`, so a palette is swapped by writing six custom properties and nothing else. Settings → Palette shows the six that ship, each drawn as itself: the field behind, the ink set in it, the four role colours as dots. Picking one applies it to the window immediately, and cancelling puts back the one that was saved.

Four of them — Mint, Wheat, Mist and Lilac — come from a twelve-swatch board: four pale fields, four near-black inks, four mid-tones. Field and ink are the board's exactly, and they pair well on their own, between 8.9:1 and 12:1. The mid-tones are the ones that could not be used as they stand: drawn to sit on white, they fall to 2.1–3.5:1 as small text on a tinted field and on the recessed surfaces derived from it. So each keeps its *hue* and saturation and moves along lightness until it clears 4.5:1 on the recessed surface as well as on the field. The board's colour relationships survive; what changes is that a line of 13px prose is readable in them. Which role each mid-tone takes is fixed across the four, because a colour that means "this went well" in one palette cannot mean "attend to this" in the next. One palette, Pine, runs dark — the recessed surfaces step from the field *towards* the ink, so they lighten instead of darkening without that case being special anywhere in the CSS.

The contrast audit runs all eleven screens under each palette, and it earned its keep here: three alpha constants that were fine at sage's 12:1 failed at 9:1 — the empty-state watermark, a label in the machine thumbnail, and two lines in the diagram tooltip. They are now set for the least contrasty palette the app ships rather than for the default, which is the only way a constant like that survives a theme swap.

**The machine panel** is a drawer on the right, hidden by default — the transcript is what you read, the machine is what you check. The icon at the right of the session header opens it, and it remembers whether you left it open. Inside: a low-detail thumbnail of the whole machine with the executing state lit; the details of that state — which visit this is against its `limit`, what it `writes`, what it `set`s, and every outgoing transition with its guard; and the live store, each location marked by who writes it — a filled circle for agent-owned (the model reports it), a square for observed (the runtime measures it with a command), a hollow circle for assignable (the runtime derives it with a `set`). While a state is executing, its name appears in the title bar immediately left of that icon — the one thing up there that comes and goes, which is most of how you notice it — so you can follow along with the drawer shut, and click it to open the drawer. Nothing sits above the transcript any more: the name is a fact about the machine, so it belongs beside the control that opens the machine rather than in a strip of its own.

## Tools

| Tool | What it does |
|---|---|
| `run_command` | Shell, working directory = workspace, with a configurable blocklist and timeout |
| `read_file` / `write_file` / `edit_file` / `list_directory` | Filesystem, sandboxed to the workspace |
| `web_fetch` | Fetch a URL, HTML stripped to readable text |
| `web_search` | Web search, returns title / URL / snippet |
| `report_state_writes` | Built per state from its `writes` clause — see below |

Shell and web can be switched off in Settings. The file tools are always on and always sandboxed.

A state may narrow this list with a `tools` clause — `tools run_command, read_file;` or `tools none;` — and then its turn is handed only those. It is how a prohibition in a prompt ("fix nothing") becomes a fact about the turn: an instruction can be ignored, a tool that was never handed over cannot be called. A name that is not a tool is an authoring-time error, not a state that quietly runs with less than its prompt assumes.

### `report_state_writes`

This is how agent-owned values get into the store. For each state, a tool is generated whose JSON Schema comes from the declared type of every location in that state's `writes` — an enum location becomes an `enum` schema, a `Nat[0..50]` becomes an integer with `minimum`/`maximum`, a record becomes a nested object with required fields. The model must call it once, last. Values that don't match the declared type are rejected with an explanation and the model is asked again.

The alternative — parsing values out of the model's prose — is what the store cannot afford to depend on, because the store is what guards are evaluated over.

### Reading the store, which is not a tool

Writing the store is a tool call, so a model finds it whether or not anything explains it — the schema arrives with the turn. Reading it is the asymmetry: values reached the model only where the machine's author thought to interpolate one, and a model that wanted a value nobody interpolated had nowhere to look. Smaller models resolved that by inventing a value, or by asking the user, or by hunting for a `read_state` tool that does not exist.

So every state message now ends with the store as it stands, one line per location: its current value or `(not set yet)`, who last wrote it (reported / measured / derived), and a mark on the ones this state is responsible for reporting. Values are clipped to 180 characters, since a `Text` location can hold a whole specification and the point of the block is what is set, not what it says.

The execution system prompt states the same thing in prose — that there is no tool for reading the store and none for moving between states, both being the runtime's job — and lists every tool by name with a line each, built from the toolset the run actually has. A schema can say what a tool does; only the prose can say what has no tool at all, and that is the half a weaker model needs told.

## Models and providers

Two model choices, set separately in Settings:

- **Authoring model** — turns your prompt into a machine. Worth giving this the strongest model you have: the machine shapes the whole run.
- **Execution model** — runs each state.

Anthropic, OpenAI and local Ollama are supported, each with its own base URL so a gateway or proxy can be pointed at instead.

<img src="../screens/settings.png" alt="Settings: the two model roles, with the locally installed Ollama models listed under the execution role" width="100%">

*Point a role at Ollama and the models installed on the machine are listed under it. If the server is not answering, the panel says so where the question was asked rather than in a toast that disappears.*

The OpenAI adapter adjusts itself to the model rather than carrying a table of which model accepts what:

- A 400 that names a parameter we sent (`temperature` on a reasoning model, `max_completion_tokens` on an older one) makes it drop that parameter and retry.
- A 400 saying function tools need `/v1/responses` — which is what the reasoning models say — makes it switch to the Responses API and stay there for the session. The alternative the API offers is turning reasoning off, which would be the worse trade here: planning a state's work is exactly what reasoning is for.

Requests to the Responses API are sent with `store: false`. The full history goes up on every call anyway, so there is nothing to gain from server-side threading, and this app handles your source code.

## The language implementation

`src/orcrist/` is a hand-written TypeScript implementation of `orcrist.langium` — lexer, recursive-descent parser, type checker, validator, evaluator and thumbnail layout. It is not generated from the grammar by Langium; the grammar is the specification it was written against, and `npm test` checks it against the bundled examples.

The validator implements the constraints the grammar deliberately leaves out (they're listed in the trailing comment of `orcrist.langium` and elaborated in the guide):

- **ownership** — `writes` only on `agent` locations, `observe` only on `observed` ones, `set` only on assignable ones
- **typing** — guards, assignments and initialisers type-check; enum literals belong to their enum; record paths exist; declared bounds are respected
- **totality** — every active state has a prompt and an `otherwise`; every reference resolves
- **determinism** — outgoing guards from one state must not be identical *(heuristic — see limitations)*
- **reachability** — every state reachable from `initial`, and every state able to reach a `final`
- **termination** — every state on a cycle must carry a `limit`

Warnings cover the softer advice in the guide: unbounded numerics, guards that read agent-owned data, invariants written over what the model claims rather than what is checked, a prompt that interpolates a location it can't write.

### The authoring loop

The authoring model gets the grammar, the guide and the examples verbatim — about 87% of that prompt is read off disk rather than written in the app, so editing the language changes what the model is grounded in — followed by a ten-step procedure for building a machine out of a task: name the outcomes, list the capabilities, turn each into a build sub-task, ask of each what command would prove it works (that proof is its own state, and the pair is a bounded loop), order by dependency, pull decisions in front of the code, give any check that cannot name a culprit a state that only adjudicates, treat every default as a claim, fuel every loop, and only then write syntax. It must answer with either `NO_MACHINE: <reason>` or a plan plus a fenced `orcrist` block. Whatever comes back goes through the same parser and validator the rest of the app uses; if it doesn't validate, the diagnostics are fed back and it tries again, up to three times. A model that doesn't parse is worth nothing downstream, so this is a repair loop rather than a single hopeful shot.

### Holding the state boundary

A machine only means anything if the model executing it stays inside the state it is in. A capable model infers that from the shape of the conversation; a smaller one reads an instruction, sees the rest of the job, and does the rest of the job — implementing *and* testing while the machine still thinks it is implementing. Nothing downstream can recover from that: the store records only what the current state declared it writes, so the work happens, and the machine never learns it did.

So the boundary is stated three times over, at decreasing distance from where the model is looking.

The two prompts divide the subject cleanly: how a machine is *built* is the authoring prompt's business, and how one is *run* is the execution prompt's. The authoring prompt knows only as much about execution as it needs to write prompts that survive it — that the agent obeys its instruction literally and cannot see the other states — and states that as a constraint on writing, not as an explanation of the runtime.

1. **The execution system prompt** argues it: you run one state at a time, you cannot move yourself between states — the runtime reads the store, evaluates the guards and sends the next instruction — stopping when the instruction is done is correct rather than lazy, and work done outside the current state is worse than wasted, because the machine may branch away from it, re-enter this state and repeat it, or reach the state that owns it and order it done again, now against a codebase that has already changed. The "verify what you changed" advice a coding agent normally gets is withdrawn while a machine is running, since verification is some state's job and helping yourself to it is the failure this is preventing.

2. **Every state message repeats it**, right under the instruction, and names the states the machine can go to next — the concrete form is what a weaker model acts on, because "do not run the tests, `Test` is a separate state" needs no generalising. Final states are left out (they are outcomes, not work), and so are the guards: naming where the machine can go makes the boundary real, but naming what sends it there would invite the model to report the value that gets it where it wanted to go.

3. **The authoring prompt** is told how execution works, so that it writes prompts the boundary can survive. One state, one job: a prompt reading "implement the change and make sure the tests still pass" collapses two phases into one state and the agent will obey it. And each prompt must stand alone, since the executing model never sees the machine — "if the check above failed" refers to something it cannot read.

### Claims, measurements and derivations

Holding the boundary keeps a weak model inside its state. It does nothing about the other half of the problem: a model that stays inside its state and reports that everything passed. A guard over an agent-owned location tests what the model *said*, and a model that is confused, out of context or simply agreeable says the run is finished.

So a location can instead be declared `observed`, and written by the runtime rather than by the model:

```
observed failures: Nat[0..500] = 500;

state Check {
    tools run_command, read_file;
    prompt: "Run the suite and summarise what failed. Fix nothing.";
    observe failures from "npm test 2>&1 | grep -c '^not ok'" else 500;
    on failures == 0 -> Done;
    otherwise -> Implement;
}
```

The command runs in the workspace after the state's turn and before that state's `set` assignments, so a derived value is computed from what was just measured. With a `matching` pattern the first capture group is converted to the location's declared type; without one the exit code is taken — as a `Bool` that means "the command succeeded", which is the one place the shell's convention and the language's are inverted. `else` supplies the value for "this could not be established", and it applies both when nothing matched and when the command could not be run at all, so a failed measurement can never leave the previous round's number standing where a guard will read it as current.

That gives three owners, and the mode a location is declared in is what a guard reading it is actually testing:

| mode | written by | the guard tests |
| --- | --- | --- |
| `agent` | the model, via `writes` | what it **claimed** |
| `observed` | the runtime, via `observe` | what the world **did** |
| assignable | the runtime, via `set` | a value **derived** from the store |

The authoring model is the one that decides which is which, and that is the division of labour the whole design rests on: deciding *what would count as proof* is judgment, the executing model is the one that lacks it, and an `observe` clause is that judgment written down once and then applied mechanically on every visit. The same applies to `tools` — the strong model decides what the weak one is allowed to touch in each state.

## Limits and safety

On top of the language's own `limit` construct there are two structural caps, both configurable: 150 state transitions per run and 20 tool rounds per state. A machine can be perfectly well-formed and still be handed to a model that loops.

## Known limitations

- **Guard-overlap checking is a heuristic.** It catches two transitions with *identical* guards, not two guards that can both be true (`x > 5` and `x > 3`). Doing that properly wants an SMT solver over the declared finite domains; the `Nat[a..b]` and enum bounds the language insists on are exactly what would make that tractable, and it is the most worthwhile next piece of work here.
- **`web_search` scrapes DuckDuckGo's HTML results page.** No API key needed, but it breaks if that markup changes. The tool says so in its output rather than returning silence.
- **Ollama tool-calling depends on the model.** With a local model that doesn't support tools, states can't report their writes and the run degrades badly. Pick one that does.
- **One run at a time per session** in the UI. Past runs stay browsable through the run picker.
- **No packaging yet.** `npm start` runs it from source; there's no `.app` bundle.
- **Conversation history is unbounded within a run.** A long machine on a large codebase will grow the context until the provider refuses it. Trimming old tool results is the obvious fix and isn't done.

## Layout

```
electron/main.ts        window, IPC handlers, provider wiring
electron/preload.ts     the contextBridge API surface
src/orcrist/            lexer, parser, typing, validator, evaluator, layout
src/core/               executor, authoring, tools, storage, LLM providers
src/renderer/           React UI (projects, sessions, FSM column, log, settings)
scripts/selftest.ts     npm test
```
