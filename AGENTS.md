# Repository Notes

- This is a Bun workspace repo, not Node/npm. Use Bun 1.3.x; `.tool-versions` pins `bun 1.3.14` and `package.json` sets `packageManager` to `bun@1.3.14`.
- Workspaces are `apps/*` and `packages/*`. Current implemented workspaces are `@mojo-jojo/app`, `@mojo-jojo/irc-message`, and `@mojo-jojo/irc-client`.
- `apps/app/index.ts` is still a placeholder app entrypoint (`console.log("Hello via Bun!")`); the root `README.md` describes the bot goal, not current app behavior.
- `packages/irc-message` is the raw IRCv3 line parser/serializer; `packages/irc-client` is the RxJS-first IRC client built on top of it. Both export from `src/index.ts`.
- `CLAUDE.md` only delegates to this file with `@AGENTS.md`; keep repo guidance here.

## Commands

- Install/update dependencies with `bun install`; commit `bun.lock` when dependencies change.
- All-workspace scripts from the repo root: `bun run typecheck`, `bun run build`, `bun run clean`, `bun run dev`.
- Single workspace scripts use Bun filters, e.g. `bun run --filter @mojo-jojo/irc-client test` or `bun run --filter @mojo-jojo/irc-message test`.
- App-only runtime commands from `apps/app`: `bun run start` for one run, `bun run dev` for watch mode.
- Focused tests run from the package directory, e.g. `bun test src/parse.test.ts` in `packages/irc-message` or `bun test src/IrcClient.test.ts` in `packages/irc-client`.
- `packages/irc-client/src/smoke.test.ts` is skipped unless `IRC_SMOKE=1`; it opens a real IRC TCP/TLS connection and accepts `IRC_SMOKE_HOST`, `IRC_SMOKE_PORT`, `IRC_SMOKE_TLS=0`, `IRC_SMOKE_TLS_INSECURE=1`, `IRC_SMOKE_CHANNEL`, plus optional `IRC_SASL_USER`/`IRC_SASL_PASS`.
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

## Agent Files

- `.agents/skills/` and `skills-lock.json` are repo-local agent skill artifacts, not application packages.
