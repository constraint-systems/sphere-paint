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
  MinusIcon,
  PauseIcon,
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
const autoRotateSpeed = 0.18;
const autoRotateSecondarySpeed = 0.045;
const inertiaDamping = 0.92;
const minInertiaVelocity = 0.00035;
const startInertiaVelocity = 0.0022;
const wheelRotateSpeed = 0.0015;
const wheelInertiaDamping = 0.94;
const wheelInertiaBoost = 0.42;
const wheelInertiaAccumulation = 0.55;
const maxWheelInertiaDelta = 120;
const minWheelInertiaDelta = 0.08;
const startWheelInertiaDelta = 1.8;
const urlReplaceDelay = 250;
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
  autoRotateEnabled: boolean;
};

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({
    status: "loading",
  });
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "offline"
  >("connecting");
  const [viewState, setViewState] = useState<ViewState>(() =>
    readViewStateFromUrl(),
  );
  const [selectedColor, setSelectedColor] = useState<DrawingColor>(() =>
    readStoredColor(),
  );
  const [selectedBrushSize, setSelectedBrushSize] = useState<BrushSize>(() =>
    readStoredBrushSize(),
  );
  const [aboutOpen, setAboutOpen] = useState(false);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const viewStateRef = useRef(viewState);
  const flushUrlRef = useRef<() => void>(() => undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const toolRef = useRef({
    color: selectedColor,
    brushSize: selectedBrushSize,
  });
  const connectionStateRef = useRef(connectionState);
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
            | "stroke_cancelled";
        }
      >
    >
  >([]);

  const drawingMode = isDrawingZoom(viewState.zoom);
  const autoRotateActive = viewState.autoRotateEnabled && !drawingMode;
  const zoomProgress =
    ((viewState.zoom - viewSettings.minZoom) /
      (viewSettings.maxZoom - viewSettings.minZoom)) *
    100;
  const drawingZoomThresholdProgress =
    ((viewSettings.drawingZoomThreshold - viewSettings.minZoom) /
      (viewSettings.maxZoom - viewSettings.minZoom)) *
    100;
  const panelClass = "pointer-events-auto bg-neutral-400";
  const buttonClass = "pointer-events-auto cursor-pointer bg-neutral-400";
  const iconClass = "size-4 shrink-0";
  const brushIconSize: Record<BrushSize, string> = {
    fine: "size-3",
    bold: "size-5",
  };

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
          serverEvent.type === "drawing_committed"
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

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.append(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);
    const geometry = new THREE.SphereGeometry(1, 96, 64);
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
          vec3 shadedPaint = mix(spherePaint, vec3(0.62), rim * 0.32);
          gl_FragColor = vec4(shadedPaint, 1.0);
        }
      `,
    });
    const sphere = new THREE.Mesh(geometry, material);
    const transientStrokes = new Map<
      string,
      Pick<Drawing, "path" | "color" | "brushSize">
    >();
    const pendingLocalStrokes = new Map<
      string,
      Pick<Drawing, "path" | "color" | "brushSize">
    >();
    scene.add(sphere);

    for (const drawing of drawingsRef.current) {
      paintDrawingOnOverlay(overlay, drawing);
    }
    overlay.texture.needsUpdate = true;

    const faceUrls = cubeFaceNames.map(
      (faceName) => bootstrap.snapshotFaces[faceName]?.url,
    );
    if (faceUrls.every((url): url is string => Boolean(url))) {
      const textureLoader = new THREE.CubeTextureLoader();
      textureLoader.load(
        faceUrls,
        (texture: THREE.CubeTexture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          material.uniforms.cubeMap.value = texture;
          material.needsUpdate = true;
        },
        undefined,
        () => undefined,
      );
    }

    const inertiaVelocity = {
      axis: new THREE.Vector3(0, 1, 0),
      speed: 0,
    };
    const wheelInertia = {
      deltaX: 0,
      deltaY: 0,
    };
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
    let pendingMultiTouchRotation = false;
    let frameId = 0;
    let urlTimeout: number | undefined;

    const scheduleUrlUpdate = () => {
      if (urlTimeout) {
        window.clearTimeout(urlTimeout);
      }

      urlTimeout = window.setTimeout(flushUrl, urlReplaceDelay);
    };

    function flushUrl() {
      if (urlTimeout) {
        window.clearTimeout(urlTimeout);
        urlTimeout = undefined;
      }

      writeViewStateToUrl(viewStateRef.current);
    }

    flushUrlRef.current = flushUrl;

    const updateView = (next: ViewState, writeUrl = true) => {
      viewStateRef.current = next;
      setViewState(next);

      if (writeUrl) {
        scheduleUrlUpdate();
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
        autoRotateEnabled: false,
      });

      if (elapsedMs > 0) {
        const axisAngle = quaternionToAxisAngle(delta);
        releaseVelocity.axis.copy(axisAngle.axis);
        releaseVelocity.speed = axisAngle.angle / elapsedMs;
      }
    };

    const setZoom = (zoom: number) => {
      updateView({ ...viewStateRef.current, zoom: clampZoom(zoom) });
    };

    const onPointerDown = (event: PointerEvent) => {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      renderer.domElement.setPointerCapture(event.pointerId);

      const shouldRotate =
        !isDrawingZoom(viewStateRef.current.zoom) || touches.size >= 2;

      if (!shouldRotate) {
        stopInertia(inertiaVelocity, releaseVelocity);
        wheelInertia.deltaX = 0;
        wheelInertia.deltaY = 0;
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
      stopInertia(inertiaVelocity, releaseVelocity);
      wheelInertia.deltaX = 0;
      wheelInertia.deltaY = 0;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (touches.has(event.pointerId)) {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      if (touches.size >= 2) {
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
          const point = spherePointFromPointer(
            event,
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
            sendClientMessage({
              type: "stroke_updated",
              strokeId: activeStroke.id,
              points: activeStroke.path,
            });
          }
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

      if (
        pointer.id === event.pointerId ||
        (pointer.rotating && pointer.multiTouch && touches.size < 2)
      ) {
        const wasRotating = pointer.rotating;
        if (pointer.drawing && activeStroke) {
          let keepPendingStroke = false;
          if (
            activeStroke.path.length > 0 &&
            connectionStateRef.current === "connected"
          ) {
            sendClientMessage({
              type: "drawing_commit_requested",
              strokeId: activeStroke.id,
              path: activeStroke.path,
              color: activeStroke.color,
              brushSize: activeStroke.brushSize,
            });
            keepPendingStroke = true;
            pendingLocalStrokes.set(activeStroke.id, {
              path: [...activeStroke.path],
              color: activeStroke.color,
              brushSize: activeStroke.brushSize,
            });
          } else {
            sendClientMessage({
              type: "stroke_cancelled",
              strokeId: activeStroke.id,
            });
          }

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

      if (event.ctrlKey || event.metaKey) {
        wheelInertia.deltaX = 0;
        wheelInertia.deltaY = 0;
        setZoom(viewStateRef.current.zoom - event.deltaY * 0.0012);
        return;
      }

      stopInertia(inertiaVelocity, releaseVelocity);
      const verticalDelta = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        -event.deltaY * wheelRotateSpeed,
      );
      const horizontalDelta = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        -event.deltaX * wheelRotateSpeed,
      );
      const orientation = horizontalDelta
        .multiply(verticalDelta)
        .multiply(quaternionStateToThree(viewStateRef.current.orientation))
        .normalize();
      updateView({
        ...viewStateRef.current,
        orientation: quaternionToState(orientation),
        autoRotateEnabled: false,
      });
      const nextWheelDeltaX =
        wheelInertia.deltaX * wheelInertiaAccumulation +
        event.deltaX * wheelInertiaBoost;
      const nextWheelDeltaY =
        wheelInertia.deltaY * wheelInertiaAccumulation +
        event.deltaY * wheelInertiaBoost;
      const nextWheelMagnitude = Math.hypot(nextWheelDeltaX, nextWheelDeltaY);

      if (nextWheelMagnitude >= startWheelInertiaDelta) {
        const clampedScale = Math.min(
          1,
          maxWheelInertiaDelta / nextWheelMagnitude,
        );
        wheelInertia.deltaX = nextWheelDeltaX * clampedScale;
        wheelInertia.deltaY = nextWheelDeltaY * clampedScale;
      } else {
        wheelInertia.deltaX = 0;
        wheelInertia.deltaY = 0;
      }
    };

    const onResize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      updateOrthographicCamera(camera, width, height, viewStateRef.current.zoom);
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

        pointer.lastAt = now;
        pendingMultiTouchRotation = false;
      }

      for (const event of eventQueueRef.current.splice(0)) {
        if (event.type === "drawing_committed") {
          const pendingEntry = findPendingStroke(
            pendingLocalStrokes,
            event.drawing.path,
          );
          if (pendingEntry) {
            transientStrokes.delete(`local:${pendingEntry.strokeId}`);
          }
          findTransientStroke(transientStrokes, event.drawing.path);

          drawingsRef.current = [...drawingsRef.current, event.drawing];
          paintDrawingOnOverlay(overlay, event.drawing);
          overlay.texture.needsUpdate = true;
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
            existing.path = event.points;
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
      }

      if (current.autoRotateEnabled && !isDrawingZoom(current.zoom)) {
        const orientation = quaternionStateToThree(current.orientation)
          .multiply(autoRotateStep(frameMs))
          .normalize();
        updateView(
          {
            ...current,
            orientation: quaternionToState(orientation),
          },
          false,
        );
      } else if (
        !pointer.active &&
        (Math.abs(wheelInertia.deltaX) > minWheelInertiaDelta ||
          Math.abs(wheelInertia.deltaY) > minWheelInertiaDelta)
      ) {
        const frameScale = frameMs / 16;
        const verticalDelta = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          -wheelInertia.deltaY * wheelRotateSpeed * frameScale,
        );
        const horizontalDelta = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          -wheelInertia.deltaX * wheelRotateSpeed * frameScale,
        );
        const orientation = horizontalDelta
          .multiply(verticalDelta)
          .multiply(quaternionStateToThree(current.orientation))
          .normalize();
        updateView(
          {
            ...current,
            orientation: quaternionToState(orientation),
          },
          true,
        );
        wheelInertia.deltaX *= wheelInertiaDamping;
        wheelInertia.deltaY *= wheelInertiaDamping;
      } else if (
        !pointer.active &&
        inertiaVelocity.speed > minInertiaVelocity
      ) {
        const delta = new THREE.Quaternion().setFromAxisAngle(
          inertiaVelocity.axis,
          inertiaVelocity.speed * frameMs,
        );
        const orientation = quaternionStateToThree(current.orientation)
          .multiply(delta)
          .normalize();
        updateView(
          {
            ...current,
            orientation: quaternionToState(orientation),
          },
          true,
        );
        inertiaVelocity.speed *= inertiaDamping;
      }

      updateOrthographicCamera(
        camera,
        host.clientWidth,
        host.clientHeight,
        viewStateRef.current.zoom,
      );
      sphere.quaternion.copy(
        quaternionStateToThree(viewStateRef.current.orientation),
      );
      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    onResize();
    animate();

    return () => {
      flushUrl();
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      host.removeChild(renderer.domElement);
      geometry.dispose();
      material.dispose();
      pendingLocalStrokes.clear();
      transientOverlay.texture.dispose();
      overlay.texture.dispose();
      fallbackTexture.dispose();
      renderer.dispose();
    };
  }, [bootstrap.status === "ready" ? bootstrap.snapshotFaces : undefined]);

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
      window.setTimeout(() => flushUrlRef.current(), 0);
      return next;
    });
  };

  return (
    <main className="relative h-dvh min-h-dvh w-screen overflow-hidden">
      <section
        className="fixed inset-0 grid h-dvh min-h-dvh min-w-0 place-items-center bg-neutral-800"
        aria-label="Shared drawing sphere"
      >
        <div
          ref={canvasHostRef}
          className={`absolute inset-0 h-full w-full touch-none [&_canvas]:block [&_canvas]:h-full [&_canvas]:w-full [&_canvas]:drop-shadow-[0_28px_70px_rgb(255_255_255_/_0.16)] ${
            drawingMode
              ? "cursor-crosshair"
              : "cursor-grab active:cursor-grabbing"
          }`}
        />
      </section>

      <header
        className="pointer-events-none fixed inset-x-0 top-0 z-5 flex"
        aria-label="World status"
      >
        <label className={`${panelClass} grid rounded-full overflow-hidden`}>
          <span className="relative block h-12 w-32 overflow-hidden">
            <span
              className="pointer-events-none absolute inset-y-0 left-0 bg-neutral-600"
              style={{ width: `${zoomProgress}%` }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute inset-y-0 w-px bg-neutral-950"
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

        <div className={`grow`}></div>

        {!drawingMode ? (
          <button
            type="button"
            className={`${buttonClass} w-12 h-12 grid place-items-center`}
            onClick={() =>
              updateViewFromControls((current) => ({
                ...current,
                autoRotateEnabled: !current.autoRotateEnabled,
              }))
            }
          >
            {viewState.autoRotateEnabled ? (
              <PauseIcon
                className={iconClass}
                fill="currentColor"
                aria-hidden="true"
              />
            ) : (
              <PlayIcon
                className={iconClass}
                fill="currentColor"
                aria-hidden="true"
              />
            )}
            <div className="hidden">
              {viewState.autoRotateEnabled
                ? autoRotateActive
                  ? "Auto-rotate on"
                  : "Auto suspended"
                : "Auto-rotate off"}
            </div>
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
            aria-live="polite"
          >
            <CircleIcon className={`${iconClass}`} fill="currentColor" />
          </div>

          <div className="w-full absolute left-0 top-0 h-12 flex items-center justify-end pr-6">
            {bootstrap.status === "ready"
              ? `${bootstrap.presenceCount}`
              : bootstrap.status === "loading"
                ? "0"
                : "0"}

            <div className="hidden">
              {bootstrap.status === "ready"
                ? `${bootstrap.presenceCount} present`
                : bootstrap.status === "loading"
                  ? "connecting"
                  : "offline"}
            </div>
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
            <h1 id="about-title" className="m-0 text-3xl font-semibold">
              Globe2
            </h1>
            <p className="mt-5 text-base leading-7 text-neutral-300">
              Globe2 is a shared drawing world on a single rotating sphere.
              Visitors can zoom in, draw persistent marks on the surface, and
              watch the globe accumulate contributions over time. There are no
              accounts or separate canvases here, just one public place that
              changes as people add to it.
            </p>
          </div>
        </div>
      ) : null}

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
          <button
            type="button"
            className={`${buttonClass} w-full h-12`}
            onClick={() =>
              updateViewFromControls((current) => ({
                ...current,
                zoom: viewSettings.comfortableDrawingZoom,
              }))
            }
          >
            Zoom in to draw
          </button>
        )}

        {bootstrap.status === "error" ? (
          <p className={`${panelClass} m-0 px-3 py-2 text-red-700`}>
            {bootstrap.message}
          </p>
        ) : null}
      </aside>
    </main>
  );
}

function readViewStateFromUrl(): ViewState {
  const params = new URLSearchParams(window.location.search);
  const zoom = clampZoom(
    readFiniteNumber(params.get("z"), viewSettings.initialZoom),
  );
  const orientation = readOrientationFromUrl(params);

  return {
    zoom,
    orientation: orientation ?? identityQuaternionState(),
    autoRotateEnabled: params.get("view") !== "manual" || !orientation,
  };
}

function writeViewStateToUrl(viewState: ViewState) {
  const params = new URLSearchParams(window.location.search);
  params.set("z", viewState.zoom.toFixed(2));

  if (viewState.autoRotateEnabled) {
    params.set("view", "auto");
    params.delete("qx");
    params.delete("qy");
    params.delete("qz");
    params.delete("qw");
    params.delete("yaw");
    params.delete("pitch");
  } else {
    const orientation =
      normalizeQuaternionState(viewState.orientation) ??
      identityQuaternionState();
    params.set("view", "manual");
    params.set("qx", orientation.x.toFixed(5));
    params.set("qy", orientation.y.toFixed(5));
    params.set("qz", orientation.z.toFixed(5));
    params.set("qw", orientation.w.toFixed(5));
    params.delete("yaw");
    params.delete("pitch");
  }

  const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
}

function readFiniteNumber(value: string | null, fallback: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function readOrientationFromUrl(
  params: URLSearchParams,
): QuaternionState | undefined {
  if (params.get("view") !== "manual") {
    return identityQuaternionState();
  }

  return normalizeQuaternionState({
    x: readFiniteNumber(params.get("qx"), Number.NaN),
    y: readFiniteNumber(params.get("qy"), Number.NaN),
    z: readFiniteNumber(params.get("qz"), Number.NaN),
    w: readFiniteNumber(params.get("qw"), Number.NaN),
  });
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
  texture.needsUpdate = true;

  return { texture, contexts };
}

function paintDrawingOnOverlay(
  overlay: OverlayCubeTexture,
  drawing: Pick<Drawing, "path" | "color" | "brushSize">,
) {
  const pathsByFace = new Map<string, Array<{ x: number; y: number }>>();

  for (const point of drawing.path) {
    const projection = projectUnitVectorToCubeFace(point);
    const textureUv = cubeProjectionToTextureUv(projection);
    const facePath = pathsByFace.get(projection.face) ?? [];
    facePath.push({
      x: textureUv.u * overlayFaceSize,
      y: textureUv.v * overlayFaceSize,
    });
    pathsByFace.set(projection.face, facePath);
  }

  for (const [faceName, path] of pathsByFace) {
    const context = overlay.contexts[faceName];

    if (!context || path.length === 0) {
      continue;
    }

    context.save();
    context.strokeStyle = drawing.color;
    context.fillStyle = drawing.color;
    context.lineWidth = brushPixelWidth(drawing.brushSize);
    context.lineCap = "round";
    context.lineJoin = "round";

    if (path.length === 1) {
      context.beginPath();
      context.arc(path[0].x, path[0].y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.beginPath();
      context.moveTo(path[0].x, path[0].y);
      for (const point of path.slice(1)) {
        context.lineTo(point.x, point.y);
      }
      context.stroke();
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

  if (!hit) {
    return undefined;
  }

  const localPoint = sphere.worldToLocal(hit.point.clone()).normalize();

  return { x: localPoint.x, y: localPoint.y, z: localPoint.z };
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
