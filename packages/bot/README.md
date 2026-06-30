# @mojo-jojo/bot

Modular, RxJS-first IRC bot framework built on top of [`@mojo-jojo/irc-client`](../irc-client).

A bot is one `IrcClient` plus a set of **modules** (plugins) selected through a TOML config
file. Modules are factories that receive a `ModuleContext` (the client, its RxJS event streams,
a scoped logger, their own validated config slice, a `command()` registrar, and lifecycle
plumbing) and wire up behaviour — chat commands or raw event subscriptions. Everything is
RxJS-internally; the framework exposes its own events as both an `events$` Observable and a
thin `on()/once()/off()` façade.

A `Bot` drives exactly **one network** (one `IrcClient`). For multiple networks, run
multiple `Bot`s — optionally sharing a `ModuleRegistry` — rather than multiplexing one.

## Layout

- `config/` — TOML loader, env-override merge, zero-dep validation, mapping to `IrcClientOptions`.
- `module/` — the `Module`/`ModuleContext` contract, registry, external loader, and host.
- `command/` — `!cmd` parser, permissions, safe reply helpers, and the bounded `CommandRouter`.
- `events/` — the `BotEvent` union + `BotEventHub` (`events$` + `on/once/off`).
- `abuse/` — per-key cooldowns and the account/mask ignore list. `identity/` — sender matching.
- `logging/` — the leveled `ConsoleLogger`. `modules/` — the built-in modules + registry.
- `Bot.ts` — the runtime (load → connect → graceful teardown).

## Writing a module

A module is a `ModuleFactory` — a function returning a `Module`. `setup(ctx)` gets the
`ModuleContext`; register commands and/or subscribe to streams, and clean up via the
tracked subscriptions or `onCleanup`.

```ts
import { defineModule, type Module } from "@mojo-jojo/bot";

export function helloModule(): Module {
  return defineModule({
    name: "hello",
    setup(ctx) {
      // A chat command (auto-removed on dispose):
      ctx.command({ name: "hello", description: "Greet.", handler: (c) => void c.reply("hi!") });
      // Or a raw stream — bind teardown with takeUntil(ctx.destroyed$):
      // ctx.events$.pipe(takeUntil(ctx.destroyed$)).subscribe((e) => { ... });
    },
  });
}

export default helloModule; // so it can be loaded as an externalModule
```

List it under `externalModules` in config and configure it via `[modules.hello]`. Per-connection
work must hang off the `registered` lifecycle event (modules persist across reconnects).

## Config

Connection settings and which modules to load live in a `config.toml` (see the app workspace).
Secrets (`server.password`, SASL password) are accepted in-file but **discouraged** — prefer
environment variables (`IRC_PASSWORD`, `IRC_SASL_USER` / `IRC_SASL_PASS`), which always override
the file. Note that top-level keys (e.g. `externalModules`) must appear before any `[table]`
section in TOML. The config file is a **trust boundary equal to the bot's own code** —
`externalModules` entries are dynamically imported and run with full process privilege.

`externalModules` values are **raw specifiers** (a relative/absolute path or a package
specifier). A relative path is resolved against the config file's own directory — never the
current working directory or the importing module — and the loader passes each through
`resolveExternalSpecifier(spec, configDir)` (converting paths to a `file://` URL) before
`import()`. They must not be imported directly.

## Security / threat model

- **The IRC server is a trusted identity authority.** All sender identity (account-tags,
  hostmasks, channel modes) comes from the server; a malicious or compromised server can
  impersonate anyone. This is inherent to IRC — owner/permission gating defends against
  malicious *users*, not a hostile server.
- **Owners:** prefer `account:` (verified per-message via `account-tag`; a logged-out sender
  never matches) or `mask:`. Bare-nick / `nick:` owners are spoofable by nick takeover and the
  bot warns about them at startup.
- **Outbound safety:** every relay (`say`/`notice`/`action`/`raw`/CTCP) goes through the
  client's strict `send()`, which throws on CR/LF/NUL injection or over-512-byte lines; the bot
  catches that and drops the send, so untrusted text can never inject a wire command.
- **External modules** run with full process privilege — the config file is a trust boundary
  equal to the bot's own code. Don't load config from an untrusted source.
- **Abuse / resource bounds:** a per-sender command **token bucket** (`bot.commandBurst` /
  `commandRefillMs`, default burst 5 + 1/s) caps how fast one user can drive output; dispatch
  concurrency is bounded with a per-handler timeout (which aborts `ctx.signal`); cooldowns,
  the rate-limiter key table, and `MemoryStorage` are all hard-bounded; drop/overload logs are
  throttled. One user cannot flood the bot's output or grow its memory without bound.
