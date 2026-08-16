# Devin

Devin support is in early access. T3 Code runs the local Devin CLI over ACP while keeping the
thread, workspace, and remote connection owned by your T3 environment.

## Set Up Devin

Install the Devin CLI on the machine running the T3 server and confirm it is available:

```bash
devin --version
```

In Settings, add or edit a Devin provider:

```text
Display name: Devin
Binary path: devin
API key: optional
```

T3 uses the configured API key first, then `WINDSURF_API_KEY` from the server environment. If
neither is set, Devin can start its browser login flow when a session begins.

For a custom installation, set **Binary path** to the full path of the Devin executable.

## Start A Thread

Choose Devin in the model picker and start a thread normally. T3 passes the selected permission
mode to Devin and supports:

- streamed answers and reasoning
- plan and default interaction modes
- token and context usage
- provider slash commands reported by the active session
- permission requests and structured questions
- images attached to prompts
- tool progress, results, and delayed tool-state updates

The command menu refreshes when Devin changes its available slash commands. Session configuration
also refreshes while the thread is active.

## MCP

T3 supplies its authenticated MCP server to Devin for each thread. MCP tools therefore follow the
same environment, workspace, and remote-access boundaries as the rest of T3.

Configure additional MCP servers through the Devin CLI. T3 does not expose Devin Desktop's private
MCP, skill, rule, or plugin management screens.

## Checkpoints And Revert

T3 captures workspace checkpoints and file diffs for Devin turns. Reverting a completed Devin turn
is disabled because the current integration cannot rewind Devin's conversation state together with
the filesystem. T3 rejects the operation before changing files, so the workspace and provider
history cannot become partially restored.

Use Git directly when you need to restore files, then start a new Devin thread for a clean provider
history.

## Browser Preview

Use T3's Preview panel for browser work. T3 does not advertise Devin Desktop's private browser
preview extension because it cannot safely assign URL opening and capture ownership across local,
relay, tunnel, web, desktop, and mobile clients.

Devin can still inspect browser applications through MCP tools configured for the thread.

## Host Capabilities

T3 advertises only ACP host capabilities it can service consistently. Form questions are enabled.
Client-managed filesystem reads and writes, terminal callbacks, editor focus and dirty-buffer
context, lint diagnostics, subagents, multi-root workspaces, fast context, private message
rendering, and Devin Desktop management extensions remain disabled.

Devin still edits the project through its own remote execution tools. These disabled capabilities
refer only to callbacks that would make T3 act as Devin Desktop's local editor host.

Unknown Devin extension notifications are recorded structurally in native provider diagnostics and
are not copied into chat. T3 keeps the method and payload shape, not raw content. This keeps startup
chatter and potentially sensitive provider output out of the thread while preserving routing data
needed to diagnose a session.

## Troubleshooting

If Devin is unavailable:

1. Run `devin --version` on the T3 server machine.
2. Check the provider's Binary path in Settings.
3. Confirm the configured API key or `WINDSURF_API_KEY` is valid, or complete browser login.
4. Refresh provider status in Settings.
5. Start a new thread after changing authentication or the CLI installation.
