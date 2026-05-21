import { describe, expect, it } from "vitest";
import {
  angularDistance,
  brushAngularWidths,
  clientMessageSchema,
  cubeProjectionToTextureUv,
  drawingPalette,
  isApproximatelyUnitVector,
  isDrawingZoom,
  isNearCubeFaceEdge,
  isSnapshotEligible,
  normalizeVector,
  projectUnitVectorToCubeFace,
  serverEventSchema,
  shouldStorePathPoint,
  viewSettings
} from "./index";

describe("shared contracts", () => {
  it("keeps the v1 drawing palette fixed at ten colors", () => {
    expect(drawingPalette).toEqual([
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
    ]);
  });

  it("validates unit vectors with tolerance", () => {
    expect(isApproximatelyUnitVector({ x: 1, y: 0, z: 0 })).toBe(true);
    expect(isApproximatelyUnitVector({ x: 2, y: 0, z: 0 })).toBe(false);
  });

  it("normalizes vectors for canonical sphere coordinates", () => {
    expect(normalizeVector({ x: 2, y: 0, z: 0 })).toEqual({ x: 1, y: 0, z: 0 });
    expect(() => normalizeVector({ x: 0, y: 0, z: 0 })).toThrow("zero-length");
  });

  it("measures angular distance on the sphere", () => {
    expect(angularDistance({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(
      Math.PI / 2
    );
  });

  it("selects cube faces from dominant vector axes", () => {
    expect(projectUnitVectorToCubeFace({ x: 1, y: 0, z: 0 }).face).toBe("px");
    expect(projectUnitVectorToCubeFace({ x: -1, y: 0, z: 0 }).face).toBe("nx");
    expect(projectUnitVectorToCubeFace({ x: 0, y: 1, z: 0 }).face).toBe("py");
    expect(projectUnitVectorToCubeFace({ x: 0, y: -1, z: 0 }).face).toBe("ny");
    expect(projectUnitVectorToCubeFace({ x: 0, y: 0, z: 1 }).face).toBe("pz");
    expect(projectUnitVectorToCubeFace({ x: 0, y: 0, z: -1 }).face).toBe("nz");
  });

  it("projects cube face coordinates to texture UV space", () => {
    expect(cubeProjectionToTextureUv({ face: "px", u: -1, v: 1 })).toEqual({ u: 0, v: 0 });
    expect(cubeProjectionToTextureUv({ face: "px", u: 1, v: -1 })).toEqual({ u: 1, v: 1 });
    expect(cubeProjectionToTextureUv({ face: "px", u: 0, v: 0 })).toEqual({ u: 0.5, v: 0.5 });
  });

  it("detects points that need cube-face edge bleed", () => {
    expect(isNearCubeFaceEdge({ face: "px", u: 0.99, v: 0 })).toBe(true);
    expect(isNearCubeFaceEdge({ face: "px", u: 0, v: 0 })).toBe(false);
  });

  it("samples path points using brush-relative angular distance", () => {
    const previous = { x: 1, y: 0, z: 0 };
    const tooClose = normalizeVector({ x: 1, y: brushAngularWidths.fine * 0.1, z: 0 });
    const farEnough = normalizeVector({ x: 1, y: brushAngularWidths.fine, z: 0 });

    expect(shouldStorePathPoint(undefined, previous, "fine")).toBe(true);
    expect(shouldStorePathPoint(previous, tooClose, "fine")).toBe(false);
    expect(shouldStorePathPoint(previous, farEnough, "fine")).toBe(true);
  });

  it("derives drawing mode from normalized zoom", () => {
    expect(isDrawingZoom(viewSettings.drawingZoomThreshold - 0.01)).toBe(false);
    expect(isDrawingZoom(viewSettings.drawingZoomThreshold)).toBe(true);
    expect(isDrawingZoom(2)).toBe(true);
  });

  it("parses a subscribe message", () => {
    expect(clientMessageSchema.parse({ type: "subscribe", lastSeenRevision: 0 })).toEqual({
      type: "subscribe",
      lastSeenRevision: 0
    });
  });

  it("allows drawing commit confirmations to identify the originating stroke", () => {
    const event = serverEventSchema.parse({
      type: "drawing_committed",
      revision: 1,
      strokeId: "stroke-1",
      drawing: {
        id: "drawing-1",
        worldId: "world-1",
        visitId: "visit-1",
        path: [{ x: 1, y: 0, z: 0 }],
        color: "#111111",
        brushSize: "fine",
        createdRevision: 1,
        createdAt: "2026-05-21T00:00:00.000Z"
      }
    });

    expect(event).toMatchObject({ type: "drawing_committed", strokeId: "stroke-1" });
  });

  it("keeps committed drawings permanent by omitting undo protocol messages", () => {
    expect(clientMessageSchema.safeParse({ type: "undo_requested" }).success).toBe(false);
    expect(
      serverEventSchema.safeParse({
        type: "drawing_undone",
        revision: 1,
        drawingId: "drawing-1",
        undoneAt: "2026-05-17T00:00:00.000Z"
      }).success
    ).toBe(false);
    expect(serverEventSchema.safeParse({ type: "error", code: "not_undoable" }).success).toBe(
      false
    );
  });

  it("checks snapshot eligibility by status, cutoff revision, and stabilization age", () => {
    const now = new Date("2026-05-17T00:00:00.000Z");
    const oldEnough = new Date("2026-05-16T23:58:59.000Z");
    const tooYoung = new Date("2026-05-16T23:59:30.000Z");

    expect(
      isSnapshotEligible(
        { status: "active", createdRevision: 10, createdAt: oldEnough, snapshotId: null },
        10,
        now
      )
    ).toBe(true);
    expect(
      isSnapshotEligible(
        { status: "active", createdRevision: 10, createdAt: tooYoung, snapshotId: null },
        10,
        now
      )
    ).toBe(false);
    expect(
      isSnapshotEligible(
        { status: "active", createdRevision: 11, createdAt: oldEnough, snapshotId: null },
        10,
        now
      )
    ).toBe(false);
    expect(
      isSnapshotEligible(
        { status: "active", createdRevision: 10, createdAt: oldEnough, snapshotId: "snapshot-1" },
        10,
        now
      )
    ).toBe(false);
  });
});
