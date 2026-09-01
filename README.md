# @dsh-blue/herdr-agent-state

A DeepSeek Harness (`dsh`) plugin that reports a pane's agent state — `working`,
`blocked`, `idle` — and its session reference to [Herdr](https://herdr.dev/)
through Herdr's pane socket integration. It lets Herdr's sidebar show where the
agent actually is, surface waiting agents, and expose the session for restore,
**without any change to Herdr** (Herdr's [custom integration](https://herdr.dev/docs/integrations/#integrate-your-own-agent)
path).

It works in **any dsh frontend** — TUIs, the web app, and headless — because it
subscribes only to documented dsh extension points (agent lifecycle events, the
approval and user-question waterfalls) and carries no UI or renderer dependency.

## Install

The plugin is a **dsh bundle** (`dsh.bundle.patch` → `cordis.patch.yml`), so
`dsh plugin add` activates it automatically — no manual `cordis.patch.yml` edit:

```sh
dsh plugin --profile <profile> add @dsh-blue/herdr-agent-state
```

It inserts a row labelled `herdr-agent-state`. To change the Herdr agent label
a frontend reports, patch the same row id in the profile's `cordis.patch.yml`
(an id-targeted patch replaces that row's whole `config`; the schema defaults
fill any field you omit):

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: herdr-agent-state
  config:
    agent: blue        # default dsh; this frontend's own label
```

The plugin is a strict no-op outside a Herdr pane (`HERDR_ENV=1` plus
`HERDR_SOCKET_PATH` and `HERDR_PANE_ID` absent), so it never adds side effects
to a normal terminal session.

### Install straight from GitHub (before publishing to npm)

`dsh plugin` is a thin [pnpm](https://pnpm.io/) forwarder, so it accepts any
pnpm dependency spec — including a GitHub repo. The plugin ships plain ESM
JavaScript with no build step, so `dsh plugin add` installs and auto-activates
the bundle in one command with no `prepare`/`lib` and no `allowBuilds` entry:

```sh
# master branch; pin the exact commit when you want reproducibility
dsh plugin --profile <profile> add github:dsh-blue/herdr-agent-state
# or pinned to a commit (the pattern Blue marketplace installs use):
dsh plugin --profile <profile> add dsh-blue/herdr-agent-state#<40-char-sha>
```

## How it reports state

| Herdr state | dsh signal |
|---|---|
| `working` | any agent reports `agent/status = running` |
| `blocked` | an `approval/request` or `user-questions/request` waterfall is awaiting an answer |
| `idle` | no agent running and nothing pending |

Blocked observations are **passive**: the plugin calls `await next()` and returns
the downstream decision unchanged, so approval and question flows are never
altered. Reports are coalesced (latest value wins) and tagged with a strictly
increasing `seq`, mirroring Herdr's own Pi integration wire contract.

The plugin releases the pane's lifecycle authority on unload and process exit,
and re-reports on `agent/session-start` so a reload does not leave Herdr with a
stale authority.

## Configuration

### Configuration reference

| Field | Type | Default | Meaning |
|---|---|---|---|
| `agent` | string | `'dsh'` | The Herdr agent label reported for the pane. Set a frontend's own name (e.g. `blue`) so Herdr's sidebar groups it under that label. |
| `source` | string | `'herdr:dsh-agent-state'` | Stable, unique integration source. Herdr attributes the pane's lifecycle authority to this source. **Keep it constant.** Changing it makes Herdr treat the pane as a *different* authority mid-session. |
| `transport` | `'socket'` \| `'cli'` | `'socket'` | How to report to Herdr. Only `socket` is implemented (speaks the pane socket directly). `cli` is declared but not yet implemented — it throws **at load**, so don't set it. |
| `reportSession` | boolean | `true` | Report the pane's session reference (`agent_session_id`) so Herdr can expose it for restore. Set `false` to suppress session reporting. |
| `message` | `'tool'` \| `'none'` | `'tool'` | Whether to attach a human label to `blocked` reports. `tool` sends the tool name / question summary; `none` sends `blocked` with no message. |
| `enabled` | boolean | `true` | Kill-switch. Set `false` to disable the reporter in this tree — useful to coexist with another reporter. |

### How to configure it

The plugin is a bundle row labelled `herdr-agent-state`, so it is inserted
automatically when you `dsh plugin add`. Because its `Config` schema gives every
field a default, you only set what you want to change; the schema fills the
rest. A profile's `cordis.patch.yml` is a **top-level YAML array of loader patch
entries**, so you target the row by `id` and replace its `config`:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: herdr-agent-state
  config:
    agent: blue
```

The patch replaces the row's whole `config`, so the schema defaults supply any
field you don't set. Include `name` as a guard — if it ever mismatches the row,
the patch is skipped with a warning instead of silently applying:

```yaml
- id: herdr-agent-state
  name: '@dsh-blue/herdr-agent-state'
  config:
    agent: blue
    source: herdr:dsh-agent-state
    transport: socket
    reportSession: true
    message: tool
    enabled: true
```

### Examples

Set the Herdr label to `blue` when Blue hosts the pane (all other fields
default):

```yaml
- id: herdr-agent-state
  config:
    agent: blue
```

Disable session reporting and verbose blocked messages:

```yaml
- id: herdr-agent-state
  config:
    reportSession: false
    message: none
```

### Notes

- **Changing `source`** re-attributes the pane's authority in Herdr. Keep it at
  the default unless you are deliberately running two reporters in the same
  tree — then give each a distinct `source`, and use `enabled: false` on the one
  you want silent.
- **`transport: 'cli'` is not implemented.** Setting it throws during plugin
  load (fail-fast), so leave it as `socket`.
- **`config` is validated** against the schemastery schema at load; an invalid
  value (for example a `transport` that isn't `socket`/`cli`) is rejected, and
  the plugin fails to load rather than running half-configured.
- Because a patch replaces the row's whole `config`, any field you don't set
  comes from the schema default — you do not need to copy every field.

## Version compatibility

Built against the dsh `0.1.2-alpha` line. It shares the host's
`@deepseek-ai/schemastery` instance (declared as a peer, so the runtime
`Config` schema uses the same copy the host validates against).

## Development

```sh
pnpm install
pnpm test        # vitest run (unit + fake-socket integration)
```

The plugin ships as plain ESM JavaScript, so there is no build step. Its
`state` and `transport` modules depend only on Node builtins, so their tests
run without a dsh host.

## License

MIT.
