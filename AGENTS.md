# Repository Notes

- This is a Bun workspace repo, not Node/npm. Use Bun 1.3.x; `.tool-versions` pins `bun 1.3.14` and `package.json` sets `packageManager` to `bun@1.3.14`.
- Workspaces are `apps/*` and `packages/*`. Implemented workspaces are `@mojo-jojo/app`, `@mojo-jojo/irc-message`, `@mojo-jojo/irc-client`, `@mojo-jojo/bot`, and `@mojo-jojo/ai`.
- `apps/app/index.ts` is the runnable bot: it `loadConfig()`s `apps/app/config.toml` and starts a `Bot`. `config.example.toml` is the annotated template; secrets come from env, not the file.
- `packages/irc-message` is the raw IRCv3 line parser/serializer; `packages/irc-client` is the RxJS-first IRC client built on it; `packages/bot` is the modular bot framework built on the client. Each package's public API is `src/index.ts` (`@mojo-jojo/bot` additionally ships the built-in modules under the `@mojo-jojo/bot/modules` subpath export).
- `CLAUDE.md` only delegates to this file with `@AGENTS.md`; keep repo guidance here.

## Commands

- Install/update dependencies with `bun install`; commit `bun.lock` when dependencies change.
- All-workspace scripts from the repo root: `bun run typecheck`, `bun run build`, `bun run clean`, `bun run dev`.
- Single workspace scripts use Bun filters, e.g. `bun run --filter @mojo-jojo/irc-client test` or `bun run --filter @mojo-jojo/irc-message test`.
- App-only runtime commands from `apps/app`: `bun run start` for one run, `bun run dev` for watch mode.
- Focused tests run from the package directory, e.g. `bun test src/parse.test.ts` in `packages/irc-message` or `bun test src/IrcClient.test.ts` in `packages/irc-client`.
- `packages/irc-client/src/smoke.test.ts` is skipped unless `IRC_SMOKE=1`; it opens a real IRC TCP/TLS connection and accepts `IRC_SMOKE_HOST`, `IRC_SMOKE_PORT`, `IRC_SMOKE_TLS=0`, `IRC_SMOKE_TLS_INSECURE=1`, `IRC_SMOKE_CHANNEL`, plus optional `IRC_SASL_USER`/`IRC_SASL_PASS`.
- `packages/bot/src/bot.smoke.test.ts` is skipped unless `BOT_SMOKE=1`; it boots a real `Bot` plus a second client against `#mojo2` and asserts autojoin + a live `!ping`→`pong`. Reuses the same `IRC_SMOKE_*` env. Run: `BOT_SMOKE=1 bun test src/bot.smoke.test.ts` from `packages/bot`.
- App runtime: `bun run start` / `bun run dev` from `apps/app` reads `apps/app/config.toml` (override path with `BOT_CONFIG`).
- Env/secrets: no dotenv package — the app scripts pass `--env-file=../../.env --env-file=.env`, so secrets live in the gitignored repo-root `.env` (with an optional `apps/app/.env` override; both files may be absent). Note `--env-file` disables Bun's automatic cwd `.env` loading, and env vars override `config.toml` for the `IRC_*`/`BOT_*` keys in `packages/bot/src/config/env.ts`; AI/tool API keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, …) are env-only.
- There is no root `test` script, no configured lint/formatter scripts, and no CI workflows.

## TypeScript And Build

- Root `tsconfig.json` is strict, uses Bun types, `moduleResolution: "bundler"`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, and `noEmit`; workspace typechecks run `tsc --noEmit`.
- Root scripts use `bun run --filter '*' <script>`, so adding a workspace with a matching script makes it part of root `build`, `dev`, `typecheck`, or `clean`.
- Workspace builds use `bun build ... --target bun`; `dist/` is globally ignored.

## IRC Message Package

- `parseMessage` operates on one IRC line without trailing `\r\n`; stream splitting belongs to the transport layer, not this package.
- The parse pipeline is bytes -> tokenizer -> parser -> `Message`; `buildMessage` is a serializer and intentionally normalizes some byte details (see `packages/irc-message/README.md`).
- The default tokenizer backend is `js-fast`; `reference` is the correctness oracle. WASM backends are async via `createIrcParser`.
- Committed WASM artifacts live in `packages/irc-message/src/tokenizer/wasm/*.wasm`. Rebuild them only when native sources change with `bun run build:wasm` from `packages/irc-message`; it requires `wabt`, `binaryen`, and Rust target `wasm32-unknown-unknown`.
- Benchmarks are package-local: `bun run bench` from `packages/irc-message`; benchmark numbers are machine-dependent.

## IRC Client Package

- `IrcClient` defaults to TLS on port 6697 (`tls: false` switches to port 6667) and infinite reconnect with jitter; `connectTimeoutMs` bounds only the initial connect attempt window.
- The transport seam is byte-oriented: `Transport.bytes$` emits `Uint8Array`; line framing lives in `decodeLines`, and parsing lives in `createMessageStream`.
- Default production transport is `BunSocketTransport` using `Bun.connect`; tests normally inject `MockTransport` or a `SocketConnector` instead of opening sockets.
- Inbound pipeline is `transport.bytes$ -> decodeLines() -> parseMessage() -> share()`. A malformed/over-length line is dropped via `onParseError` and does not end the connection; only transport errors trigger reconnect.
- `messages$`, `events$`, `clientEvents$`, and `lifecycle$` are stable across reconnects. `StateStore` and per-entity streams are rebuilt/disposed per connection, so stale `Channel`/`User` references complete after reconnect or quit.
- `OutboundQueue.send` is strict and throws on CR/LF/NUL injection, over-512-byte wire lines, or full queues; `sendImmediate` is for internal priority traffic and strips/truncates instead.
- Live state is bounded and IRC-casemapping-aware; do not replace `IrcMap`/`IrcSet` lookups with plain `Map`/`Set` for nicks or channels.

## IRC Bot Package

- `packages/bot` (`@mojo-jojo/bot`) is the modular bot framework on top of `irc-client`. A `Bot` is one `IrcClient` plus modules loaded from a TOML config; it is RxJS-first internally and exposes its own events as both `events$` and an `on()/once()/off()` façade.
- Config: `loadConfig()` parses TOML (`Bun.TOML.parse`), strips prototype-polluting keys, merges env overrides (env wins for secrets), and validates with the zero-dep `Validator` (collect-all-errors). Secrets (`IRC_PASSWORD`, `IRC_SASL_*`) should come from env; an in-file `server.password` / `[server.sasl]` password is supported but discouraged and is overridden by the env vars. An env `IRC_SASL_*` that conflicts with a file `mechanism` (e.g. EXTERNAL) is a hard error, not a silent downgrade. `ServerConfig` maps to `IrcClientOptions`.
- Modules are factories returning a `Module` (`name`, optional `parseConfig`, `setup(ctx)`). `setup` gets a `ModuleContext`: the client, RxJS streams, `destroyed$`, `track()`, `command()`, `cooldown`/`isIgnored`, namespaced `storage`, scoped `log`, and `onCleanup`. Subscriptions are torn down on dispose; per-connection work must hang off the `registered` lifecycle event (modules persist across reconnects).
- Built-in modules (`src/modules/`): `ping`, `help`, `admin` (owner-only; `!raw` opt-in), `ctcp` (rate-limited), `autojoin` (reconnect-safe). `builtinModules` seeds the default registry; external modules come from config `externalModules` (dynamically imported — config is a trust boundary equal to bot code).
- Commands run through a single bounded RxJS PRIVMSG pipeline (`CommandRouter`): cheap parse/lookup/ignore/permission gating, then an `#inFlight` concurrency cap that drops on saturation; per-handler timeout; cooldown after admission. Replies go through `safeSay`/`safeNotice` (the client's `send()` throws synchronously on bad input). One `Bot` = one network.

## AI Package

- `packages/ai` (`@mojo-jojo/ai`) is the LLM brain (skeleton). Provider access goes through the Vercel AI SDK (`ai` v7) with direct provider packages; config `model` is a `"provider/model-id"` spec (default `openai/gpt-5.4-mini`) resolved in `src/models.ts` (`google` → `@ai-sdk/google` keyed by `GEMINI_API_KEY`, `openai` → `@ai-sdk/openai` keyed by `OPENAI_API_KEY`).
- Architecture: durable per-conversation memory is an append-only log of typed `ContextEvent`s; the prompt is a projection (`renderPrompt(log, turn)`) computed per model call; ephemeral turn-scoped context (`TurnContext`) is rendered into the live prompt only and never appended to the log. Keep this single-render-path invariant.
- The agent loop (`runExchange`) is plain async/await on `ToolLoopAgent`; RxJS owns turn orchestration in the `mojo-ai` bot module (`src/mojo-ai.ts`): only channel lines addressing the bot (`nick:`/`nick,`) are recorded or sent to the model — no ambient chatter, no PMs — one exchange at a time per conversation.
- The module is wired as an external module by path (`externalModules = ["../../packages/ai/src/mojo-ai.ts"]` in `apps/app/config.toml`) — Bun's isolated `node_modules` keep a bare `@mojo-jojo/ai` specifier from resolving inside `@mojo-jojo/bot`'s dynamic `import()`.

## Agent Files

- `.agents/skills/` and `skills-lock.json` are repo-local agent skill artifacts, not application packages.
