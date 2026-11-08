# quota-compact

English | [简体中文](README.zh-CN.md)

A Claude Code plugin that compacts the conversation **while a session is running** once your account's **5-hour rate-limit window** reaches a percentage you choose (98% by default). If a turn is in progress, the plugin pauses it at a safe point, compacts the context, then tells Claude to pick up where it left off.

## Features

- **Triggers on the 5-hour usage window**, not on context size. It reads the same figures the status line shows.
- **Pause → compact → resume.** If a turn is running, it ends the turn at a safe point: after the current tool call finishes and before the next model request. No command or file write is cut off. After compacting, it sends a message asking Claude to continue the previous task.
- **A note in the terminal.** After each compaction the transcript gets one dim line saying whether it compacted, was skipped or failed, and whether a turn was paused. Only you see it; it is not sent to the model.
- **Subagents don't block it.** While the plugin is on, subagents started by the main session run in the background. The main session can pause and compact while they keep working.
- **Once per window.** Each session compacts at most once per 5-hour window. It triggers again after the window resets.
- **Persistent settings.** `/quota-compact` turns it on or off and sets the percentage. The setting applies to every session and survives restarts, like `/autocompact`.

## Requirements

- Claude Code with plugin support
- A Claude subscription (Pro / Max). The 5-hour window is reported only for subscription sign-ins; with an API key the plugin does nothing.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install quota-compact --marketplace hxy920830/quota-compact
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

From a shell:

```
claude plugin install quota-compact --marketplace hxy920830/quota-compact
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `hxy920830/quota-compact`, then **Add plugin**.

## Usage

| Command | Effect |
| --- | --- |
| `/quota-compact` | Show the current setting and 5-hour usage |
| `/quota-compact on 95` | Turn on and set the threshold to 95% |
| `/quota-compact off` | Turn off |
| `/quota-compact on` | Turn on, keep the threshold |
| `/quota-compact 90` | Change only the threshold |

- The switch also accepts `enable` / `disable`, `true` / `false`, `1` / `0`, and `启用` / `停用`.
- The percentage ranges from 1 to 100, with one decimal place, e.g. `97.5`.
- The command runs mid-turn without waiting.
- If usage is already past the new threshold, compaction starts right away.

## How it works

1. On each usage measurement, the plugin checks the `five_hour` window against the threshold.
2. If the session is idle, it compacts right away, just like `/compact`.
3. If a turn is running, it waits for the next safe point, ends the turn, compacts, then submits a resume prompt.
4. If compaction is refused, it retries every 3 seconds for up to about an hour.

## Limitations

- A single long tool call, such as a 10-minute command, runs to completion before the pause. It is never killed.
- A foreground subagent that was already running before the plugin loaded still blocks the main turn until it returns.
- Subagents started while the plugin is on run in the background instead of the foreground.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

[MIT](LICENSE)
