import { loadConfig } from "./config";
import { createDb } from "./db/client";
import { createSnapshotStore } from "./snapshot-store";
import { SnapshotWorker } from "./snapshot-worker";
import { WorldService } from "./world-service";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const worldService = new WorldService(db, config);
const store = createSnapshotStore(config);
const worker = new SnapshotWorker(worldService, config, store);

const log = (level: string, msg: string, extra?: object) =>
  console.log(JSON.stringify({ level, msg, ...extra }));

async function tick() {
  try {
    const event = await worker.runCheck();
    if (event) {
      log("info", "snapshot promoted", {
        snapshotId: event.snapshotId,
        revision: event.revision,
        bakedCount: event.bakedDrawingIds?.length ?? 0,
      });
    } else {
      log("debug", "snapshot check: no snapshot needed");
    }
  } catch (error) {
    log("error", "snapshot check failed", { error: String(error) });
  }
}

log("info", "snapshot worker started", {
  snapshotStoreMode: config.SNAPSHOT_STORE_MODE,
  intervalSeconds: config.SNAPSHOT_CHECK_INTERVAL_SECONDS,
});

await tick();
setInterval(tick, config.SNAPSHOT_CHECK_INTERVAL_SECONDS * 1000);

process.on("SIGTERM", async () => {
  log("info", "snapshot worker stopping");
  await pool.end();
  process.exit(0);
});
