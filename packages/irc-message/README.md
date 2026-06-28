# @mojo-jojo/irc-message

IRC message layer for mojo-jojo: parse raw IRCv3 lines into an intermediate
representation, and serialize that representation back into raw lines.

## API

```ts
import { parseMessage, buildMessage, type Message } from "@mojo-jojo/irc-message";

const message = parseMessage(":nick!u@h PRIVMSG #chan :hello world");
// { tags: {}, source: { name: "nick", user: "u", host: "h" },
//   command: "PRIVMSG", params: ["#chan", "hello world"] }

const line = buildMessage(message); // ":nick!u@h PRIVMSG #chan :hello world"
```

`parseMessage` accepts a `string` (UTF-8 encoded internally) or a raw
`Uint8Array`. Both functions operate on a single message **without** the trailing
`\r\n`; splitting the byte stream into lines is the transport layer's job.

## Pipeline

```
parse:  bytes ──tokenize──▶ Token[] ──Parser──▶ Message
build:  Message ──buildMessage──▶ string
```

The [tokenizer](./src/tokenizer/) is a byte-level lexer producing `{type, start,
end}` spans; the [Parser](./src/parser/Parser.ts) decodes those spans and
unescapes tag values into a `Message`. Building is a direct serializer — not an
inverse tokenizer.

## Tokenizer backends

The tokenizer is pluggable. `parseMessage` defaults to **`js-fast`**, an
allocation-free tokenizer (~9–17× faster than the original `reference` one);
all backends produce identical messages.

```ts
// synchronous: 'js-fast' (default) or 'reference'
parseMessage(line, { backend: "reference" });

// any backend, including the WASM ones (async instantiation):
import { createIrcParser } from "@mojo-jojo/irc-message";
const parser = await createIrcParser({ backend: "wasm-rust-simd" });
parser.parseMessage(line);
```

Backends: `reference`, `js-fast`, `wasm-wat` (hand-written WebAssembly text),
`wasm-rust`, `wasm-rust-simd`. The WASM `.wasm` artifacts are committed; rebuild
them from source with `bun run build:wasm` (needs `wabt`, `binaryen`, and the
`wasm32-unknown-unknown` Rust target). Sources live in [native/](./native/).

See [BENCHMARKS.md](./BENCHMARKS.md) for the full race. Short version: `js-fast`
wins for normal single-line IRC; `wasm-rust-simd` (batched, via
`WasmTokenizer.tokenizeBatchInto`) only pulls ahead on large buffers of
long-field lines.

## Intermediate representation

A [`Message`](./src/types.ts) mirrors the IRCv3 message grammar:

```
['@' tags SPACE] [':' source SPACE] command [params] CRLF
```

| Field     | Type                | Notes                                                             |
| --------- | ------------------- | ----------------------------------------------------------------- |
| `tags`    | `Tags`              | `@key=value` map; value-less/empty tags map to `""`; `+` kept in client-only keys |
| `source`  | `Source \| null`    | `nick!user@host` prefix, or `null`                                |
| `command` | `string`            | Textual command or 3-digit numeric (leading zeros preserved)      |
| `params`  | `readonly string[]` | Trailing param is the final element, unmarked                     |

### Normalization

The IR is normalized, not byte-faithful. `buildMessage` re-emits the trailing
`:` only when the last param is empty, contains a space, or starts with `:`. So
a colon-eligible-but-unnecessary trailing round-trips with the colon dropped
(`… :foo` → `… foo`), and `key=` collapses to `key`. Messages whose trailing
param genuinely needs the colon round-trip exactly.

## Scripts

- `bun test` — run the test suite
- `bun run typecheck` — `tsc --noEmit`
- `bun run build` — bundle to `dist/`
- `bun run clean` — remove `dist/`
