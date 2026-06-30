import { Bot, loadConfig } from "@mojo-jojo/bot";

// Thin entrypoint: load config.toml (override the path with BOT_CONFIG; secrets come
// from IRC_PASSWORD / IRC_SASL_USER / IRC_SASL_PASS), then run the bot. The Bot installs
// SIGINT/SIGTERM handlers for a graceful shutdown.
const bot = new Bot(await loadConfig());
await bot.start();
