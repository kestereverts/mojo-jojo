# mojo-jojo

An IRCv3-compliant bot written in TypeScript using Bun. It is modular and extensible:
features are added through **plugins (modules)** selected via a TOML config file.

Mojo Jojo is the successor to [Mojo](https://github.com/kestereverts/mojo).

## Architecture

- `packages/irc-message` — raw IRCv3 line parser/serializer.
- `packages/irc-client` — RxJS-first IRC client (connection, state tracking, reactive events).
- `packages/bot` (`@mojo-jojo/bot`) — the modular bot framework: config loader, module
  system, RxJS command framework, and the built-in modules.
- `apps/app` (`@mojo-jojo/app`) — the runnable bot: it loads `config.toml` and starts the bot.

## Run

```sh
bun install
cd apps/app
cp config.example.toml config.toml   # then edit it
bun run start                        # one run; `bun run dev` for watch mode
```

Secrets come from the environment (`IRC_PASSWORD`, `IRC_SASL_USER` / `IRC_SASL_PASS`),
never the config file. See `apps/app/config.example.toml` for the full annotated config.

## Built-in modules

`ping`, `help`, `admin` (owner-only ops), `ctcp`, `autojoin`. Enable one with a
`[modules.<name>]` table in the config. Write your own by exporting a `Module` /
`ModuleFactory` and listing it under `externalModules` — see `packages/bot/README.md`.
