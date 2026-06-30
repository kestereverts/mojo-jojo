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

> Status: under construction; see the build plan for the full milestone breakdown.

## Layout

- `config/` — TOML loader, env-override merge, zero-dep validation, and the mapping to
  `IrcClientOptions`.
- `module/`, `command/`, `events/`, `abuse/`, `logging/`, `modules/` — added in later milestones.

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
