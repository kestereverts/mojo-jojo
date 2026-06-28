// Named constants for the IRC numeric replies this client reacts to.
//
// Numerics are three-digit strings (leading zeros preserved, matching the
// `Message.command` representation from @mojo-jojo/irc-message). Grouping them
// here keeps `dispatch`/`registration` free of magic numbers and gives a single
// place to cross-reference the spec.
//
// Only the numerics the client actually handles are named; the long tail is
// still reachable as raw strings on `Message.command`.
//
// @see https://modern.ircdocs.horse/#numerics
// @see https://defs.ircdocs.horse/defs/numerics

// ---- Registration / welcome burst ----
/** First message after a successful registration; marks the client "registered". */
export const RPL_WELCOME = "001";
/** Server host/version banner. */
export const RPL_YOURHOST = "002";
/** Server creation date. */
export const RPL_CREATED = "003";
/** Server name, version, and supported user/channel modes. */
export const RPL_MYINFO = "004";
/** ISUPPORT tokens (one or more lines of `KEY=value` advertising server limits). */
export const RPL_ISUPPORT = "005";

// ---- MOTD ----
/** Start of the message of the day. */
export const RPL_MOTDSTART = "375";
/** A single MOTD line. */
export const RPL_MOTD = "372";
/** End of the message of the day. */
export const RPL_ENDOFMOTD = "376";
/** Sent instead of the MOTD when the server has none. */
export const ERR_NOMOTD = "422";

// ---- Names / topic / who (parsed in M3) ----
export const RPL_WHOREPLY = "352";
export const RPL_ENDOFWHO = "315";
/** WHOX reply (RPL_WHOSPCRPL). */
export const RPL_WHOSPCRPL = "354";
export const RPL_NAMREPLY = "353";
export const RPL_ENDOFNAMES = "366";
export const RPL_TOPIC = "332";
export const RPL_TOPICWHOTIME = "333";
export const RPL_NOTOPIC = "331";

// ---- Registration error / nick negotiation ----
/** Requested nick is already in use — registration falls back to an alternate. */
export const ERR_NICKNAMEINUSE = "433";
/** Requested nick is malformed or disallowed by the server. */
export const ERR_ERRONEUSNICKNAME = "432";
/** Nick collision (rare during registration, but treated like 433). */
export const ERR_NICKCOLLISION = "436";
/** Some servers send this if a nick is needed before the chosen one is set. */
export const ERR_NONICKNAMEGIVEN = "431";
/** Sent when a command is issued before the client has registered. */
export const ERR_NOTREGISTERED = "451";
/** Unknown command — used to detect a server that does not understand `CAP`. */
export const ERR_UNKNOWNCOMMAND = "421";
/** The supplied server password (`PASS`) was wrong — fatal during registration. */
export const ERR_PASSWDMISMATCH = "464";
/** The client is K-/G-lined (banned) — fatal during registration. */
export const ERR_YOUREBANNEDCREEP = "465";

// ---- SASL (M4) ----
/** Logged in to an account (`<nick> <nick!user@host> <account> :…`). */
export const RPL_LOGGEDIN = "900";
/** Logged out of an account. */
export const RPL_LOGGEDOUT = "901";
/** Account is locked/unavailable — a terminal SASL failure. */
export const ERR_NICKLOCKED = "902";
/** SASL authentication was successful. */
export const RPL_SASLSUCCESS = "903";
/** SASL authentication failed (bad credentials). */
export const ERR_SASLFAIL = "904";
/** SASL message too long. */
export const ERR_SASLTOOLONG = "905";
/** SASL aborted by the client (`AUTHENTICATE *`). */
export const ERR_SASLABORTED = "906";
/** SASL already authenticated on this connection. */
export const ERR_SASLALREADY = "907";
/** Advertises the SASL mechanisms the server supports. */
export const RPL_SASLMECHS = "908";

/**
 * Every numeric that belongs to the SASL exchange (900–908). Used by the
 * registration coordinator to route SASL replies to the {@link SaslSession}
 * rather than the generic handler.
 */
export const SASL_NUMERICS: ReadonlySet<string> = new Set([
  RPL_LOGGEDIN,
  RPL_LOGGEDOUT,
  ERR_NICKLOCKED,
  RPL_SASLSUCCESS,
  ERR_SASLFAIL,
  ERR_SASLTOOLONG,
  ERR_SASLABORTED,
  ERR_SASLALREADY,
  RPL_SASLMECHS,
]);

/**
 * Numerics that fatally end the registration handshake before `001` — the
 * coordinator rejects on these instead of waiting for the timeout. Nick-in-use
 * (`433`/`436`) is excluded: it is recoverable via the alt-nick fallback.
 */
export const REGISTRATION_FATAL_NUMERICS: ReadonlySet<string> = new Set([
  ERR_ERRONEUSNICKNAME,
  ERR_NONICKNAMEGIVEN,
  ERR_PASSWDMISMATCH,
  ERR_YOUREBANNEDCREEP,
]);
