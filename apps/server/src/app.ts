import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket } from "@fastify/websocket";
import { clientMessageSchema, type ServerEvent } from "@globe2/shared";
import Fastify from "fastify";
import type { AppConfig } from "./config";
import { createDb } from "./db/client";
import { createSnapshotStore } from "./snapshot-store";
import { SnapshotWorker } from "./snapshot-worker";
import { defaultWorld, WorldService } from "./world-service";

export function createApp(config: AppConfig) {
  const app = Fastify({ logger: true });
  const { db, pool } = createDb(config.DATABASE_URL);
  const worldService = new WorldService(db, config);
  type PresenceConnection = {
    visitId: string;
    connectionId: string;
    socket: WebSocket;
    isAlive: boolean;
    send: (event: ServerEvent) => void;
  };
  const sockets = new Set<PresenceConnection>();
  const heartbeatIntervalMs = 60_000;

  function presenceCount() {
    return sockets.size;
  }

  function broadcast(event: ServerEvent) {
    for (const socket of sockets) {
      socket.send(event);
    }
  }

  function broadcastExcept(event: ServerEvent, excludedConnectionId: string) {
    for (const socket of sockets) {
      if (socket.connectionId !== excludedConnectionId) {
        socket.send(event);
      }
    }
  }

  function broadcastPresence() {
    broadcast({ type: "presence_changed", presenceCount: presenceCount() });
  }

  function removeConnection(connection: PresenceConnection) {
    if (!sockets.delete(connection)) {
      return;
    }

    broadcastPresence();

    broadcastExcept({
      type: "stroke_cancelled",
      visitId: connection.visitId,
      connectionId: connection.connectionId,
      strokeId: "*"
    }, connection.connectionId);
  }

  app.register(cors, {
    origin: config.APP_ORIGIN,
    credentials: false
  });
  app.register(websocket);

  app.get("/api/health", async () => ({
    ok: true
  }));

  app.get<{ Params: { face: string } }>("/snapshots/blank-v2/:face", async (request, reply) => {
    if (!["px", "nx", "py", "ny", "pz", "nz"].includes(request.params.face.replace(/\.png$/, ""))) {
      return reply.code(404).send({ error: "Snapshot face not found" });
    }

    return reply
      .type("image/svg+xml")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(initialSnapshotFaceSvg());
  });

  type RunCheck = (options?: {
    forceRun?: boolean;
  }) => Promise<Extract<ServerEvent, { type: "snapshot_promoted" }> | null>;
  let workerRunCheck: RunCheck | undefined;

  app.addHook("onReady", async () => {
    await worldService.ensureDefaultWorld();
    workerRunCheck = createSnapshotRunner();
  });

  app.addHook("onClose", async () => {
    clearInterval(heartbeatInterval);
    await pool.end();
  });

  const heartbeatInterval = setInterval(() => {
    for (const connection of sockets) {
      if (!connection.isAlive) {
        removeConnection(connection);
        connection.socket.terminate();
        continue;
      }

      connection.isAlive = false;
      try {
        connection.socket.ping();
      } catch {
        removeConnection(connection);
        connection.socket.terminate();
      }
    }
  }, heartbeatIntervalMs);
  heartbeatInterval.unref();

  app.get<{ Headers: { "x-visit-id"?: string } }>("/api/bootstrap", async (request) =>
    worldService.bootstrap(request.headers["x-visit-id"], presenceCount())
  );

  app.get("/api/snapshots", async () => ({
    snapshots: await worldService.listPromotedSnapshots()
  }));

  app.get<{ Querystring: { offset?: string; limit?: string } }>("/api/replay-drawings", async (request) =>
    worldService.listReplayDrawingsPage(
      Number(request.query.offset ?? 0),
      Number(request.query.limit ?? 500)
    )
  );

  app.after(() => {
    app.get("/api/ws", { websocket: true }, (socket) => {
      let connection: PresenceConnection | undefined;
      let subscribing = false;

      socket.on("pong", () => {
        if (connection) {
          connection.isAlive = true;
        }
      });

      socket.on("message", (message: Buffer) => {
        app.log.debug({ message: message.toString() }, "websocket message received");
        const rawMessage = parseJson(message);

        if (!rawMessage.ok) {
          socket.send(JSON.stringify({ type: "error", code: "validation_failed" } satisfies ServerEvent));
          return;
        }

        const parsed = clientMessageSchema.safeParse(rawMessage.value);

        if (!parsed.success) {
          socket.send(JSON.stringify({ type: "error", code: "validation_failed" } satisfies ServerEvent));
          return;
        }

        const clientMessage = parsed.data;

        if (clientMessage.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", nonce: clientMessage.nonce } satisfies ServerEvent));
          return;
        }

        if (!connection && clientMessage.type !== "subscribe") {
          socket.send(
            JSON.stringify({
              type: "error",
              code: "invalid_visit",
              message: "Subscribe before sending realtime messages"
            } satisfies ServerEvent)
          );
          return;
        }

        if (connection && clientMessage.type === "stroke_started") {
          broadcastExcept({
            type: "stroke_started",
            visitId: connection.visitId,
            connectionId: connection.connectionId,
            strokeId: clientMessage.strokeId,
            point: clientMessage.point,
            color: clientMessage.color,
            brushSize: clientMessage.brushSize
          }, connection.connectionId);
          return;
        }

        if (connection && clientMessage.type === "stroke_updated") {
          broadcastExcept({
            type: "stroke_updated",
            visitId: connection.visitId,
            connectionId: connection.connectionId,
            strokeId: clientMessage.strokeId,
            appendedPoints: clientMessage.appendedPoints
          }, connection.connectionId);
          return;
        }

        if (connection && clientMessage.type === "stroke_cancelled") {
          broadcastExcept({
            type: "stroke_cancelled",
            visitId: connection.visitId,
            connectionId: connection.connectionId,
            strokeId: clientMessage.strokeId
          }, connection.connectionId);
          return;
        }

        if (connection && clientMessage.type === "drawing_commit_requested") {
          void worldService
            .commitDrawing({
              visitId: connection.visitId,
              path: clientMessage.path,
              color: clientMessage.color,
              brushSize: clientMessage.brushSize
            })
            .then((event) => broadcast({ ...event, strokeId: clientMessage.strokeId }))
            .catch((error: unknown) => {
              app.log.error(error);
              socket.send(JSON.stringify({ type: "error", code: "validation_failed" } satisfies ServerEvent));
            });
          return;
        }

        if (clientMessage.type !== "subscribe") {
          socket.send(JSON.stringify({ type: "error", code: "validation_failed" } satisfies ServerEvent));
          return;
        }

        if (connection || subscribing) {
          socket.send(
            JSON.stringify({
              type: "error",
              code: "validation_failed",
              message: "WebSocket is already subscribed"
            } satisfies ServerEvent)
          );
          return;
        }

        subscribing = true;
        void (async () => {
          const bootstrap = await worldService.bootstrap(clientMessage.visitId, presenceCount());
          const connectionId = crypto.randomUUID();

          connection = {
            visitId: bootstrap.visitId,
            connectionId,
            socket,
            isAlive: true,
            send: (event) => socket.send(JSON.stringify(event))
          };
          sockets.add(connection);

          socket.send(
            JSON.stringify({
              type: "subscribed",
              visitId: bootstrap.visitId,
              presenceCount: presenceCount(),
              revision: bootstrap.revision
            } satisfies ServerEvent)
          );

          const catchupEvents = await worldService.getCatchupEvents(
            defaultWorld.id,
            clientMessage.lastSeenRevision
          );

          for (const event of catchupEvents) {
            socket.send(JSON.stringify(event));
          }

          broadcastPresence();
        })().catch((error: unknown) => {
          app.log.error(error);
          socket.send(JSON.stringify({ type: "error", code: "server_error" } satisfies ServerEvent));
        }).finally(() => {
          subscribing = false;
        });
      });

      socket.on("close", () => {
        if (!connection) {
          return;
        }

        removeConnection(connection);
      });
    });
  });

  function createSnapshotRunner(): RunCheck {
    const store = createSnapshotStore(config);
    const worker = new SnapshotWorker(worldService, config, store);
    let running = false;

    const runCheck: RunCheck = async (options) => {
      if (running) return null;
      running = true;
      try {
        const event = await worker.runCheck(options);
        if (event) {
          app.log.info({ snapshotId: event.snapshotId, revision: event.revision }, "snapshot promoted");
          broadcast(event);
        }
        return event;
      } finally {
        running = false;
      }
    };

    return runCheck;
  }

  app.post<{ Headers: { authorization?: string } }>(
    "/api/admin/force-snapshot",
    async (request, reply) => {
      const secret = config.ADMIN_SECRET;
      if (!secret) {
        return reply.code(404).send();
      }
      if (request.headers.authorization !== `Bearer ${secret}`) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      if (!workerRunCheck) {
        return reply.code(503).send({ error: "Worker not ready" });
      }
      try {
        const event = await workerRunCheck({ forceRun: true });
        if (!event) {
          return reply.code(200).send({ promoted: false, reason: "No eligible drawings or worker busy" });
        }
        return reply.code(200).send({
          promoted: true,
          snapshotId: event.snapshotId,
          revision: event.revision,
          bakedCount: event.bakedDrawingIds?.length ?? 0,
        });
      } catch (error: unknown) {
        app.log.error(error, "force-snapshot error");
        return reply.code(500).send({ error: String(error) });
      }
    },
  );

  return app;
}

function parseJson(message: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(message.toString()) };
  } catch {
    return { ok: false };
  }
}

function initialSnapshotFaceSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048" viewBox="0 0 2048 2048">
  <rect width="2048" height="2048" fill="#fff"/>
</svg>`;
}
