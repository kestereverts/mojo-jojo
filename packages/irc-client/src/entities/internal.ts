// Package-internal capability symbols for the entity layer.
//
// These keep the *integrity-sensitive* operations — pushing an event into an
// entity's stream and completing that stream — off the public API. Only the
// dispatcher and StateStore import this module, so a consumer holding a
// `Channel`/`User` reference (e.g. from `client.channel()`) cannot forge events
// or complete another subscriber's stream. NOT re-exported from `index.ts`.
//
// State-field mutators (rename/setTopic/addMode/…) remain `@internal`-documented
// methods under the single-writer (StateStore) convention; M5 ("finalize the
// entity API") may harden those further.

/** Push an event into a {@link ReactiveEntity}'s stream. */
export const EMIT = Symbol("irc-client.emit");

/** Complete a {@link ReactiveEntity}'s stream and drop its listeners. */
export const DISPOSE = Symbol("irc-client.dispose");
