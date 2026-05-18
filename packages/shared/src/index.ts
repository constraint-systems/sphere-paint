import { z } from "zod";

export const drawingPalette = [
  "#111111",
  "#ffffff",
  "#d92d20",
  "#f97316",
  "#facc15",
  "#16a34a",
  "#2563eb",
  "#7c3aed",
  "#7c4a2d",
  "#d2b48c"
] as const;

export const brushSizes = ["fine", "bold"] as const;

export const brushAngularWidths = {
  fine: 0.006,
  bold: 0.014
} as const satisfies Record<(typeof brushSizes)[number], number>;

export const pointSamplingDistanceRatio = 0.3;

export const viewSettings = {
  initialZoom: 0,
  drawingZoomThreshold: 0.65,
  comfortableDrawingZoom: 0.8,
  minZoom: 0,
  maxZoom: 1
} as const;

export const visitTimeoutSeconds = 120;
export const snapshotStabilizationDelaySeconds = 60;

export const colorSchema = z.enum(drawingPalette);
export const brushSizeSchema = z.enum(brushSizes);

export const unitVectorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite()
});

export const drawingPathSchema = z.array(unitVectorSchema).min(1);

export const drawingSchema = z.object({
  id: z.string().min(1),
  worldId: z.string().min(1),
  visitId: z.string().min(1),
  path: drawingPathSchema,
  color: colorSchema,
  brushSize: brushSizeSchema,
  createdRevision: z.number().int().positive(),
  createdAt: z.string().datetime()
});

export const snapshotFaceNameSchema = z.enum(["px", "nx", "py", "ny", "pz", "nz"]);
export const cubeFaceNames = snapshotFaceNameSchema.options;

export const snapshotFacesSchema = z.record(
  snapshotFaceNameSchema,
  z.object({
    url: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    visitId: z.string().optional(),
    lastSeenRevision: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("stroke_started"),
    strokeId: z.string().min(1),
    point: unitVectorSchema,
    color: colorSchema,
    brushSize: brushSizeSchema
  }),
  z.object({
    type: z.literal("stroke_updated"),
    strokeId: z.string().min(1),
    points: drawingPathSchema
  }),
  z.object({
    type: z.literal("stroke_cancelled"),
    strokeId: z.string().min(1)
  }),
  z.object({
    type: z.literal("drawing_commit_requested"),
    strokeId: z.string().min(1),
    path: drawingPathSchema,
    color: colorSchema,
    brushSize: brushSizeSchema
  }),
  z.object({
    type: z.literal("ping"),
    nonce: z.string().optional()
  })
]);

export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribed"),
    visitId: z.string().min(1),
    presenceCount: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("presence_changed"),
    presenceCount: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("stroke_started"),
    visitId: z.string().min(1),
    connectionId: z.string().min(1),
    strokeId: z.string().min(1),
    point: unitVectorSchema,
    color: colorSchema,
    brushSize: brushSizeSchema
  }),
  z.object({
    type: z.literal("stroke_updated"),
    visitId: z.string().min(1),
    connectionId: z.string().min(1),
    strokeId: z.string().min(1),
    points: drawingPathSchema
  }),
  z.object({
    type: z.literal("stroke_cancelled"),
    visitId: z.string().min(1),
    connectionId: z.string().min(1),
    strokeId: z.string().min(1)
  }),
  z.object({
    type: z.literal("drawing_committed"),
    revision: z.number().int().positive(),
    drawing: drawingSchema
  }),
  z.object({
    type: z.literal("snapshot_promoted"),
    revision: z.number().int().positive(),
    snapshotId: z.string().min(1),
    faces: snapshotFacesSchema,
    bakedDrawingIds: z.array(z.string()).optional(),
    cutoffRevision: z.number().int().positive()
  }),
  z.object({
    type: z.literal("world_reset"),
    revision: z.number().int().positive()
  }),
  z.object({
    type: z.literal("error"),
    code: z.enum([
      "invalid_visit",
      "validation_failed",
      "rate_limited",
      "stale_revision",
      "server_error"
    ]),
    message: z.string().optional()
  }),
  z.object({
    type: z.literal("pong"),
    nonce: z.string().optional()
  })
]);

export type DrawingColor = (typeof drawingPalette)[number];
export type BrushSize = (typeof brushSizes)[number];
export type CubeFaceName = (typeof cubeFaceNames)[number];
export type UnitVector = z.infer<typeof unitVectorSchema>;
export type Drawing = z.infer<typeof drawingSchema>;
export type SnapshotFaces = z.infer<typeof snapshotFacesSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;

export function vectorLength(vector: UnitVector): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

export function normalizeVector(vector: UnitVector): UnitVector {
  const length = vectorLength(vector);

  if (length === 0) {
    throw new Error("Cannot normalize a zero-length vector");
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length
  };
}

export function isApproximatelyUnitVector(vector: UnitVector, tolerance = 0.001): boolean {
  return Math.abs(vectorLength(vector) - 1) <= tolerance;
}

export function dotProduct(a: UnitVector, b: UnitVector): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function angularDistance(a: UnitVector, b: UnitVector): number {
  const normalizedA = normalizeVector(a);
  const normalizedB = normalizeVector(b);
  const dot = Math.min(1, Math.max(-1, dotProduct(normalizedA, normalizedB)));

  return Math.acos(dot);
}

export function shouldStorePathPoint(
  previousPoint: UnitVector | undefined,
  nextPoint: UnitVector,
  brushSize: BrushSize,
  distanceRatio = pointSamplingDistanceRatio
): boolean {
  if (!previousPoint) {
    return true;
  }

  return angularDistance(previousPoint, nextPoint) >= brushAngularWidths[brushSize] * distanceRatio;
}

export type CubeFaceProjection = {
  face: CubeFaceName;
  u: number;
  v: number;
};

export function projectUnitVectorToCubeFace(vector: UnitVector): CubeFaceProjection {
  const normalized = normalizeVector(vector);
  const absX = Math.abs(normalized.x);
  const absY = Math.abs(normalized.y);
  const absZ = Math.abs(normalized.z);

  if (absX >= absY && absX >= absZ) {
    const positive = normalized.x >= 0;
    return {
      face: positive ? "px" : "nx",
      u: positive ? -normalized.z / absX : normalized.z / absX,
      v: normalized.y / absX
    };
  }

  if (absY >= absX && absY >= absZ) {
    const positive = normalized.y >= 0;
    return {
      face: positive ? "py" : "ny",
      u: normalized.x / absY,
      v: positive ? -normalized.z / absY : normalized.z / absY
    };
  }

  const positive = normalized.z >= 0;
  return {
    face: positive ? "pz" : "nz",
    u: positive ? normalized.x / absZ : -normalized.x / absZ,
    v: normalized.y / absZ
  };
}

export function cubeProjectionToTextureUv(projection: CubeFaceProjection): { u: number; v: number } {
  return {
    u: (projection.u + 1) / 2,
    v: (1 - projection.v) / 2
  };
}

export function isNearCubeFaceEdge(projection: CubeFaceProjection, padding = 0.02): boolean {
  const distanceToEdge = 1 - Math.max(Math.abs(projection.u), Math.abs(projection.v));

  return distanceToEdge <= padding;
}

export function clampZoom(zoom: number): number {
  return Math.min(viewSettings.maxZoom, Math.max(viewSettings.minZoom, zoom));
}

export function isDrawingZoom(zoom: number): boolean {
  return clampZoom(zoom) >= viewSettings.drawingZoomThreshold;
}

export type SnapshotEligibilityInput = {
  status: "active" | "baked";
  createdRevision: number;
  createdAt: Date;
  snapshotId?: string | null;
};

export function isSnapshotEligible(
  drawing: SnapshotEligibilityInput,
  cutoffRevision: number,
  now: Date,
  eligibilityDelaySeconds = snapshotStabilizationDelaySeconds
): boolean {
  if (drawing.status !== "active" || drawing.snapshotId) {
    return false;
  }

  if (drawing.createdRevision > cutoffRevision) {
    return false;
  }

  const ageMilliseconds = now.getTime() - drawing.createdAt.getTime();

  return ageMilliseconds >= eligibilityDelaySeconds * 1000;
}
