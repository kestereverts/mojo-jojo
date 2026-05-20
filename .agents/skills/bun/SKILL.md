---
name: Bun
description: Use when building JavaScript/TypeScript applications, running scripts, installing packages, bundling code, or testing. Bun is a complete toolkit replacing Node.js, npm, and bundlers with a single fast binary.
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill

## Product Summary

Bun is an all-in-one JavaScript/TypeScript toolkit shipped as a single executable. It replaces Node.js (runtime), npm/yarn/pnpm (package manager), Jest (test runner), and esbuild/webpack (bundler) with a unified, fast alternative. The runtime is written in Zig and powered by JavaScriptCore.

**Key files and commands:**
- `bunfig.toml` — Configuration file (optional, zero-config by default)
- `bun run <script>` — Execute scripts from package.json or files
- `bun install` — Install dependencies (25x faster than npm)
- `bun build` — Bundle JavaScript/TypeScript for browsers or servers
- `bun test` — Run Jest-compatible tests
- `Bun.serve()` — Start HTTP servers with native performance

**Primary docs:** https://bun.com/docs

---

## When to Use

Reach for this skill when:

- **Running TypeScript/JSX directly** — No compilation step needed; Bun transpiles on the fly
- **Building HTTP servers** — Use `Bun.serve()` for high-performance APIs and full-stack apps
- **Installing packages** — Replace `npm install` with `bun install` in any Node.js project
- **Bundling applications** — Use `bun build` for browser or server bundles with splitting, minification, and plugins
- **Testing code** — Run Jest-compatible tests with `bun test` (faster than Jest)
- **Running scripts** — Execute package.json scripts or standalone files with `bun run`
- **Migrating from Node.js** — Bun is a drop-in replacement for existing Node.js projects
- **Building full-stack apps** — Import HTML files directly to bundle frontend and backend together

---

## Quick Reference

### Essential Commands

| Command | Purpose |
|---------|---------|
| `bun run <file.ts>` | Execute TypeScript/JSX file directly |
| `bun run <script>` | Run script from package.json |
| `bun install` | Install all dependencies (creates bun.lock) |
| `bun add <pkg>` | Add a package to dependencies |
| `bun remove <pkg>` | Remove a package |
| `bun build ./src/index.ts --outdir ./dist` | Bundle code for production |
| `bun test` | Run all test files matching `*.test.ts` patterns |
| `bun test --watch` | Run tests in watch mode |
| `bunx <pkg>` | Execute a package without installing globally |

### File Conventions

- **Test files:** `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts`
- **Config file:** `bunfig.toml` (optional, in project root or `~/.bunfig.toml`)
- **Lockfile:** `bun.lock` (text format, commit to version control)
- **Package manifest:** `package.json` (standard Node.js format)

### Configuration Sections in bunfig.toml

```toml
[install]
linker = "hoisted"  # or "isolated" for monorepos
optional = true
dev = true
peer = true

[test]
root = "."
coverage = false
timeout = 5000

[serve]
port = 3000

[run]
shell = "system"  # or "bun"
bun = true        # alias node to bun
```

---

## Decision Guidance

### When to Use Bun vs Node.js

| Scenario | Use Bun | Use Node.js |
|----------|---------|-----------|
| New project, greenfield | ✓ | — |
| Existing Node.js project | ✓ (drop-in replacement) | — |
| Requires specific Node.js version | — | ✓ |
| Need exact npm compatibility | — | ✓ |
| Building CLI tools | ✓ | — |
| Full-stack TypeScript apps | ✓ | — |

### Bundler: `bun build` vs `bun run`

| Task | Use `bun build` | Use `bun run` |
|------|-----------------|---------------|
| Production deployment | ✓ | — |
| Optimize bundle size | ✓ | — |
| Code splitting | ✓ | — |
| Development/testing | — | ✓ |
| Single-file executable | ✓ | — |
| Watch mode development | — | ✓ |

### Package Manager: Linker Strategy

| Strategy | Use When |
|----------|----------|
| `hoisted` | Single-package projects, traditional npm behavior |
| `isolated` | Monorepos, strict dependency isolation, preventing phantom dependencies |

---

## Workflow

### 1. Initialize a New Project

```bash
bun init my-app
# Choose template: Blank, React, or Library
cd my-app
```

This creates `package.json`, `tsconfig.json`, and `bunfig.toml`.

### 2. Install Dependencies

```bash
bun install
# or add specific packages
bun add react
bun add -d @types/node  # dev dependency
```

Bun creates `bun.lock` automatically. Commit it to version control.

### 3. Write and Run Code

Create `index.ts` with TypeScript/JSX — no compilation needed:

```typescript
const server = Bun.serve({
  port: 3000,
  fetch(req) {
    return new Response("Hello!");
  },
});
console.log(`Listening on ${server.url}`);
```

Run it:

```bash
bun run index.ts
# or via package.json script
bun run start
```

### 4. Write Tests

Create `math.test.ts`:

```typescript
import { test, expect } from "bun:test";

test("2 + 2 = 4", () => {
  expect(2 + 2).toBe(4);
});
```

Run tests:

```bash
bun test
bun test --watch
bun test --coverage
```

### 5. Bundle for Production

```bash
bun build ./src/index.ts --outdir ./dist
# or with options
bun build ./src/index.ts --outdir ./dist --minify --sourcemap linked
```

Check `bunfig.toml` for bundler defaults. Use `Bun.build()` API for programmatic bundling.

### 6. Configure Behavior

Edit `bunfig.toml` to customize:

```toml
[install]
linker = "isolated"  # for monorepos

[test]
coverage = true
timeout = 10000

[serve]
port = 8080
```

---

## Common Gotchas

- **TypeScript errors on `Bun` global** — Install `@types/bun` and add `"lib": ["ESNext"]` to `tsconfig.json`
- **Lifecycle scripts disabled by default** — Add trusted packages to `trustedDependencies` in `package.json` to allow postinstall scripts
- **Lockfile format changed** — Bun v1.2+ uses text `bun.lock` instead of binary `bun.lockb`; old lockfiles auto-migrate
- **Auto-install disabled in production** — Set `install.auto = "disable"` in `bunfig.toml` for CI/CD to prevent unexpected installs
- **Node.js compatibility incomplete** — Check [nodejs-compat](/runtime/nodejs-compat) page for unsupported APIs
- **Bundler doesn't replace tsc** — Use `tsc` separately for type checking and `.d.ts` generation
- **Test runner doesn't execute dependency lifecycle scripts** — Only your project's scripts run; dependencies' postinstall scripts are skipped for security
- **Phantom dependencies in hoisted mode** — Use `isolated` linker in monorepos to prevent accessing undeclared dependencies
- **Environment variables not auto-inlined** — Use `env: "inline"` or `env: "PUBLIC_*"` in `Bun.build()` to inject them into bundles
- **Relative imports in bundles** — Use `publicPath` option to prefix asset paths for CDN deployments

---

## Verification Checklist

Before submitting work with Bun:

- [ ] **Dependencies installed** — Run `bun install` and commit `bun.lock`
- [ ] **Tests pass** — Run `bun test` with no failures
- [ ] **Code runs locally** — Execute `bun run <script>` or `bun run <file.ts>` without errors
- [ ] **TypeScript compiles** — No type errors in editor; check `tsconfig.json` includes `"lib": ["ESNext"]`
- [ ] **Bundle builds** — Run `bun build` and verify output in `--outdir`
- [ ] **No lifecycle script warnings** — If using packages with postinstall, add to `trustedDependencies`
- [ ] **Configuration committed** — `bunfig.toml` and `bun.lock` are in version control
- [ ] **Node.js APIs checked** — Verify used APIs are in [nodejs-compat](/runtime/nodejs-compat) if targeting Node.js
- [ ] **Environment variables set** — Confirm `.env` files are loaded or variables are defined for `bun build`
- [ ] **Performance acceptable** — For servers, test with `bun run --hot` for development or `bun build --compile` for production

---

## Resources

**Comprehensive navigation:** https://bun.com/docs/llms.txt

**Critical pages:**
1. [Runtime Overview](https://bun.com/docs/runtime) — Core APIs, file I/O, HTTP servers
2. [Package Manager](https://bun.com/docs/pm/cli/install) — Install, add, workspaces, lockfile
3. [Bundler](https://bun.com/docs/bundler) — Build, splitting, plugins, executables

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt