import {
  brushSizes,
  clampZoom,
  cubeFaceNames,
  cubeProjectionToTextureUv,
  drawingPalette,
  isDrawingZoom,
  projectUnitVectorToCubeFace,
  serverEventSchema,
  shouldStorePathPoint,
  viewSettings,
  brushAngularWidths,
  type BrushSize,
  type Drawing,
  type DrawingColor,
  type ServerEvent,
  type SnapshotFaces,
  type UnitVector,
} from "@globe2/shared";
import {
  CircleIcon,
  KeyIcon,
  LockIcon,
  MinusIcon,
  PlayIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

type BootstrapState =
  | { status: "loading" }
  | {
      status: "ready";
      revision: number;
      serverTime: string;
      presenceCount: number;
      visitId: string;
      snapshotFaces: SnapshotFaces;
      unbakedDrawings: Drawing[];
    }
  | { status: "error"; message: string };

const visitStorageKey = "globe2.visitId";
const revisionStorageKey = "globe2.lastSeenRevision";
const colorStorageKey = "globe2.color";
const brushStorageKey = "globe2.brushSize";
const viewStorageKey = "globe2.viewState";
const localPendingStrokesRejectedEvent = "globe2:local-pending-strokes-rejected";
const autoRotateSpeed = -0.4;
const autoRotateSecondarySpeed = 0.1;
const inertiaDamping = 0.95;
const minInertiaVelocity = 0.00035;
const startInertiaVelocity = 0.0022;
const wheelRotateSpeed = 0.0015;
const keyboardRotateSpeed = 0.006;
const keyboardZoomStep = 0.15;
const strokeUpdateBatchDelay = 40;
const partialStrokeCommitPointCount = 96;
const trackpadPixelThreshold = 40;
const viewStorageDelay = 250;
const overlayFaceSize = 1024;
const farZoomOrthographicSize = 3.8;
const closeZoomOrthographicSize = 1.25;

type QuaternionState = {
  x: number;
  y: number;
  z: number;
  w: number;
};

type ViewState = {
  zoom: number;
  orientation: QuaternionState;
};

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({
    status: "loading",
  });
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "offline"
  >("connecting");
  const [viewState, setViewState] = useState<ViewState>(() =>
    readStoredViewState(),
  );
  const [screensaverMode, setScreensaverMode] = useState(() =>
    readScreensaverModeFromUrl(),
  );
  const [selectedColor, setSelectedColor] = useState<DrawingColor>(() =>
    readStoredColor(),
  );
  const [selectedBrushSize, setSelectedBrushSize] = useState<BrushSize>(() =>
    readStoredBrushSize(),
  );
  const [aboutOpen, setAboutOpen] = useState(false);
  const [drawingLocked, setDrawingLocked] = useState(false);
  const [sphereContentReady, setSphereContentReady] = useState(false);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const viewStateRef = useRef(viewState);
  const flushStoredViewRef = useRef<() => void>(() => undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const toolRef = useRef({
    color: selectedColor,
    brushSize: selectedBrushSize,
  });
  const connectionStateRef = useRef(connectionState);
  const screensaverModeRef = useRef(screensaverMode);
  const drawingLockedRef = useRef(drawingLocked);
  const sphereContentReadyRef = useRef(sphereContentReady);
  const drawingsRef = useRef<Drawing[]>([]);
  const eventQueueRef = useRef<
    Array<
      Extract<
        ServerEvent,
        {
          type:
            | "drawing_committed"
            | "stroke_started"
            | "stroke_updated"
            | "stroke_cancelled"
            | "snapshot_promoted";
        }
      >
    >
  >([]);

  const interactionReady = bootstrap.status === "ready" && sphereContentReady;
  const drawingMode =
    interactionReady && !screensaverMode && isDrawingZoom(viewState.zoom);
  const zoomProgress =
    ((viewState.zoom - viewSettings.minZoom) /
      (viewSettings.maxZoom - viewSettings.minZoom)) *
    100;
  const zoomMarkerOffsetPx = 8 - (16 * zoomProgress) / 100;
  const drawingZoomThresholdProgress =
    ((viewSettings.drawingZoomThreshold - viewSettings.minZoom) /
      (viewSettings.maxZoom - viewSettings.minZoom)) *
    100;
  const panelClass = "pointer-events-auto bg-neutral-400";
  const buttonClass = "pointer-events-auto cursor-pointer bg-neutral-400 focus:outline-none";
  const iconClass = "size-4 shrink-0";
  const brushIconSize: Record<BrushSize, string> = {
    fine: "size-3",
    bold: "size-5",
  };
  const statusOverlay =
    bootstrap.status === "error"
      ? { tone: "error" as const, message: bootstrap.message }
      : bootstrap.status === "loading"
        ? { tone: "loading" as const, message: "Loading" }
        : !sphereContentReady
          ? { tone: "loading" as const, message: "Loading" }
        : connectionState === "connecting"
          ? { tone: "loading" as const, message: "Connecting" }
          : connectionState === "offline"
            ? { tone: "error" as const, message: "Connection lost" }
            : undefined;

  useEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  useEffect(() => {
    toolRef.current = { color: selectedColor, brushSize: selectedBrushSize };
  }, [selectedColor, selectedBrushSize]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    screensaverModeRef.current = screensaverMode;
  }, [screensaverMode]);

  useEffect(() => {
    drawingLockedRef.current = drawingLocked;
  }, [drawingLocked]);

  useEffect(() => {
    sphereContentReadyRef.current = sphereContentReady;
  }, [sphereContentReady]);

  useEffect(() => {
    if (!drawingMode && drawingLocked) {
      setDrawingLocked(false);
    }
  }, [drawingLocked, drawingMode]);

  useEffect(() => {
    const controller = new AbortController();

    const visitId = window.localStorage.getItem(visitStorageKey);

    fetch("/api/bootstrap", {
      headers: visitId ? { "x-visit-id": visitId } : undefined,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Bootstrap failed with ${response.status}`);
        }

        return response.json() as Promise<{
          revision: number;
          serverTime: string;
          presenceCount: number;
          visitId: string;
          snapshot: { faces: SnapshotFaces };
          unbakedDrawings: Drawing[];
        }>;
      })
      .then((payload) => {
        window.localStorage.setItem(visitStorageKey, payload.visitId);
        setBootstrap({
          status: "ready",
          revision: payload.revision,
          serverTime: payload.serverTime,
          presenceCount: payload.presenceCount,
          visitId: payload.visitId,
          snapshotFaces: payload.snapshot.faces,
          unbakedDrawings: payload.unbakedDrawings,
        });
        drawingsRef.current = payload.unbakedDrawings;
        window.localStorage.setItem(
          revisionStorageKey,
          String(payload.revision),
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setBootstrap({
          status: "error",
          message: error instanceof Error ? error.message : "Bootstrap failed",
        });
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (bootstrap.status !== "ready") {
      return;
    }

    let closed = false;
    let socket: WebSocket | undefined;
    let reconnectTimeout: number | undefined;
    let reconnectAttempt = 0;

    const connect = () => {
      setConnectionState("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        const lastSeenRevision = Number(
          window.localStorage.getItem(revisionStorageKey) ?? "0",
        );
        socket?.send(
          JSON.stringify({
            type: "subscribe",
            visitId: bootstrap.visitId,
            lastSeenRevision,
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        const rawEvent = parseJson(String(event.data));

        if (!rawEvent.ok) {
          return;
        }

        const parsed = serverEventSchema.safeParse(rawEvent.value);

        if (!parsed.success) {
          return;
        }

        const serverEvent = parsed.data;

        if (serverEvent.type === "subscribed") {
          setConnectionState("connected");
          window.localStorage.setItem(visitStorageKey, serverEvent.visitId);
          window.localStorage.setItem(
            revisionStorageKey,
            String(serverEvent.revision),
          );
          setBootstrap((current) =>
            current.status === "ready"
              ? {
                  ...current,
                  visitId: serverEvent.visitId,
                  presenceCount: serverEvent.presenceCount,
                  revision: serverEvent.revision,
                }
              : current,
          );
          return;
        }

        if (serverEvent.type === "presence_changed") {
          setBootstrap((current) =>
            current.status === "ready"
              ? { ...current, presenceCount: serverEvent.presenceCount }
              : current,
          );
          return;
        }

        if (
          serverEvent.type === "stroke_started" ||
          serverEvent.type === "stroke_updated" ||
          serverEvent.type === "stroke_cancelled" ||
          serverEvent.type === "drawing_committed" ||
          serverEvent.type === "snapshot_promoted"
        ) {
          eventQueueRef.current.push(serverEvent);
        }

        if ("revision" in serverEvent) {
          window.localStorage.setItem(
            revisionStorageKey,
            String(serverEvent.revision),
          );
          setBootstrap((current) =>
            current.status === "ready"
              ? { ...current, revision: serverEvent.revision }
              : current,
          );
        }
      });

      socket.addEventListener("close", () => {
        if (closed) {
          return;
        }

        setConnectionState("offline");
        socketRef.current = undefined;
        window.dispatchEvent(new Event(localPendingStrokesRejectedEvent));
        const delay = Math.min(5000, 250 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        reconnectTimeout = window.setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    };

    connect();

    return () => {
      closed = true;
      socket?.close();
      socketRef.current = undefined;

      if (reconnectTimeout) {
        window.clearTimeout(reconnectTimeout);
      }
    };
  }, [bootstrap.status === "ready" ? bootstrap.visitId : undefined]);

  useEffect(() => {
    window.localStorage.setItem(colorStorageKey, selectedColor);
  }, [selectedColor]);

  useEffect(() => {
    window.localStorage.setItem(brushStorageKey, selectedBrushSize);
  }, [selectedBrushSize]);

  useEffect(() => {
    const host = canvasHostRef.current;

    if (!host || bootstrap.status !== "ready") {
      return;
    }

    setSphereContentReady(false);
    sphereContentReadyRef.current = false;
    let disposed = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.append(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);
    const geometry = new THREE.SphereGeometry(1, 96, 64);
    const wireframeGeometry = new THREE.SphereGeometry(1, 32, 16);
    const fallbackTexture = createFallbackCubeTexture();
    const overlay = createOverlayCubeTexture();
    const transientOverlay = createOverlayCubeTexture();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        cubeMap: { value: fallbackTexture },
        overlayMap: { value: overlay.texture },
        transientOverlayMap: { value: transientOverlay.texture },
      },
      vertexShader: `
        varying vec3 vLocalNormal;
        varying vec3 vViewNormal;
        void main() {
          vLocalNormal = normalize(normal);
          vViewNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform samplerCube cubeMap;
        uniform samplerCube overlayMap;
        uniform samplerCube transientOverlayMap;
        varying vec3 vLocalNormal;
        varying vec3 vViewNormal;
        void main() {
          vec3 localNormal = normalize(vLocalNormal);
          vec3 viewNormal = normalize(vViewNormal);
          vec3 paint = textureCube(cubeMap, localNormal).rgb;
          vec4 overlay = textureCube(overlayMap, localNormal);
          vec4 transientOverlay = textureCube(transientOverlayMap, localNormal);
          vec3 committedPaint = mix(paint, overlay.rgb, overlay.a);
          vec3 spherePaint = mix(committedPaint, transientOverlay.rgb, transientOverlay.a);
          float rim = 1.0 - smoothstep(0.0, 0.55, abs(viewNormal.z));
          vec3 shadedPaint = spherePaint * (1.0 - rim * 0.32);
          gl_FragColor = vec4(shadedPaint, 1.0);
        }
      `,
    });
    const wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x444444,
      wireframe: true,
      transparent: true,
      opacity: 0.48,
    });
    const sphere = new THREE.Mesh(geometry, material);
    const wireframeSphere = new THREE.Mesh(wireframeGeometry, wireframeMaterial);
    sphere.visible = false;
    const transientStrokes = new Map<
      string,
      Pick<Drawing, "path" | "color" | "brushSize">
    >();
    const pendingLocalStrokes = new Map<
      string,
      Pick<Drawing, "path" | "color" | "brushSize">
    >();
    scene.add(sphere);
    scene.add(wireframeSphere);

    drawingsRef.current = orderDrawingsForPaint(drawingsRef.current);
    for (const drawing of drawingsRef.current) {
      paintDrawingOnOverlay(overlay, drawing);
    }
    overlay.texture.needsUpdate = true;

    const revealPaintedSphere = () => {
      if (disposed) {
        return;
      }

      sphere.visible = true;
      wireframeSphere.visible = false;
      sphereContentReadyRef.current = true;
      setSphereContentReady(true);
    };

    const faceUrls = cubeFaceNames.map(
      (faceName) => bootstrap.snapshotFaces[faceName]?.url,
    );
    if (faceUrls.every((url): url is string => Boolean(url))) {
      const textureLoader = new THREE.CubeTextureLoader();
      textureLoader.load(
        faceUrls,
        (texture: THREE.CubeTexture) => {
          if (disposed) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          material.uniforms.cubeMap.value = texture;
          material.needsUpdate = true;
          revealPaintedSphere();
        },
        undefined,
        revealPaintedSphere,
      );
    } else {
      revealPaintedSphere();
    }

    const inertiaVelocity = {
      axis: new THREE.Vector3(0, 1, 0),
      speed: 0,
    };
    const keysPressed = new Set<string>();
    const releaseVelocity = {
      axis: new THREE.Vector3(0, 1, 0),
      speed: 0,
    };
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const pointer = {
      active: false,
      rotating: false,
      drawing: false,
      multiTouch: false,
      id: 0,
      anchorPoint: undefined as UnitVector | undefined,
      lastX: 0,
      lastY: 0,
      lastAt: 0,
    };
    let activeStroke:
      | {
          id: string;
          path: UnitVector[];
          color: DrawingColor;
          brushSize: BrushSize;
        }
      | undefined;
    const touches = new Map<number, { x: number; y: number }>();
    let lastPinchDistance: number | undefined;
    let lastTwoFingerAngle: number | undefined;
    let pendingMultiTouchRotation = false;
    let pendingStrokeUpdate:
      | { strokeId: string; points: UnitVector[]; timeout: number | undefined }
      | undefined;
    let frameId = 0;
    let viewStorageTimeout: number | undefined;

    const scheduleViewStorageUpdate = () => {
      if (viewStorageTimeout) {
        window.clearTimeout(viewStorageTimeout);
      }

      viewStorageTimeout = window.setTimeout(flushStoredView, viewStorageDelay);
    };

    function flushStoredView() {
      if (viewStorageTimeout) {
        window.clearTimeout(viewStorageTimeout);
        viewStorageTimeout = undefined;
      }

      writeStoredViewState(viewStateRef.current);
    }

    flushStoredViewRef.current = flushStoredView;

    const updateView = (next: ViewState, writeStorage = true) => {
      viewStateRef.current = next;
      setViewState(next);

      if (writeStorage) {
        scheduleViewStorageUpdate();
      }
    };

    const rotateToPointerPoint = (
      anchorPoint: UnitVector,
      pointerPoint: UnitVector,
      elapsedMs: number,
    ) => {
      const anchor = unitVectorToVector3(anchorPoint);
      const target = unitVectorToVector3(pointerPoint);
      const delta = new THREE.Quaternion().setFromUnitVectors(anchor, target);

      if (isIdentityQuaternion(delta)) {
        return;
      }

      const orientation = quaternionStateToThree(
        viewStateRef.current.orientation,
      )
        .multiply(delta)
        .normalize();
      updateView({
        ...viewStateRef.current,
        orientation: quaternionToState(orientation),
      });

      if (elapsedMs > 0) {
        const axisAngle = quaternionToAxisAngle(delta);
        releaseVelocity.axis.copy(axisAngle.axis);
        releaseVelocity.speed = axisAngle.angle / elapsedMs;
      }
    };

    const rollByTouchAngle = (angleDelta: number, elapsedMs: number) => {
      if (Math.abs(angleDelta) < 0.000001) {
        return;
      }

      const rollDelta = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        -angleDelta,
      );
      const orientation = rollDelta
        .clone()
        .multiply(quaternionStateToThree(viewStateRef.current.orientation))
        .normalize();
      updateView({
        ...viewStateRef.current,
        orientation: quaternionToState(orientation),
      });

      if (elapsedMs > 0) {
        const axisAngle = quaternionToAxisAngle(rollDelta);
        const invOrientation = quaternionStateToThree(
          viewStateRef.current.orientation,
        ).invert();
        releaseVelocity.axis.copy(axisAngle.axis).applyQuaternion(invOrientation);
        releaseVelocity.speed = axisAngle.angle / elapsedMs;
      }
    };

    const setZoom = (zoom: number) => {
      updateView({ ...viewStateRef.current, zoom: clampZoom(zoom) });
    };

    const flushPendingStrokeUpdate = () => {
      if (!pendingStrokeUpdate) {
        return;
      }

      if (pendingStrokeUpdate.timeout !== undefined) {
        window.clearTimeout(pendingStrokeUpdate.timeout);
        pendingStrokeUpdate.timeout = undefined;
      }

      if (pendingStrokeUpdate.points.length > 0) {
        sendClientMessage({
          type: "stroke_updated",
          strokeId: pendingStrokeUpdate.strokeId,
          appendedPoints: [...pendingStrokeUpdate.points],
        });
      }

      pendingStrokeUpdate = undefined;
    };

    const discardPendingStrokeUpdate = (strokeId: string) => {
      if (!pendingStrokeUpdate || pendingStrokeUpdate.strokeId !== strokeId) {
        return;
      }

      if (pendingStrokeUpdate.timeout !== undefined) {
        window.clearTimeout(pendingStrokeUpdate.timeout);
      }
      pendingStrokeUpdate = undefined;
    };

    const queueStrokeUpdate = (strokeId: string, point: UnitVector) => {
      if (pendingStrokeUpdate && pendingStrokeUpdate.strokeId !== strokeId) {
        flushPendingStrokeUpdate();
      }

      if (!pendingStrokeUpdate) {
        pendingStrokeUpdate = {
          strokeId,
          points: [],
          timeout: undefined,
        };
      }

      pendingStrokeUpdate.points.push(point);
      if (pendingStrokeUpdate.timeout === undefined) {
        pendingStrokeUpdate.timeout = window.setTimeout(
          flushPendingStrokeUpdate,
          strokeUpdateBatchDelay,
        );
      }
    };

    const commitActiveStrokeSegment = (finishStroke: boolean) => {
      if (!activeStroke) {
        return false;
      }

      flushPendingStrokeUpdate();

      if (
        activeStroke.path.length < 2 ||
        connectionStateRef.current !== "connected"
      ) {
        discardPendingStrokeUpdate(activeStroke.id);
        sendClientMessage({
          type: "stroke_cancelled",
          strokeId: activeStroke.id,
        });
        transientStrokes.delete(`local:${activeStroke.id}`);
        repaintOverlay(transientOverlay, transientStrokes.values());
        return false;
      }

      const committedStroke = activeStroke;
      const committedPath = [...committedStroke.path];
      const lastPoint = committedPath[committedPath.length - 1];

      sendClientMessage({
        type: "drawing_commit_requested",
        strokeId: committedStroke.id,
        path: committedPath,
        color: committedStroke.color,
        brushSize: committedStroke.brushSize,
      });
      pendingLocalStrokes.set(committedStroke.id, {
        path: committedPath,
        color: committedStroke.color,
        brushSize: committedStroke.brushSize,
      });

      if (finishStroke) {
        return true;
      }

      sendClientMessage({
        type: "stroke_cancelled",
        strokeId: committedStroke.id,
      });

      const nextStroke = {
        id: createClientId(),
        path: [lastPoint],
        color: committedStroke.color,
        brushSize: committedStroke.brushSize,
      };
      activeStroke = nextStroke;
      transientStrokes.set(`local:${nextStroke.id}`, nextStroke);
      sendClientMessage({
        type: "stroke_started",
        strokeId: nextStroke.id,
        point: lastPoint,
        color: nextStroke.color,
        brushSize: nextStroke.brushSize,
      });
      repaintOverlay(transientOverlay, transientStrokes.values());

      return true;
    };

    const clearPendingLocalStrokes = () => {
      const activeStrokeId = activeStroke?.id;
      if (pendingLocalStrokes.size === 0 && !activeStrokeId) {
        return;
      }

      for (const strokeId of pendingLocalStrokes.keys()) {
        transientStrokes.delete(`local:${strokeId}`);
        discardPendingStrokeUpdate(strokeId);
      }
      pendingLocalStrokes.clear();
      if (activeStrokeId) {
        transientStrokes.delete(`local:${activeStrokeId}`);
        discardPendingStrokeUpdate(activeStrokeId);
        activeStroke = undefined;
      }
      repaintOverlay(transientOverlay, transientStrokes.values());
    };

    const syncViewTransforms = () => {
      updateOrthographicCamera(
        camera,
        host.clientWidth,
        host.clientHeight,
        viewStateRef.current.zoom,
      );
      sphere.quaternion.copy(
        quaternionStateToThree(viewStateRef.current.orientation),
      );
      wireframeSphere.quaternion.copy(sphere.quaternion);
      camera.updateMatrixWorld(true);
      sphere.updateMatrixWorld(true);
      wireframeSphere.updateMatrixWorld(true);
    };

    const extendActiveStrokeAtClientPoint = (clientX: number, clientY: number) => {
      if (!pointer.active || !pointer.drawing || !activeStroke) {
        return;
      }

      syncViewTransforms();
      const point = spherePointFromClientPoint(
        { x: clientX, y: clientY },
        renderer,
        camera,
        sphere,
        raycaster,
        pointerNdc,
      );
      if (
        point &&
        shouldStorePathPoint(
          activeStroke.path.at(-1),
          point,
          activeStroke.brushSize,
        )
      ) {
        activeStroke.path.push(point);
        transientStrokes.set(`local:${activeStroke.id}`, activeStroke);
        repaintOverlay(transientOverlay, transientStrokes.values());
        queueStrokeUpdate(activeStroke.id, point);
        if (activeStroke.path.length >= partialStrokeCommitPointCount) {
          commitActiveStrokeSegment(false);
        }
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (screensaverModeRef.current) {
        exitScreensaverMode();
        return;
      }

      if (!sphereContentReadyRef.current) {
        return;
      }

      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      renderer.domElement.setPointerCapture(event.pointerId);

      if (drawingLockedRef.current && touches.size >= 2) {
        stopInertia(inertiaVelocity, releaseVelocity);
        return;
      }

      const shouldRotate =
        !drawingLockedRef.current &&
        (!isDrawingZoom(viewStateRef.current.zoom) || touches.size >= 2);

      if (!shouldRotate) {
        stopInertia(inertiaVelocity, releaseVelocity);
        const point = spherePointFromPointer(
          event,
          renderer,
          camera,
          sphere,
          raycaster,
          pointerNdc,
        );
        if (point) {
          const { color, brushSize } = toolRef.current;
          const strokeId = createClientId();
          activeStroke = { id: strokeId, path: [point], color, brushSize };
          pointer.active = true;
          pointer.drawing = true;
          pointer.id = event.pointerId;
          pointer.lastX = event.clientX;
          pointer.lastY = event.clientY;
          pointer.lastAt = performance.now();
          transientStrokes.set(`local:${strokeId}`, activeStroke);
          repaintOverlay(transientOverlay, transientStrokes.values());
          sendClientMessage({
            type: "stroke_started",
            strokeId,
            point,
            color,
            brushSize,
          });
        }
        return;
      }

      pointer.active = true;
      pointer.rotating = true;
      pointer.drawing = false;
      pointer.multiTouch = touches.size >= 2;
      pointer.id = event.pointerId;
      pointer.anchorPoint =
        touches.size >= 2
          ? spherePointFromClientPoint(
              midpoint(touches),
              renderer,
              camera,
              sphere,
              raycaster,
              pointerNdc,
            )
          : spherePointFromPointer(
              event,
              renderer,
              camera,
              sphere,
              raycaster,
              pointerNdc,
            );
      if (activeStroke) {
        transientStrokes.delete(`local:${activeStroke.id}`);
        repaintOverlay(transientOverlay, transientStrokes.values());
        discardPendingStrokeUpdate(activeStroke.id);
        sendClientMessage({
          type: "stroke_cancelled",
          strokeId: activeStroke.id,
        });
        activeStroke = undefined;
      }
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      pointer.lastAt = performance.now();
      lastPinchDistance =
        touches.size >= 2 ? pinchDistance(touches) : undefined;
      lastTwoFingerAngle =
        touches.size >= 2 ? twoFingerAngle(touches) : undefined;
      stopInertia(inertiaVelocity, releaseVelocity);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (touches.has(event.pointerId)) {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      if (!drawingLockedRef.current && touches.size >= 2) {
        const distance = pinchDistance(touches);
        if (lastPinchDistance !== undefined) {
          setZoom(
            viewStateRef.current.zoom + (distance - lastPinchDistance) / 360,
          );
        }
        lastPinchDistance = distance;
      }

      if (
        !pointer.active ||
        !pointer.rotating ||
        (pointer.id !== event.pointerId && touches.size < 2)
      ) {
        if (
          pointer.active &&
          pointer.drawing &&
          pointer.id === event.pointerId &&
          activeStroke
        ) {
          extendActiveStrokeAtClientPoint(event.clientX, event.clientY);
          pointer.lastX = event.clientX;
          pointer.lastY = event.clientY;
          pointer.lastAt = performance.now();
        }
        return;
      }

      if (touches.size >= 2) {
        // Mobile browsers deliver separate pointer events per finger; batch midpoint rotation
        // to one update per animation frame so the View does not bounce between touch samples.
        pendingMultiTouchRotation = true;
        return;
      }

      const now = performance.now();
      const rotationPoint = spherePointFromPointer(
        event,
        renderer,
        camera,
        sphere,
        raycaster,
        pointerNdc,
      );

      if (pointer.anchorPoint && rotationPoint) {
        rotateToPointerPoint(
          pointer.anchorPoint,
          rotationPoint,
          now - pointer.lastAt,
        );
      }
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      pointer.lastAt = now;
    };

    const onPointerUp = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      lastPinchDistance =
        touches.size >= 2 ? pinchDistance(touches) : undefined;
      lastTwoFingerAngle =
        touches.size >= 2 ? twoFingerAngle(touches) : undefined;

      if (
        pointer.id === event.pointerId ||
        (pointer.rotating && pointer.multiTouch && touches.size < 2)
      ) {
        const wasRotating = pointer.rotating;
        if (pointer.drawing && activeStroke) {
          const keepPendingStroke = commitActiveStrokeSegment(true);

          if (!keepPendingStroke) {
            transientStrokes.delete(`local:${activeStroke.id}`);
            repaintOverlay(transientOverlay, transientStrokes.values());
          }
        }
        activeStroke = undefined;
        pointer.active = false;
        pointer.rotating = false;
        pointer.drawing = false;
        pointer.multiTouch = false;
        pointer.anchorPoint = undefined;
        pendingMultiTouchRotation = false;
        lastTwoFingerAngle = undefined;

        if (wasRotating && releaseVelocity.speed >= startInertiaVelocity) {
          inertiaVelocity.axis.copy(releaseVelocity.axis);
          inertiaVelocity.speed = releaseVelocity.speed;
        } else {
          stopInertia(inertiaVelocity, releaseVelocity);
        }
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();

      if (drawingLockedRef.current) {
        stopInertia(inertiaVelocity, releaseVelocity);
        return;
      }

      if (screensaverModeRef.current || event.ctrlKey || event.metaKey) {
        setZoom(viewStateRef.current.zoom - event.deltaY * 0.0012);
        extendActiveStrokeAtClientPoint(pointer.lastX, pointer.lastY);
        return;
      }

      const verticalDelta = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        -event.deltaY * wheelRotateSpeed,
      );
      const horizontalDelta = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        -event.deltaX * wheelRotateSpeed,
      );
      const rotationDelta = horizontalDelta.multiply(verticalDelta).normalize();
      const orientation = rotationDelta
        .clone()
        .multiply(quaternionStateToThree(viewStateRef.current.orientation))
        .normalize();
      updateView({ ...viewStateRef.current, orientation: quaternionToState(orientation) });
      extendActiveStrokeAtClientPoint(pointer.lastX, pointer.lastY);

      const isTrackpad =
        event.deltaMode === 0 &&
        Math.abs(event.deltaY) < trackpadPixelThreshold &&
        Math.abs(event.deltaX) < trackpadPixelThreshold;

      if (!isTrackpad) {
        const axisAngle = quaternionToAxisAngle(rotationDelta);
        if (axisAngle.angle > 0) {
          const invOrientation = quaternionStateToThree(viewStateRef.current.orientation).invert();
          inertiaVelocity.axis.copy(axisAngle.axis).applyQuaternion(invOrientation);
          inertiaVelocity.speed =
            inertiaVelocity.speed * 0.5 + (axisAngle.angle / 16) * 0.5;
        }
      }
    };

    const onResize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      updateOrthographicCamera(
        camera,
        width,
        height,
        viewStateRef.current.zoom,
      );
      renderer.setSize(width, height);
    };

    const startedAt = performance.now();
    let previousFrameAt = startedAt;

    const animate = () => {
      const now = performance.now();
      const frameMs = now - previousFrameAt;
      previousFrameAt = now;
      const current = viewStateRef.current;
      if (
        pendingMultiTouchRotation &&
        pointer.active &&
        pointer.rotating &&
        touches.size >= 2
      ) {
        const now = performance.now();
        const rotationPoint = spherePointFromClientPoint(
          midpoint(touches),
          renderer,
          camera,
          sphere,
          raycaster,
          pointerNdc,
        );

        if (pointer.anchorPoint && rotationPoint) {
          rotateToPointerPoint(
            pointer.anchorPoint,
            rotationPoint,
            now - pointer.lastAt,
          );
        }

        const currentTwoFingerAngle = twoFingerAngle(touches);
        if (lastTwoFingerAngle !== undefined) {
          rollByTouchAngle(
            normalizeAngleDelta(currentTwoFingerAngle - lastTwoFingerAngle),
            now - pointer.lastAt,
          );
        }
        lastTwoFingerAngle = currentTwoFingerAngle;
        pointer.lastAt = now;
        pendingMultiTouchRotation = false;
      }

      for (const event of eventQueueRef.current.splice(0)) {
        if (event.type === "drawing_committed") {
          const pendingEntry = event.strokeId
            ? findPendingStrokeById(pendingLocalStrokes, event.strokeId)
            : findPendingStroke(
                pendingLocalStrokes,
                event.drawing.path,
              );
          if (pendingEntry) {
            transientStrokes.delete(`local:${pendingEntry.strokeId}`);
          }
          findTransientStroke(transientStrokes, event.drawing.path);

          const { drawings, changed, needsRepaint } = mergeDrawingForPaint(
            drawingsRef.current,
            event.drawing,
          );
          if (changed) {
            drawingsRef.current = drawings;
            if (needsRepaint) {
              repaintOverlay(overlay, drawingsRef.current);
            } else {
              paintDrawingOnOverlay(overlay, event.drawing);
              overlay.texture.needsUpdate = true;
            }
          }
          repaintOverlay(transientOverlay, transientStrokes.values());
        }

        if (event.type === "stroke_started") {
          const key = `${event.connectionId}:${event.strokeId}`;
          transientStrokes.set(key, {
            path: [event.point],
            color: event.color,
            brushSize: event.brushSize,
          });
          repaintOverlay(transientOverlay, transientStrokes.values());
        }

        if (event.type === "stroke_updated") {
          const key = `${event.connectionId}:${event.strokeId}`;
          const existing = transientStrokes.get(key);
          if (existing) {
            existing.path.push(...event.appendedPoints);
            repaintOverlay(transientOverlay, transientStrokes.values());
          }
        }

        if (event.type === "stroke_cancelled") {
          let changed = false;
          for (const [key] of transientStrokes) {
            if (
              event.strokeId === "*"
                ? key.startsWith(`${event.connectionId}:`)
                : key === `${event.connectionId}:${event.strokeId}`
            ) {
              transientStrokes.delete(key);
              changed = true;
            }
          }
          if (changed) {
            repaintOverlay(transientOverlay, transientStrokes.values());
          }
        }

        if (event.type === "snapshot_promoted") {
          const bakedIds = new Set(event.bakedDrawingIds ?? []);
          const faceUrls = cubeFaceNames.map((face) => event.faces[face]?.url ?? "");
          if (faceUrls.every(Boolean)) {
            const textureLoader = new THREE.CubeTextureLoader();
            textureLoader.load(faceUrls, (texture: THREE.CubeTexture) => {
              texture.colorSpace = THREE.SRGBColorSpace;
              material.uniforms.cubeMap.value = texture;
              material.needsUpdate = true;
              drawingsRef.current = orderDrawingsForPaint(
                drawingsRef.current.filter((d) => !bakedIds.has(d.id)),
              );
              repaintOverlay(overlay, drawingsRef.current);
            });
          }
        }
      }

      if (screensaverModeRef.current) {
        const step = autoRotateStep(frameMs);
        const orientation = step
          .multiply(quaternionStateToThree(current.orientation))
          .normalize();
        updateView(
          {
            ...current,
            orientation: quaternionToState(orientation),
          },
          false,
        );
      } else if (!pointer.active && inertiaVelocity.speed > minInertiaVelocity) {
        const delta = new THREE.Quaternion().setFromAxisAngle(
          inertiaVelocity.axis,
          inertiaVelocity.speed * frameMs,
        );
        const orientation = quaternionStateToThree(current.orientation)
          .multiply(delta)
          .normalize();
        updateView({ ...current, orientation: quaternionToState(orientation) }, true);
        inertiaVelocity.speed *= inertiaDamping;
      }

      if (!screensaverModeRef.current && keysPressed.size > 0) {
        const dx =
          (keysPressed.has("ArrowRight") ? 1 : 0) +
          (keysPressed.has("ArrowLeft") ? -1 : 0);
        const dy =
          (keysPressed.has("ArrowDown") ? 1 : 0) +
          (keysPressed.has("ArrowUp") ? -1 : 0);
        if (dx !== 0 || dy !== 0) {
          const viewSize =
            farZoomOrthographicSize -
            clampZoom(viewStateRef.current.zoom) *
              (farZoomOrthographicSize - closeZoomOrthographicSize);
          const zoomScale = viewSize / farZoomOrthographicSize;
          const angle = keyboardRotateSpeed * frameMs * zoomScale;
          const verticalDelta = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(1, 0, 0),
            -dy * angle,
          );
          const horizontalDelta = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            -dx * angle,
          );
          const keyDelta = horizontalDelta.multiply(verticalDelta).normalize();
          const orientation = keyDelta
            .clone()
            .multiply(quaternionStateToThree(viewStateRef.current.orientation))
            .normalize();
          updateView({ ...viewStateRef.current, orientation: quaternionToState(orientation) });
          extendActiveStrokeAtClientPoint(pointer.lastX, pointer.lastY);
          const axisAngle = quaternionToAxisAngle(keyDelta);
          if (axisAngle.angle > 0) {
            const invOrientation = quaternionStateToThree(viewStateRef.current.orientation).invert();
            releaseVelocity.axis.copy(axisAngle.axis).applyQuaternion(invOrientation);
            releaseVelocity.speed = axisAngle.angle / frameMs;
          }
        }
      }

      syncViewTransforms();
      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };

    const rotationKeys = new Set([
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    ]);
    const onRotationKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) return;
      if (!rotationKeys.has(event.key)) return;
      if (event.key.startsWith("Arrow")) event.preventDefault();
      if (keysPressed.size === 0) stopInertia(inertiaVelocity, releaseVelocity);
      keysPressed.add(event.key);
    };
    const onRotationKeyUp = (event: KeyboardEvent) => {
      if (!rotationKeys.has(event.key)) return;
      keysPressed.delete(event.key);
      if (keysPressed.size === 0 && releaseVelocity.speed >= startInertiaVelocity) {
        inertiaVelocity.axis.copy(releaseVelocity.axis);
        inertiaVelocity.speed = releaseVelocity.speed;
      }
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onRotationKeyDown);
    window.addEventListener("keyup", onRotationKeyUp);
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.addEventListener(localPendingStrokesRejectedEvent, clearPendingLocalStrokes);
    onResize();
    previousFrameAt = performance.now();
    animate();

    return () => {
      flushStoredView();
      disposed = true;
      flushPendingStrokeUpdate();
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("keydown", onRotationKeyDown);
      window.removeEventListener("keyup", onRotationKeyUp);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.removeEventListener(localPendingStrokesRejectedEvent, clearPendingLocalStrokes);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      host.removeChild(renderer.domElement);
      geometry.dispose();
      wireframeGeometry.dispose();
      material.dispose();
      wireframeMaterial.dispose();
      pendingLocalStrokes.clear();
      transientOverlay.texture.dispose();
      overlay.texture.dispose();
      fallbackTexture.dispose();
      renderer.dispose();
    };
  }, [
    bootstrap.status === "ready" ? bootstrap.snapshotFaces : undefined,
  ]);

  const sendClientMessage = (message: unknown) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  };

  const updateViewFromControls = (
    updater: (current: ViewState) => ViewState,
  ) => {
    setViewState((current) => {
      const next = updater(current);
      viewStateRef.current = next;
      window.setTimeout(() => flushStoredViewRef.current(), 0);
      return next;
    });
  };

  const enterScreensaverMode = () => {
    const params = new URLSearchParams(window.location.search);
    params.set("screensaver", "1");
    const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
    setScreensaverMode(true);
  };

  const exitScreensaverMode = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("screensaver");
    params.delete("mode");
    const search = params.toString();
    const nextUrl = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
    setScreensaverMode(false);
  };

  useEffect(() => {
    if (!screensaverMode) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        exitScreensaverMode();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [screensaverMode]);

  useEffect(() => {
    if (screensaverMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) return;

      if (event.key === " ") {
        event.preventDefault();
        updateViewFromControls((current) => ({
          ...current,
          zoom:
            current.zoom >= viewSettings.drawingZoomThreshold
              ? viewSettings.minZoom
              : viewSettings.comfortableDrawingZoom,
        }));
        return;
      }

      if (event.key === "+" || event.key === "=" || event.key === "-") {
        event.preventDefault();
        const direction = event.key === "-" ? -1 : 1;
        updateViewFromControls((current) => ({
          ...current,
          zoom: clampZoom(current.zoom + direction * keyboardZoomStep),
        }));
        return;
      }

      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        const paletteIndex = event.key === "0" ? 9 : Number(event.key) - 1;
        const color = drawingPalette[paletteIndex];
        if (color) {
          setSelectedColor(color);
        }
        return;
      }

      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        setSelectedBrushSize((brushSize) =>
          brushSize === "fine" ? "bold" : "fine",
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [screensaverMode]);

  return (
    <main className="relative h-dvh min-h-dvh w-screen overflow-hidden">
      <section
        className="fixed inset-0 grid h-dvh min-h-dvh min-w-0 place-items-center bg-neutral-900"
        aria-label="Shared drawing sphere"
      >
        <div
          ref={canvasHostRef}
          className={`absolute inset-0 h-full w-full touch-none [&_canvas]:block [&_canvas]:h-full [&_canvas]:w-full [&_canvas]:drop-shadow-[0_28px_70px_rgb(255_255_255_/_0.16)] ${
            screensaverMode
              ? "cursor-default"
              : drawingMode
                ? "cursor-crosshair"
                : "cursor-grab active:cursor-grabbing"
          }`}
        />
      </section>

      {statusOverlay ? (
        <div
          className="pointer-events-none fixed inset-0 z-8 grid place-items-center px-6"
          aria-live="polite"
        >
          <div
            className={`max-w-sm bg-neutral-400 px-6 py-4 text-center shadow-2xl ${
              statusOverlay.tone === "loading" ? "animate-pulse" : ""
            } ${
              statusOverlay.tone === "error" ? "text-red-800" : "text-neutral-950"
            }`}
            role={statusOverlay.tone === "error" ? "alert" : "status"}
          >
            {statusOverlay.message}
          </div>
        </div>
      ) : null}

      {!screensaverMode ? (
        <header
          className="pointer-events-none fixed inset-x-0 top-0 z-5 flex"
          aria-label="World status"
        >
          {!drawingLocked ? (
            <>
              <button
                type="button"
                className={`${buttonClass} w-12 h-12 grid place-items-center cursor-pointer`}
                aria-label={drawingMode ? "Zoom out" : "Zoom in to draw"}
                onClick={() =>
                  updateViewFromControls((current) => ({
                    ...current,
                    zoom: drawingMode
                      ? viewSettings.minZoom
                      : viewSettings.comfortableDrawingZoom,
                  }))
                }
              >
                {drawingMode ? (
                  <MinusIcon className={iconClass} aria-hidden="true" />
                ) : (
                  <PlusIcon className={iconClass} aria-hidden="true" />
                )}
              </button>
              <label
                className={`${panelClass} grid rounded-full overflow-hidden`}
              >
                <span className="relative block h-12 w-32 overflow-hidden">
                  <span
                    className="pointer-events-none absolute top-1/2 z-10 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black"
                    style={{ left: `calc(${zoomProgress}% + ${zoomMarkerOffsetPx}px)` }}
                    aria-hidden="true"
                  />
                  <span
                    className="pointer-events-none absolute inset-y-0 right-0 bg-neutral-500/50"
                    style={{ left: `${drawingZoomThresholdProgress}%` }}
                    aria-hidden="true"
                  />
                  <input
                    className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
                    type="range"
                    min={viewSettings.minZoom}
                    max={viewSettings.maxZoom}
                    step="0.01"
                    value={viewState.zoom}
                    onChange={(event) =>
                      updateViewFromControls((current) => ({
                        ...current,
                        zoom: clampZoom(Number(event.target.value)),
                      }))
                    }
                    aria-label="Zoom"
                  />
                </span>
              </label>
            </>
          ) : null}

          <div className={`grow`}></div>

          {drawingMode ? (
            <button
              type="button"
              className={`${buttonClass} w-12 h-12 grid place-items-center`}
              aria-label={
                drawingLocked ? "Unlock drawing view" : "Lock drawing view"
              }
              onClick={() => setDrawingLocked((locked) => !locked)}
            >
              {drawingLocked ? (
                <KeyIcon className={iconClass} aria-hidden="true" />
              ) : (
                <LockIcon className={iconClass} aria-hidden="true" />
              )}
            </button>
          ) : null}

          <div className={`${panelClass} h-12 w-24 relative flex rounded-full`}>
            <div
              className={`absolute left-1 top-0 w-1/2 h-12 grid place-items-center ${
                connectionState === "connected"
                  ? "text-green-800"
                  : connectionState === "offline"
                    ? "text-red-800"
                    : "text-yellow-800"
              }`}
            >
              <CircleIcon className={`${iconClass}`} fill="currentColor" aria-hidden="true" />
            </div>

            <div
              className="w-full absolute left-0 top-0 h-12 flex items-center justify-end pr-4"
              aria-live="polite"
            >
              {connectionState === "connected"
                ? bootstrap.status === "ready"
                  ? bootstrap.presenceCount
                  : null
                : connectionState === "offline"
                  ? "0"
                  : "…"}
              <span className="sr-only">
                {connectionState === "connected"
                  ? `${bootstrap.status === "ready" ? bootstrap.presenceCount : 0} present`
                  : connectionState === "offline"
                    ? "Offline"
                    : "Connecting"}
              </span>
            </div>
          </div>
          <button
            type="button"
            className={`${buttonClass} w-12 h-12 grid place-items-center cursor-pointer`}
            aria-label="About this project"
            onClick={() => setAboutOpen(true)}
          >
            <span className="text-base leading-none" aria-hidden="true">
              ?
            </span>
          </button>
        </header>
      ) : null}

      {aboutOpen ? (
        <div
          className="fixed inset-0 z-10 grid min-h-screen place-items-center bg-neutral-950 px-6 text-neutral-100"
          role="dialog"
          aria-modal="true"
          aria-labelledby="about-title"
        >
          <button
            type="button"
            className="fixed right-0 top-0 h-12 w-12 cursor-pointer bg-neutral-400 text-neutral-950 grid place-items-center"
            aria-label="Close about dialog"
            onClick={() => setAboutOpen(false)}
          >
            <XIcon className={iconClass} aria-hidden="true" />
          </button>

          <div className="max-w-xl text-left">
            <h1 id="about-title" className="m-0">
              Sphere Paint
            </h1>
            <p className="mt-[0.5lh] text-neutral-400">
Collaboratively paint a sphere. Zoom in to draw and zoom out to get a global view. All marks are public and permanent (until they're drawn over).
           </p>
            <p className="mt-[0.5lh] text-neutral-400">
A <a className="underline text-neutral-200" href="https://constraint.systems/" target="_blank">Constraint Systems</a> project</p>
          </div>
        </div>
      ) : null}

      {!screensaverMode ? (
        <aside
          className="pointer-events-none fixed inset-x-0 bottom-0 z-5 flex justify-between"
          aria-label="Drawing controls"
        >
          {drawingMode ? (
            <>
              <div
                className="grid grid-cols-10 max-[640px]:grid-cols-5"
                aria-label="Drawing palette"
              >
                {drawingPalette.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`w-12 h-12 pointer-events-auto cursor-pointer ${
                      selectedColor === color ? "rounded-full" : ""
                    }`}
                    style={{ backgroundColor: color }}
                    aria-label={color}
                    disabled={connectionState !== "connected"}
                    onClick={() => setSelectedColor(color)}
                  />
                ))}
              </div>

              <div className="flex max-[640px]:flex-col">
                {brushSizes.map((brushSize) => (
                  <button
                    key={brushSize}
                    type="button"
                    className={`cursor-pointer bg-neutral-400 pointer-events-auto w-12 grid place-items-center h-12 ${selectedBrushSize === brushSize ? "rounded-full" : ""}`}
                    disabled={connectionState !== "connected"}
                    aria-label={`${brushSize} brush`}
                    onClick={() => setSelectedBrushSize(brushSize)}
                  >
                    <CircleIcon
                      className={`${brushIconSize[brushSize]} fill-current`}
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="relative w-full flex h-12 justify-between">
              <button
                type="button"
                className={`${buttonClass} relative px-4 h-12 inline-flex items-center gap-2`}
                onClick={() =>
                  updateViewFromControls((current) => ({
                    ...current,
                    zoom: viewSettings.comfortableDrawingZoom,
                  }))
                }
              >
                Zoom in to draw
                <span
                  className="hidden ml-[1ch] pointer-fine:block text-neutral-600"
                  aria-hidden="true"
                >
[space]
                </span>
              </button>

              <button
                type="button"
                className={`${buttonClass} w-12 h-12 grid place-items-center`}
                aria-label="Enter screensaver mode"
                onClick={enterScreensaverMode}
              >
                <PlayIcon fill="currentColor" className={iconClass} aria-hidden="true" />
              </button>
            </div>
          )}

        </aside>
      ) : null}
    </main>
  );
}

function readScreensaverModeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("screensaver") === "1" || params.get("mode") === "screensaver"
  );
}

function readStoredViewState(): ViewState {
  const fallback = {
    zoom: viewSettings.initialZoom,
    orientation: identityQuaternionState(),
  };
  const storedValue = window.localStorage.getItem(viewStorageKey);

  if (!storedValue) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(storedValue) as Partial<ViewState>;
    const orientation = isQuaternionState(parsed.orientation)
      ? normalizeQuaternionState(parsed.orientation)
      : undefined;
    const zoom =
      typeof parsed.zoom === "number" && Number.isFinite(parsed.zoom)
        ? clampZoom(parsed.zoom)
        : fallback.zoom;

    return {
      zoom,
      orientation: orientation ?? fallback.orientation,
    };
  } catch {
    return fallback;
  }
}

function isQuaternionState(value: unknown): value is QuaternionState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Record<keyof QuaternionState, unknown>>;
  return (
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.z === "number" &&
    typeof candidate.w === "number"
  );
}

function writeStoredViewState(viewState: ViewState) {
  const orientation =
    normalizeQuaternionState(viewState.orientation) ??
    identityQuaternionState();

  window.localStorage.setItem(
    viewStorageKey,
    JSON.stringify({
      zoom: clampZoom(viewState.zoom),
      orientation,
    }),
  );
}

function readStoredColor(): DrawingColor {
  const color = window.localStorage.getItem(colorStorageKey);
  return drawingPalette.includes(color as DrawingColor)
    ? (color as DrawingColor)
    : "#111111";
}

function readStoredBrushSize(): BrushSize {
  const brushSize = window.localStorage.getItem(brushStorageKey);
  return brushSizes.includes(brushSize as BrushSize)
    ? (brushSize as BrushSize)
    : "fine";
}

function stopInertia(
  inertiaVelocity: { axis: THREE.Vector3; speed: number },
  releaseVelocity: { axis: THREE.Vector3; speed: number },
) {
  inertiaVelocity.axis.set(0, 1, 0);
  inertiaVelocity.speed = 0;
  releaseVelocity.axis.set(0, 1, 0);
  releaseVelocity.speed = 0;
}

function identityQuaternionState(): QuaternionState {
  return { x: 0, y: 0, z: 0, w: 1 };
}

function normalizeQuaternionState(
  orientation: QuaternionState,
): QuaternionState | undefined {
  const length = Math.hypot(
    orientation.x,
    orientation.y,
    orientation.z,
    orientation.w,
  );

  if (!Number.isFinite(length) || length < 0.000001) {
    return undefined;
  }

  return {
    x: orientation.x / length,
    y: orientation.y / length,
    z: orientation.z / length,
    w: orientation.w / length,
  };
}

function quaternionStateToThree(orientation: QuaternionState) {
  const normalized =
    normalizeQuaternionState(orientation) ?? identityQuaternionState();
  return new THREE.Quaternion(
    normalized.x,
    normalized.y,
    normalized.z,
    normalized.w,
  );
}

function quaternionToState(quaternion: THREE.Quaternion): QuaternionState {
  return (
    normalizeQuaternionState({
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w,
    }) ?? identityQuaternionState()
  );
}

function autoRotateStep(frameMs: number) {
  const frameSeconds = frameMs / 1000;
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      autoRotateSecondarySpeed * frameSeconds,
      autoRotateSpeed * frameSeconds,
      0,
      "YXZ",
    ),
  );
}

function unitVectorToVector3(point: UnitVector) {
  return new THREE.Vector3(point.x, point.y, point.z).normalize();
}

function isIdentityQuaternion(quaternion: THREE.Quaternion) {
  return (
    Math.abs(quaternion.x) < 0.000001 &&
    Math.abs(quaternion.y) < 0.000001 &&
    Math.abs(quaternion.z) < 0.000001 &&
    Math.abs(quaternion.w - 1) < 0.000001
  );
}

function quaternionToAxisAngle(quaternion: THREE.Quaternion) {
  const normalized = quaternion.clone().normalize();
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, normalized.w)));
  const scale = Math.sqrt(Math.max(0, 1 - normalized.w * normalized.w));

  if (scale < 0.000001 || angle < 0.000001) {
    return { axis: new THREE.Vector3(0, 1, 0), angle: 0 };
  }

  return {
    axis: new THREE.Vector3(
      normalized.x / scale,
      normalized.y / scale,
      normalized.z / scale,
    ).normalize(),
    angle,
  };
}

function midpoint(touches: Map<number, { x: number; y: number }>) {
  const [a, b] = Array.from(touches.values());

  if (!a || !b) {
    return a ?? { x: 0, y: 0 };
  }

  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function pinchDistance(touches: Map<number, { x: number; y: number }>) {
  const [a, b] = Array.from(touches.values());
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

function twoFingerAngle(touches: Map<number, { x: number; y: number }>) {
  const [a, b] = Array.from(touches.values());
  return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
}

function normalizeAngleDelta(delta: number) {
  let normalized = delta;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function createFallbackCubeTexture() {
  const canvases = cubeFaceNames.map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("2d");
    context!.fillStyle = "#ffffff";
    context!.fillRect(0, 0, 16, 16);
    return canvas;
  });
  const texture = new THREE.CubeTexture(canvases);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type OverlayCubeTexture = {
  texture: THREE.CubeTexture;
  contexts: Record<string, CanvasRenderingContext2D>;
};

function createOverlayCubeTexture(): OverlayCubeTexture {
  const contexts: Record<string, CanvasRenderingContext2D> = {};
  const canvases = cubeFaceNames.map((faceName) => {
    const canvas = document.createElement("canvas");
    canvas.width = overlayFaceSize;
    canvas.height = overlayFaceSize;
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Could not create overlay canvas context");
    }

    context.clearRect(0, 0, overlayFaceSize, overlayFaceSize);
    contexts[faceName] = context;
    return canvas;
  });
  const texture = new THREE.CubeTexture(canvases);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, contexts };
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

function paintDrawingOnOverlay(
  overlay: OverlayCubeTexture,
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
    x: uv.u * overlayFaceSize,
    y: uv.v * overlayFaceSize,
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
      currentSubPath.push(toPixel(cubeProjectionToTextureUv(projectUnitVectorToCubeFace(onA))));
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
    const context = overlay.contexts[faceName];
    if (!context) continue;

    context.save();
    context.strokeStyle = drawing.color;
    context.fillStyle = drawing.color;
    context.lineWidth = brushPixelWidth(drawing.brushSize);
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const subPath of subPaths) {
      if (subPath.length === 0) continue;
      if (subPath.length === 1) {
        context.beginPath();
        context.arc(subPath[0].x, subPath[0].y, context.lineWidth / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.beginPath();
        context.moveTo(subPath[0].x, subPath[0].y);
        for (let j = 1; j < subPath.length; j++) {
          context.lineTo(subPath[j].x, subPath[j].y);
        }
        context.stroke();
      }
    }

    context.restore();
  }
}

function repaintOverlay(
  overlay: OverlayCubeTexture,
  drawings: Iterable<Pick<Drawing, "path" | "color" | "brushSize">>,
) {
  for (const context of Object.values(overlay.contexts)) {
    context.clearRect(0, 0, overlayFaceSize, overlayFaceSize);
  }

  for (const drawing of drawings) {
    paintDrawingOnOverlay(overlay, drawing);
  }

  overlay.texture.needsUpdate = true;
}

function orderDrawingsForPaint(drawings: Drawing[]) {
  return [...drawings].sort((a, b) => {
    const revisionDelta = a.createdRevision - b.createdRevision;
    if (revisionDelta !== 0) return revisionDelta;
    return a.id.localeCompare(b.id);
  });
}

function mergeDrawingForPaint(existingDrawings: Drawing[], drawing: Drawing) {
  if (existingDrawings.some((existing) => existing.id === drawing.id)) {
    return {
      drawings: existingDrawings,
      changed: false,
      needsRepaint: false,
    };
  }

  const drawings = orderDrawingsForPaint([...existingDrawings, drawing]);
  return {
    drawings,
    changed: true,
    needsRepaint: drawings.at(-1)?.id !== drawing.id,
  };
}

function brushPixelWidth(brushSize: BrushSize) {
  return Math.max(2, brushAngularWidths[brushSize] * overlayFaceSize * 2.5);
}

function updateOrthographicCamera(
  camera: THREE.OrthographicCamera,
  width: number,
  height: number,
  zoom: number,
) {
  const aspect = width / Math.max(height, 1);
  const viewSize =
    farZoomOrthographicSize -
    clampZoom(zoom) * (farZoomOrthographicSize - closeZoomOrthographicSize);

  camera.left = (-viewSize * aspect) / 2;
  camera.right = (viewSize * aspect) / 2;
  camera.top = viewSize / 2;
  camera.bottom = -viewSize / 2;
  camera.updateProjectionMatrix();
}

function spherePointFromPointer(
  event: PointerEvent,
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  sphere: THREE.Mesh,
  raycaster: THREE.Raycaster,
  pointerNdc: THREE.Vector2,
): UnitVector | undefined {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(
    ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
    -(((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1),
  );
  raycaster.setFromCamera(pointerNdc, camera);
  const hit = raycaster.intersectObject(sphere, false)[0];

  if (hit) {
    const localPoint = sphere.worldToLocal(hit.point.clone()).normalize();
    return { x: localPoint.x, y: localPoint.y, z: localPoint.z };
  }

  const ox = raycaster.ray.origin.x;
  const oy = raycaster.ray.origin.y;
  const r = Math.hypot(ox, oy);
  if (r < 0.0001) return undefined;
  const silhouette = sphere.worldToLocal(new THREE.Vector3(ox / r, oy / r, 0)).normalize();
  return { x: silhouette.x, y: silhouette.y, z: silhouette.z };
}

function spherePointFromClientPoint(
  point: { x: number; y: number },
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  sphere: THREE.Mesh,
  raycaster: THREE.Raycaster,
  pointerNdc: THREE.Vector2,
): UnitVector | undefined {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(
    ((point.x - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
    -(((point.y - rect.top) / Math.max(rect.height, 1)) * 2 - 1),
  );
  raycaster.setFromCamera(pointerNdc, camera);
  const hit = raycaster.intersectObject(sphere, false)[0];

  if (!hit) {
    return undefined;
  }

  const localPoint = sphere.worldToLocal(hit.point.clone()).normalize();

  return { x: localPoint.x, y: localPoint.y, z: localPoint.z };
}

function findPendingStroke(
  pendingStrokes: Map<string, Pick<Drawing, "path" | "color" | "brushSize">>,
  committedPath: UnitVector[],
) {
  for (const [strokeId, pendingStroke] of pendingStrokes) {
    if (pathsMatch(pendingStroke.path, committedPath)) {
      pendingStrokes.delete(strokeId);
      return { strokeId, pendingStroke };
    }
  }

  return undefined;
}

function findPendingStrokeById(
  pendingStrokes: Map<string, Pick<Drawing, "path" | "color" | "brushSize">>,
  strokeId: string,
) {
  const pendingStroke = pendingStrokes.get(strokeId);
  if (!pendingStroke) {
    return undefined;
  }

  pendingStrokes.delete(strokeId);
  return { strokeId, pendingStroke };
}

function findTransientStroke(
  transientStrokes: Map<string, Pick<Drawing, "path" | "color" | "brushSize">>,
  committedPath: UnitVector[],
) {
  for (const [strokeId, transientStroke] of transientStrokes) {
    if (pathsMatch(transientStroke.path, committedPath)) {
      transientStrokes.delete(strokeId);
      return { strokeId, transientStroke };
    }
  }

  return undefined;
}

function createClientId() {
  if (globalThis.crypto && "randomUUID" in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }

  const randomPart = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${randomPart}`;
}

function pathsMatch(a: UnitVector[], b: UnitVector[]) {
  if (a.length !== b.length) {
    return false;
  }

  return a.every((point, index) => {
    const other = b[index];
    return (
      Boolean(other) &&
      Math.abs(point.x - other.x) < 0.000001 &&
      Math.abs(point.y - other.y) < 0.000001 &&
      Math.abs(point.z - other.z) < 0.000001
    );
  });
}

function parseJson(
  value: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}
