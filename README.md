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

Install it into a profile, then mount the row:

```sh
dsh plugin --profile <profile> add @dsh-blue/herdr-agent-state
```

Add a row to the profile's `cordis.patch.yml` (or your overlay):

```yaml
plugins:
  herdr-agent-state:
    $if: .herdr  # optional: gate on an env/`HERDR_ENV` value; the plugin self-disables outside Herdr anyway
    agent: blue   # default `dsh`; set your frontend's own label here
```

The plugin is a strict no-op outside a Herdr pane (`HERDR_ENV=1` plus
`HERDR_SOCKET_PATH` and `HERDR_PANE_ID` absent), so it never adds side effects
to a normal terminal session.

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

| Field | Default | Meaning |
|---|---|---|
| `agent` | `'dsh'` | Herdr agent label reported for the pane. A frontend sets its own name here. |
| `source` | `'herdr:dsh-agent-state'` | Stable unique integration source. Keep it constant. |
| `transport` | `'socket'` | `socket` (implemented) or `cli` (declared, not yet implemented — rejected at load). |
| `reportSession` | `true` | Report the pane's session reference to Herdr. |
| `message` | `'tool'` | `tool` attaches a human label to blocked reports; `none` omits it. |
| `enabled` | `true` | Kill-switch to coexist with another reporter in the same tree. |

## Version compatibility

Built against the dsh `0.1.2-alpha` line. It pins the same Harness events as its
`peerDependencies` on `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-user-approval`,
and `@deepseek-ai/dsh-user-questions`.

## Development

```sh
pnpm install
pnpm build       # tsc -> lib/
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run (unit + fake-socket integration)
```

The `state` and `transport` modules depend only on Node builtins, so their tests
run without a dsh host; only the plugin wiring (`src/index.ts`) needs the dsh
peer types at typecheck time.

## License

MIT.
