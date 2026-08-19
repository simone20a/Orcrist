<p align="center">
  <img src="build/icon.png" alt="Orcrist dwarf icon" width="112" />
</p>

<h1 align="center">Orcrist Coding Agent</h1>

<p align="center">A state-machine-driven coding agent with a focused graphical interface.</p>

Orcrist replaces the usual prompt box with the state machine that defines the
agent's behaviour. Models are written in the **Orcrist DSL** (`.orc`), parsed
and validated with Langium, rendered as a graph, and then executed. Each active
state invokes an LLM with workspace-confined tools; transitions are guards over
the global state.

The complete language reference, including syntax, types, execution semantics,
and validation rules, is available in [the DSL documentation](docs/dsl.md).


![](./res/demoVideo.gif)


## Getting started

```bash
npm install          # Downloads Electron too; access to github.com is required.
npm run dev          # Development mode with hot reload.
npm run build        # Production bundle in out/.
npm run dist         # Installable application in release/.
npm test             # Type-checking, examples, conformance, and dry-run tests.
npm run conformance  # DSL conformance tests only.
```

On first launch, open **API Keys** and configure at least one LLM provider.
Keys are protected by the operating system keychain and are never exposed to
the renderer. A Tavily key is optional and enables web search; without it, the
agent works offline on workspace files only.

## Projects and runs

A project consists of a name, a workspace directory, and a validated `.orc`
model. The workspace is the boundary beyond which the agent cannot read or
write. A project cannot be created until its model compiles successfully.

The run view shows the state-machine graph. Drag the canvas to pan, use the
mouse wheel to zoom, and drag individual nodes to persist their positions. The
currently executing state is highlighted in gold. Selecting a state opens its
rendered prompt and chronological activity log.

The log records actions rather than free-form LLM output: tool invocations and
global-location writes. It distinguishes an `agent` self-report sent through
`report` from a value calculated by a `set` assignment.

`ask_user` pauses execution and displays a panel at the bottom of the window.
The model can request an open response, a single choice, or multiple choices.
The user can answer, skip, or stop the run; a system notification is shown when
the application is not in the foreground.

## Agent tools

| Tool | Purpose |
|---|---|
| `list_dir`, `read_file`, `write_file`, `edit_file`, `search`, `delete_file` | Workspace file operations, all sandboxed. |
| `read_location` | Reads any global-state location, including read-only locations. |
| `run_command` | Shell command in the workspace; disabled by default per project. |
| `web_search`, `fetch_url` | Tavily-powered search and page extraction; require a Tavily key. |
| `ask_user` | Asks the person using the application a question and waits. |
| `report` | The only way for an LLM to write global state; closes the state with its declared `writes`. |

Web operations are mediated by Tavily: the agent does not directly open an
arbitrary network connection. `fetch_url` truncates extracted content to
24,000 characters.

## Visual identity

The icon, splash screen, and status-bar animation share the same pixel dwarf.
Sprites and application icons are generated from drawing primitives:

```bash
python3 scripts/make-sprites.py --png /tmp/dwarf.png
python3 scripts/make-sprites.py --ts > src/renderer/pixel/dwarf.ts
npm run icon
python3 scripts/make-icon.py --preview /tmp/icon.png
```

## Sampling settings

Temperature is optional and is omitted by default because some recent models
reject requests merely containing the parameter. Leave it blank to use the
provider default; use `0` for repeatable runs where the provider still permits
it.

## Project structure

```
src/
  shared/       IR, IPC protocol, and event reducer
  language/     Langium services, type system, validator, IR lowering
  main/         Electron main process, LLM adapters, runtime, storage, and web client
  preload/      Typed IPC surface
  renderer/     React user interface, graph, panels, and pixel art
scripts/        Example checks, conformance tests, dry run, and asset generators
docs/dsl.md     Orcrist DSL reference
```

## Trust boundary

A guard reading an `agent` location reads the model's self-report and is only
as reliable as that report. Assignable locations, written with `set`, are the
deterministic values. Orcrist makes this distinction visible throughout the
interface but cannot remove it. `run_command` is disabled by default for the
same reason. Web search reports what the agent read, not necessarily what is
true.

