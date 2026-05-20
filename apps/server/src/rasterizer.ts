import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  brushAngularWidths,
  cubeFaceNames,
  cubeProjectionToTextureUv,
  projectUnitVectorToCubeFace,
  type BrushSize,
  type CubeFaceName,
  type Drawing,
  type UnitVector,
} from "@globe2/shared";

const faceSize = 2048;

function brushPixelWidth(brushSize: BrushSize): number {
  return Math.max(2, brushAngularWidths[brushSize] * faceSize * 2.5);
}

function nlerpUnitVectors(a: UnitVector, b: UnitVector, t: number): UnitVector {
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const z = a.z + (b.z - a.z) * t;
  const len = Math.hypot(x, y, z);
  return { x: x / len, y: y / len, z: z / len };
}

function findSeamCrossing(
  a: UnitVector,
  b: UnitVector,
  faceA: string,
): { onA: UnitVector; onB: UnitVector } {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const p = nlerpUnitVectors(a, b, mid);
    if (projectUnitVectorToCubeFace(p).face === faceA) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return {
    onA: nlerpUnitVectors(a, b, lo),
    onB: nlerpUnitVectors(a, b, hi),
  };
}

function paintDrawing(
  contexts: Record<string, SKRSContext2D>,
  drawing: Pick<Drawing, "path" | "color" | "brushSize">,
) {
  if (drawing.path.length === 0) return;

  const pathsByFace = new Map<string, Array<Array<{ x: number; y: number }>>>();

  const getFacePaths = (face: string) => {
    let paths = pathsByFace.get(face);
    if (!paths) {
      paths = [];
      pathsByFace.set(face, paths);
    }
    return paths;
  };

  const toPixel = (uv: { u: number; v: number }) => ({
    x: uv.u * faceSize,
    y: uv.v * faceSize,
  });

  let prevPoint = drawing.path[0];
  const firstProjection = projectUnitVectorToCubeFace(prevPoint);
  let currentFace = firstProjection.face;
  let currentSubPath: Array<{ x: number; y: number }> = [
    toPixel(cubeProjectionToTextureUv(firstProjection)),
  ];
  getFacePaths(currentFace).push(currentSubPath);

  for (let i = 1; i < drawing.path.length; i++) {
    const point = drawing.path[i];
    const projection = projectUnitVectorToCubeFace(point);
    const uv = cubeProjectionToTextureUv(projection);

    if (projection.face === currentFace) {
      currentSubPath.push(toPixel(uv));
    } else {
      const { onA, onB } = findSeamCrossing(prevPoint, point, currentFace);
      currentSubPath.push(
        toPixel(cubeProjectionToTextureUv(projectUnitVectorToCubeFace(onA))),
      );
      currentFace = projection.face;
      currentSubPath = [
        toPixel(cubeProjectionToTextureUv(projectUnitVectorToCubeFace(onB))),
        toPixel(uv),
      ];
      getFacePaths(currentFace).push(currentSubPath);
    }

    prevPoint = point;
  }

  for (const [faceName, subPaths] of pathsByFace) {
    const ctx = contexts[faceName];
    if (!ctx) continue;

    ctx.save();
    ctx.strokeStyle = drawing.color;
    ctx.fillStyle = drawing.color;
    ctx.lineWidth = brushPixelWidth(drawing.brushSize);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const subPath of subPaths) {
      if (subPath.length === 0) continue;
      if (subPath.length === 1) {
        ctx.beginPath();
        ctx.arc(subPath[0].x, subPath[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(subPath[0].x, subPath[0].y);
        for (let j = 1; j < subPath.length; j++) {
          ctx.lineTo(subPath[j].x, subPath[j].y);
        }
        ctx.stroke();
      }
    }

    ctx.restore();
  }
}

export async function rasterizeDrawings(
  drawings: Array<Pick<Drawing, "path" | "color" | "brushSize">>,
  baseFaceBuffers: Partial<Record<CubeFaceName, Buffer | null>>,
): Promise<Record<CubeFaceName, Buffer>> {
  const canvases = {} as Record<CubeFaceName, Canvas>;
  const contexts = {} as Record<string, SKRSContext2D>;
  for (const face of cubeFaceNames) {
    const canvas = createCanvas(faceSize, faceSize);
    canvases[face] = canvas;
    contexts[face] = canvas.getContext("2d");
  }

  for (const face of cubeFaceNames) {
    const ctx = contexts[face];
    const baseBuffer = baseFaceBuffers[face];
    if (baseBuffer) {
      const img = await loadImage(baseBuffer);
      ctx.drawImage(img, 0, 0, faceSize, faceSize);
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, faceSize, faceSize);
    }
  }

  for (const drawing of drawings) {
    paintDrawing(contexts, drawing);
  }

  const result = {} as Record<CubeFaceName, Buffer>;
  for (const face of cubeFaceNames) {
    result[face] = await canvases[face].encode("png");
  }
  return result;
}
