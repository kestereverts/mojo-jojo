# Repository Notes

- This is a Bun workspace repo, not Node/npm. Use Bun 1.3.x; `.tool-versions` pins `bun 1.3.14` and `package.json` sets `packageManager` to `bun@1.3.14`.
- Workspaces are `apps/*` and `packages/*`. Current implemented workspaces are `@mojo-jojo/app` and `@mojo-jojo/irc-message`.
- `apps/app/index.ts` is still a placeholder app entrypoint (`console.log("Hello via Bun!")`); the root `README.md` describes the bot goal, not current app behavior.
- `packages/irc-message` is the active library: IRCv3 raw line parsing/serialization, exported from `packages/irc-message/src/index.ts`.
- `CLAUDE.md` only delegates to this file with `@AGENTS.md`; keep repo guidance here.

## Commands

- Install/update dependencies with `bun install`; commit `bun.lock` when dependencies change.
- All-workspace scripts from the repo root: `bun run typecheck`, `bun run build`, `bun run clean`, `bun run dev`.
- Single workspace scripts use Bun filters, e.g. `bun run --filter @mojo-jojo/app typecheck` or `bun run --filter @mojo-jojo/irc-message test`.
- App-only runtime commands from `apps/app`: `bun run start` for one run, `bun run dev` for watch mode.
- `@mojo-jojo/irc-message` has tests; run a focused file from that package with `bun test src/parse.test.ts`.
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

## Agent Files

- `.agents/skills/` and `skills-lock.json` are repo-local agent skill artifacts, not application packages.
