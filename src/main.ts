import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = buildApp(config);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ port: config.port, mode: config.mode }, "pipoe listening");
  } catch (err) {
    app.log.error(err, "Failed to start pipoe");
    process.exit(1);
  }
}

void main();
