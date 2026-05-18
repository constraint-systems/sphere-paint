import { loadConfig } from "./config";
import { createApp } from "./app";

const config = loadConfig();
const app = createApp(config);

await app.listen({
  host: config.SERVER_HOST,
  port: config.SERVER_PORT
});
