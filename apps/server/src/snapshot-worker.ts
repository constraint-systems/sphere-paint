import { randomUUID } from "node:crypto";
import { cubeFaceNames, snapshotFacesSchema, type ServerEvent } from "@globe2/shared";
import type { AppConfig } from "./config";
import { rasterizeDrawings } from "./rasterizer";
import type { SnapshotFaceStore } from "./snapshot-store";
import type { WorldService } from "./world-service";

export class SnapshotWorker {
  constructor(
    private readonly worldService: WorldService,
    private readonly config: AppConfig,
    private readonly store: SnapshotFaceStore,
  ) {}

  async runCheck(
    options: { forceRun?: boolean } = {},
  ): Promise<Extract<ServerEvent, { type: "snapshot_promoted" }> | null> {
    const worldId = await this.worldService.ensureDefaultWorld();
    const now = new Date();

    if (!options.forceRun) {
      const eligibility = await this.worldService.checkSnapshotEligibility(worldId, now);
      const oldestAgeHours =
        eligibility.oldestEligibleAgeSeconds !== null
          ? eligibility.oldestEligibleAgeSeconds / 3600
          : null;

      const shouldSnapshot =
        eligibility.count >= this.config.SNAPSHOT_MIN_ELIGIBLE_DRAWINGS ||
        (eligibility.count >= this.config.SNAPSHOT_MIN_AGED_DRAWINGS &&
          oldestAgeHours !== null &&
          oldestAgeHours >= this.config.SNAPSHOT_AGE_HOURS);

      if (!shouldSnapshot) {
        return null;
      }
    }

    const cutoffRevision = await this.worldService.getCurrentRevision(worldId);
    const eligibleDrawings = await this.worldService.getEligibleDrawings(
      worldId,
      cutoffRevision,
      now,
      options.forceRun,
    );

    if (eligibleDrawings.length === 0 && !options.forceRun) return null;

    const currentSnapshot = await this.worldService.getCurrentSnapshot(worldId);

    const baseFaceBuffers: Partial<Record<string, Buffer | null>> = {};
    for (const face of cubeFaceNames) {
      const url = currentSnapshot.faceUrls[face]?.url;
      baseFaceBuffers[face] = url ? await this.store.readFaceBuffer(url) : null;
    }

    const newFaceBuffers = await rasterizeDrawings(eligibleDrawings, baseFaceBuffers);

    const newSnapshotId = randomUUID();
    const faceUrlEntries: Record<string, { url: string; width: number; height: number }> = {};
    for (const face of cubeFaceNames) {
      const url = await this.store.writeFace(newSnapshotId, face, newFaceBuffers[face]);
      faceUrlEntries[face] = { url, width: 2048, height: 2048 };
    }

    return this.worldService.promoteSnapshot({
      worldId,
      newSnapshotId,
      faceUrls: snapshotFacesSchema.parse(faceUrlEntries),
      sourceFromRevision: currentSnapshot.promotedRevision + 1,
      sourceToRevision: cutoffRevision,
      bakedDrawingIds: eligibleDrawings.map((d) => d.id),
    });
  }
}
