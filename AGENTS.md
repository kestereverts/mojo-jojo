# Repository Notes

- This is a Bun workspace repo, not a Node/npm project. Use Bun 1.3.x; `.tool-versions` pins `bun 1.3.14` and `package.json` sets `packageManager` to `bun@1.3.14`.
- Workspaces are `apps/*` and `packages/*`. The only implemented workspace right now is `apps/app` (`@mojo-jojo/app`); `packages/` only contains `.gitkeep`.
- The app entrypoint is `apps/app/index.ts`. `apps/app/package.json` points both `main` and `module` at that file, and `start` runs it directly with Bun.
- `README.md` describes the goal as an IRCv3 TypeScript bot, but the current app code is still a placeholder; trust the package scripts and source over the README for current behavior.

## Commands

- Install/update dependencies with `bun install`; commit `bun.lock` when dependencies change.
- All-workspace checks/builds from the repo root: `bun run typecheck`, `bun run build`, `bun run clean`, `bun run dev`.
- Single workspace example: `bun run --filter @mojo-jojo/app typecheck`.
- App-only runtime commands from `apps/app`: `bun run start` for one run, `bun run dev` for watch mode.
- There are currently no configured `test`, `lint`, or formatter scripts and no CI workflows in this repo.

## TypeScript And Build

- Root `tsconfig.json` is strict, uses Bun types, `moduleResolution: "bundler"`, `allowImportingTsExtensions`, and `noEmit`; package typechecks run `tsc --noEmit`.
- `@mojo-jojo/app` builds with `bun build index.ts --outdir dist --target bun`; `dist/` is ignored.
- Root scripts use `bun run --filter '*' <script>`, so adding a workspace with a matching script makes it part of root `build`, `dev`, `typecheck`, or `clean`.

## Agent Files

- `.agents/skills/` and `skills-lock.json` are repo-local agent skill artifacts, not application packages.
