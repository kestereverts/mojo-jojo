import type { ModuleFactory } from "../module/types.ts";
import { pingModule } from "./ping.ts";
import { helpModule } from "./help.ts";
import { adminModule } from "./admin.ts";
import { ctcpModule } from "./ctcp.ts";
import { autojoinModule } from "./autojoin.ts";

export { pingModule, helpModule, adminModule, ctcpModule, autojoinModule };

/**
 * Built-in modules, keyed by name. The bot seeds its {@link ModuleRegistry} with
 * these; a `[modules.<name>]` table enables and configures one.
 */
export const builtinModules: Readonly<Record<string, ModuleFactory>> = {
  ping: pingModule,
  help: helpModule,
  admin: adminModule,
  ctcp: ctcpModule,
  autojoin: autojoinModule,
};
