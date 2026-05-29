import {
  brushSizes,
  drawingPathSchema,
  drawingPalette,
  drawingSchema,
  isApproximatelyUnitVector,
  snapshotFacesSchema,
  snapshotStabilizationDelaySeconds,
  viewSettings,
  type BrushSize,
  type Drawing,
  type DrawingColor,
  type SnapshotFaces,
  type ServerEvent
} from "@globe2/shared";
import { and, asc, count, eq, gt, inArray, isNull, lte, min, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AppConfig } from "./config";
import {
  drawings,
  nowPlusVisitTimeout,
  snapshots,
  visits,
  worlds,
  worldEvents,
  type schema
} from "./db/schema";

export type GlobeDb = NodePgDatabase<typeof schema>;

export type BootstrapPayload = {
  worldId: string;
  visitId: string;
  snapshot: {
    id: string;
    faces: SnapshotFaces;
    promotedRevision: number;
  };
  unbakedDrawings: Drawing[];
  presenceCount: number;
  drawingSettings: {
    palette: typeof drawingPalette;
    brushSizes: typeof brushSizes;
  };
  viewSettings: typeof viewSettings;
  serverTime: string;
  revision: number;
};

export type TimelapseSnapshot = {
  id: string;
  faces: SnapshotFaces;
  sourceFromRevision: number;
  sourceToRevision: number;
  promotedRevision: number;
  promotedAt: string | null;
};

const defaultWorldId = "00000000-0000-4000-8000-000000000001";
const initialSnapshotId = "00000000-0000-4000-8000-000000000101";

function initialSnapshotFaces(): SnapshotFaces {
  return snapshotFacesSchema.parse({
    px: { url: "/snapshots/blank-v2/px.png", width: 2048, height: 2048 },
    nx: { url: "/snapshots/blank-v2/nx.png", width: 2048, height: 2048 },
    py: { url: "/snapshots/blank-v2/py.png", width: 2048, height: 2048 },
    ny: { url: "/snapshots/blank-v2/ny.png", width: 2048, height: 2048 },
    pz: { url: "/snapshots/blank-v2/pz.png", width: 2048, height: 2048 },
    nz: { url: "/snapshots/blank-v2/nz.png", width: 2048, height: 2048 }
  });
}

export class WorldService {
  constructor(
    private readonly db: GlobeDb,
    private readonly config: AppConfig
  ) {}

  async ensureDefaultWorld(): Promise<string> {
    const faces = initialSnapshotFaces();

    await this.db
      .insert(worlds)
      .values({
        id: defaultWorldId,
        currentSnapshotId: initialSnapshotId,
        currentRevision: 0
      })
      .onConflictDoNothing();

    await this.db
      .insert(snapshots)
      .values({
        id: initialSnapshotId,
        worldId: defaultWorldId,
        status: "promoted",
        faceUrls: faces,
        sourceFromRevision: 0,
        sourceToRevision: 0,
        promotedRevision: 0,
        promotedAt: new Date()
      })
      .onConflictDoUpdate({
        target: snapshots.id,
        set: {
          faceUrls: faces,
          status: "promoted",
          promotedRevision: 0,
          promotedAt: new Date()
        }
      });

    return defaultWorldId;
  }

  async bootstrap(visitId: string | undefined, presenceCount: number): Promise<BootstrapPayload> {
    const worldId = await this.ensureDefaultWorld();
    const visit = await this.ensureVisit(worldId, visitId);
    const [world] = await this.db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);

    if (!world) {
      throw new Error("Default World was not created");
    }

    const [snapshot] = await this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.id, world.currentSnapshotId ?? initialSnapshotId))
      .limit(1);

    if (!snapshot) {
      throw new Error("Default Snapshot was not created");
    }

    const unbakedDrawingRows = await this.db
      .select()
      .from(drawings)
      .where(
        and(
          eq(drawings.worldId, worldId),
          eq(drawings.status, "active"),
          isNull(drawings.snapshotId)
        )
      )
      .orderBy(asc(drawings.createdRevision));
    const unbakedDrawings = unbakedDrawingRows.map((drawing) =>
      drawingSchema.parse({
        id: drawing.id,
        worldId: drawing.worldId,
        visitId: drawing.visitId,
        path: drawing.path,
        color: normalizeDrawingColor(drawing.color),
        brushSize: drawing.brushSize,
        createdRevision: drawing.createdRevision,
        createdAt: drawing.createdAt.toISOString()
      })
    );

    return {
      worldId,
      visitId: visit.id,
      snapshot: {
        id: snapshot.id,
        faces: snapshotFacesSchema.parse(snapshot.faceUrls),
        promotedRevision: snapshot.promotedRevision ?? 0
      },
      unbakedDrawings,
      presenceCount,
      drawingSettings: {
        palette: drawingPalette,
        brushSizes
      },
      viewSettings,
      serverTime: new Date().toISOString(),
      revision: world.currentRevision
    };
  }

  async listPromotedSnapshots(): Promise<TimelapseSnapshot[]> {
    const worldId = await this.ensureDefaultWorld();
    const rows = await this.db
      .select({
        id: snapshots.id,
        faceUrls: snapshots.faceUrls,
        sourceFromRevision: snapshots.sourceFromRevision,
        sourceToRevision: snapshots.sourceToRevision,
        promotedRevision: snapshots.promotedRevision,
        promotedAt: snapshots.promotedAt
      })
      .from(snapshots)
      .where(and(eq(snapshots.worldId, worldId), eq(snapshots.status, "promoted")))
      .orderBy(asc(snapshots.promotedRevision), asc(snapshots.createdAt));

    return rows.map((snapshot) => ({
      id: snapshot.id,
      faces: snapshotFacesSchema.parse(snapshot.faceUrls),
      sourceFromRevision: snapshot.sourceFromRevision,
      sourceToRevision: snapshot.sourceToRevision,
      promotedRevision: snapshot.promotedRevision ?? 0,
      promotedAt: snapshot.promotedAt?.toISOString() ?? null
    }));
  }

  async ensureVisit(worldId: string, visitId: string | undefined) {
    if (visitId) {
      const [existingVisit] = await this.db
        .select()
        .from(visits)
        .where(and(eq(visits.id, visitId), eq(visits.worldId, worldId), eq(visits.status, "active")))
        .limit(1);

      if (existingVisit && existingVisit.expiresAt.getTime() > Date.now()) {
        const [refreshedVisit] = await this.db
          .update(visits)
          .set({
            lastSeenAt: new Date(),
            expiresAt: nowPlusVisitTimeout(this.config.VISIT_TIMEOUT_SECONDS)
          })
          .where(eq(visits.id, existingVisit.id))
          .returning();

        return refreshedVisit ?? existingVisit;
      }
    }

    const [createdVisit] = await this.db
      .insert(visits)
      .values({
        worldId,
        expiresAt: nowPlusVisitTimeout(this.config.VISIT_TIMEOUT_SECONDS)
      })
      .returning();

    if (!createdVisit) {
      throw new Error("Visit was not created");
    }

    return createdVisit;
  }

  async refreshVisit(visitId: string): Promise<boolean> {
    const [visit] = await this.db
      .update(visits)
      .set({
        lastSeenAt: new Date(),
        expiresAt: nowPlusVisitTimeout(this.config.VISIT_TIMEOUT_SECONDS)
      })
      .where(and(eq(visits.id, visitId), eq(visits.status, "active")))
      .returning();

    return Boolean(visit && visit.expiresAt.getTime() > Date.now());
  }

  async getCurrentRevision(worldId = defaultWorldId): Promise<number> {
    const [world] = await this.db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);

    return world?.currentRevision ?? 0;
  }

  async getCatchupEvents(worldId: string, lastSeenRevision: number): Promise<ServerEvent[]> {
    const [{ oldestRevision }] = await this.db
      .select({ oldestRevision: min(worldEvents.revision) })
      .from(worldEvents)
      .where(eq(worldEvents.worldId, worldId));

    if (oldestRevision !== null && oldestRevision > lastSeenRevision + 1) {
      return [
        {
          type: "error",
          code: "stale_revision",
          message: "Last seen revision is older than retained events"
        }
      ];
    }

    const events = await this.db
      .select()
      .from(worldEvents)
      .where(and(eq(worldEvents.worldId, worldId), gt(worldEvents.revision, lastSeenRevision)))
      .orderBy(asc(worldEvents.revision));

    return events.map((event) => event.payload as ServerEvent);
  }

  async appendWorldEvent(worldId: string, event: Omit<ServerEvent, "revision">): Promise<number> {
    return this.db.transaction(async (tx) => {
      const [updatedWorld] = await tx
        .update(worlds)
        .set({ currentRevision: sql`${worlds.currentRevision} + 1` })
        .where(eq(worlds.id, worldId))
        .returning({ revision: worlds.currentRevision });

      if (!updatedWorld) {
        throw new Error("World revision was not updated");
      }

      const payload = "revision" in event ? event : { ...event, revision: updatedWorld.revision };

      await tx.insert(worldEvents).values({
        revision: updatedWorld.revision,
        worldId,
        type: event.type,
        payload
      });

      return updatedWorld.revision;
    });
  }

  async checkSnapshotEligibility(
    worldId: string,
    now: Date,
  ): Promise<{ count: number; oldestEligibleAgeSeconds: number | null }> {
    const cutoffDate = new Date(now.getTime() - snapshotStabilizationDelaySeconds * 1000);
    const [result] = await this.db
      .select({
        count: count(drawings.id),
        oldestAt: min(drawings.createdAt),
      })
      .from(drawings)
      .where(
        and(
          eq(drawings.worldId, worldId),
          eq(drawings.status, "active"),
          isNull(drawings.snapshotId),
          lte(drawings.createdAt, cutoffDate),
        ),
      );

    const total = result?.count ?? 0;
    const oldestAt = result?.oldestAt ?? null;
    const oldestEligibleAgeSeconds =
      oldestAt ? (now.getTime() - oldestAt.getTime()) / 1000 : null;

    return { count: total, oldestEligibleAgeSeconds };
  }

  async getEligibleDrawings(
    worldId: string,
    cutoffRevision: number,
    now: Date,
    skipStabilization = false,
  ): Promise<Drawing[]> {
    const cutoffDate = skipStabilization
      ? now
      : new Date(now.getTime() - snapshotStabilizationDelaySeconds * 1000);
    const rows = await this.db
      .select()
      .from(drawings)
      .where(
        and(
          eq(drawings.worldId, worldId),
          eq(drawings.status, "active"),
          isNull(drawings.snapshotId),
          lte(drawings.createdRevision, cutoffRevision),
          lte(drawings.createdAt, cutoffDate),
        ),
      )
      .orderBy(asc(drawings.createdRevision));

    return rows.map((row) =>
      drawingSchema.parse({
        id: row.id,
        worldId: row.worldId,
        visitId: row.visitId,
        path: row.path,
        color: normalizeDrawingColor(row.color),
        brushSize: row.brushSize,
        createdRevision: row.createdRevision,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  }

  async getCurrentSnapshot(worldId: string): Promise<{
    id: string;
    faceUrls: SnapshotFaces;
    promotedRevision: number;
  }> {
    const [world] = await this.db
      .select()
      .from(worlds)
      .where(eq(worlds.id, worldId))
      .limit(1);
    const snapshotId = world?.currentSnapshotId ?? initialSnapshotId;
    const [snapshot] = await this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.id, snapshotId))
      .limit(1);

    if (!snapshot) throw new Error("Current snapshot not found");

    return {
      id: snapshot.id,
      faceUrls: snapshotFacesSchema.parse(snapshot.faceUrls),
      promotedRevision: snapshot.promotedRevision ?? 0,
    };
  }

  async promoteSnapshot(input: {
    worldId: string;
    newSnapshotId: string;
    faceUrls: SnapshotFaces;
    sourceFromRevision: number;
    sourceToRevision: number;
    bakedDrawingIds: string[];
  }): Promise<Extract<ServerEvent, { type: "snapshot_promoted" }>> {
    return this.db.transaction(async (tx) => {
      const [updatedWorld] = await tx
        .update(worlds)
        .set({
          currentSnapshotId: input.newSnapshotId,
          currentRevision: sql`${worlds.currentRevision} + 1`,
        })
        .where(eq(worlds.id, input.worldId))
        .returning({ revision: worlds.currentRevision });

      if (!updatedWorld) throw new Error("World revision was not updated");

      await tx.insert(snapshots).values({
        id: input.newSnapshotId,
        worldId: input.worldId,
        status: "promoted",
        faceUrls: input.faceUrls,
        sourceFromRevision: input.sourceFromRevision,
        sourceToRevision: input.sourceToRevision,
        promotedRevision: updatedWorld.revision,
        promotedAt: new Date(),
      });

      if (input.bakedDrawingIds.length > 0) {
        await tx
          .update(drawings)
          .set({ status: "baked", snapshotId: input.newSnapshotId })
          .where(inArray(drawings.id, input.bakedDrawingIds));
      }

      const event = {
        type: "snapshot_promoted",
        revision: updatedWorld.revision,
        snapshotId: input.newSnapshotId,
        faces: input.faceUrls,
        bakedDrawingIds: input.bakedDrawingIds,
        cutoffRevision: input.sourceToRevision,
      } satisfies Extract<ServerEvent, { type: "snapshot_promoted" }>;

      await tx.insert(worldEvents).values({
        revision: updatedWorld.revision,
        worldId: input.worldId,
        type: event.type,
        payload: event,
      });

      return event;
    });
  }

  async commitDrawing(input: {
    worldId?: string;
    visitId: string;
    path: unknown;
    color: DrawingColor;
    brushSize: BrushSize;
  }): Promise<Extract<ServerEvent, { type: "drawing_committed" }>> {
    const worldId = input.worldId ?? defaultWorldId;
    const path = drawingPathSchema.parse(input.path);

    if (path.length > 2048 || !path.every((point) => isApproximatelyUnitVector(point, 0.01))) {
      throw new Error("Invalid drawing path");
    }

    return this.db.transaction(async (tx) => {
      const [visit] = await tx
        .update(visits)
        .set({
          lastSeenAt: new Date(),
          expiresAt: nowPlusVisitTimeout(this.config.VISIT_TIMEOUT_SECONDS)
        })
        .where(and(eq(visits.id, input.visitId), eq(visits.worldId, worldId), eq(visits.status, "active")))
        .returning();

      if (!visit) {
        throw new Error("Invalid visit");
      }

      const [updatedWorld] = await tx
        .update(worlds)
        .set({ currentRevision: sql`${worlds.currentRevision} + 1` })
        .where(eq(worlds.id, worldId))
        .returning({ revision: worlds.currentRevision });

      if (!updatedWorld) {
        throw new Error("World revision was not updated");
      }

      const [drawing] = await tx
        .insert(drawings)
        .values({
          worldId,
          visitId: input.visitId,
          path,
          color: input.color,
          brushSize: input.brushSize,
          createdRevision: updatedWorld.revision
        })
        .returning();

      if (!drawing) {
        throw new Error("Drawing was not created");
      }

      const event = {
        type: "drawing_committed",
        revision: updatedWorld.revision,
        drawing: drawingSchema.parse({
          id: drawing.id,
          worldId: drawing.worldId,
          visitId: drawing.visitId,
          path: drawing.path,
          color: normalizeDrawingColor(drawing.color),
          brushSize: drawing.brushSize,
          createdRevision: drawing.createdRevision,
          createdAt: drawing.createdAt.toISOString()
        })
      } satisfies Extract<ServerEvent, { type: "drawing_committed" }>;

      await tx.insert(worldEvents).values({
        revision: updatedWorld.revision,
        worldId,
        type: event.type,
        payload: event
      });

      return event;
    });
  }
}

export const defaultWorld = {
  id: defaultWorldId,
  initialSnapshotId
};

function normalizeDrawingColor(color: string): DrawingColor {
  const legacyColors: Record<string, DrawingColor> = {
    black: "#111111",
    white: "#ffffff",
    red: "#d92d20",
    orange: "#f97316",
    yellow: "#facc15",
    green: "#16a34a",
    blue: "#2563eb",
    purple: "#7c3aed",
    brown: "#7c4a2d",
    tan: "#d2b48c"
  };

  return legacyColors[color] ?? (color as DrawingColor);
}
