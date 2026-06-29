// Package-internal capability symbols for the entity layer.
//
// These keep the *integrity-sensitive* operations — pushing an event into an
// entity's stream and completing that stream — off the ordinary public API. Only
// the dispatcher and StateStore import this module, and the symbols are NOT
// re-exported from `index.ts`, so normal consumer code holding a `Channel`/`User`
// reference (e.g. from `client.channel()`) won't accidentally emit/complete a
// stream. This is an encapsulation boundary, not a security one: a determined
// same-process caller can still reach these via reflection
// (`Object.getOwnPropertySymbols(Object.getPrototypeOf(entity))`). Network/inbound
// data, which cannot invoke JS methods, can never forge events through it.
//
// State-field mutators (rename/setTopic/addMode/…) remain `@internal`-documented
// methods under the single-writer (StateStore) convention; M5 ("finalize the
// entity API") may harden those further.

/** Push an event into a {@link ReactiveEntity}'s stream. */
export const EMIT = Symbol("irc-client.emit");

/** Complete a {@link ReactiveEntity}'s stream and drop its listeners. */
export const DISPOSE = Symbol("irc-client.dispose");
