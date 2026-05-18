import { loadConfig } from "./config";

const config = loadConfig();

console.log(
  JSON.stringify({
    level: "info",
    msg: "snapshot worker placeholder started",
    snapshotStoreMode: config.SNAPSHOT_STORE_MODE,
    intervalSeconds: config.SNAPSHOT_CHECK_INTERVAL_SECONDS
  })
);
