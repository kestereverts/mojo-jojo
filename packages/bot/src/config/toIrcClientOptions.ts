import type { IrcClientOptions, TransportFactory } from "@mojo-jojo/irc-client";
import type { ServerConfig } from "./schema.ts";

/**
 * Map a validated {@link ServerConfig} onto {@link IrcClientOptions}. Optional
 * fields are omitted when absent so the client's own defaults apply (`resolveOptions`
 * is the final validation/normalization gate). `caps: "default"` is dropped so the
 * client's curated `DEFAULT_CAPS` take effect; `"all"` and explicit lists pass through.
 * `extra.transport` injects a test transport factory.
 */
export function toIrcClientOptions(
  server: ServerConfig,
  extra: { readonly transport?: TransportFactory } = {},
): IrcClientOptions {
  const caps = server.caps === "default" ? undefined : server.caps;
  return {
    host: server.host,
    nick: server.nick,
    ...(server.port !== undefined ? { port: server.port } : {}),
    ...(server.tls !== undefined ? { tls: server.tls } : {}),
    ...(server.username !== undefined ? { username: server.username } : {}),
    ...(server.realName !== undefined ? { realName: server.realName } : {}),
    ...(server.altNicks !== undefined ? { altNicks: server.altNicks } : {}),
    ...(server.password !== undefined ? { password: server.password } : {}),
    ...(server.sasl !== undefined ? { sasl: server.sasl } : {}),
    ...(caps !== undefined ? { caps } : {}),
    ...(server.whoOnJoin !== undefined ? { whoOnJoin: server.whoOnJoin } : {}),
    ...(server.reconnect !== undefined ? { reconnect: server.reconnect } : {}),
    ...(extra.transport !== undefined ? { transport: extra.transport } : {}),
  };
}
