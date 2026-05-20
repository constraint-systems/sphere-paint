# Technical Plan

## Product boundary

`globe2` v1 is a single shared World with one rotatable Sphere. Guests enter without accounts, draw persistent strokes on the Sphere, and see other Guests' live In-Progress Strokes.

V1 includes Guest-only Visits, Visit-scoped ownership, Presence Count, Initial View, Auto-Rotate View, Drawing Zoom Threshold, a fixed Drawing Palette, two Brush Sizes, durable Drawings, ephemeral In-Progress Strokes, and automatic irreversible Snapshots.

V1 excludes accounts, multiple public Worlds, moderation workflows, avatars, replay history, editable history, undo, erasing, and public admin UI. Committed Drawings are permanent; Users correct mistakes by drawing over them.

## Repository shape

Use a TypeScript workspace monorepo:

- `apps/client`: React, Vite, Three.js client.
- `apps/server`: Fastify HTTP/WebSocket server and Snapshot worker entrypoints.
- `packages/shared`: shared Zod event schemas, drawing types, palette/brush constants, coordinate helpers, and protocol definitions.

Use Zod for shared HTTP/WebSocket schemas and basic Drawing payload validation. Use Vitest for shared, server, and client-adjacent unit tests.

## Durable state

Postgres is the source of truth for durable World state. The live app uses Railway-hosted Postgres. Use Drizzle for schema definitions and migrations.

Keep `worldId` internally even though product behavior exposes only one World.

Initial tables:

- `worlds`: `id`, `current_snapshot_id`, `current_revision`, `created_at`.
- `visits`: `id`, `world_id`, `status`, `last_seen_at`, `expires_at`, `created_at`.
- `drawings`: `id`, `world_id`, `visit_id`, `path`, `color`, `brush_size`, `status`, `created_revision`, `snapshot_id`, `created_at`.
- `snapshots`: `id`, `world_id`, `status`, `face_urls`, `source_from_revision`, `source_to_revision`, `promoted_revision`, `created_at`, `promoted_at`.
- `world_events`: `revision`, `world_id`, `type`, `payload`, `created_at`.

`world_events` is an append-only delivery and catch-up log, not the source of truth. Retain events for reconnect and short outage catch-up, initially around 24 hours.

Use JSONB for `drawings.path`; Drawings are loaded and rendered as whole strokes, and v1 does not query individual points. Use JSONB for `snapshots.face_urls` with a fixed Zod/TypeScript shape keyed by cube face name. Use an explicit Drawing status enum such as `active` and `baked`, plus nullable fact columns like `snapshot_id`.

Generate revisions by incrementing `worlds.current_revision` inside the same database transaction that writes the durable state change and `world_events` row. Store enough `world_events.payload` data to deliver catch-up without re-querying historical row state: `drawing_committed` includes the full committed Drawing snapshot; Snapshot events use compact payloads.

## Visits and permanence

Guests have no persistent identity across visits. A Visit has a temporary Visit Identity that may survive short network drops, tab refreshes, and WebSocket reconnects. A Visit ends on explicit reset/leave, loss of Visit Identity, or inactivity past the Visit timeout. Use a 2-minute reconnect grace after disconnect.

Visit Identity is an opaque random id stored in Postgres and held by the client in `localStorage`. Do not use signed structured tokens in v1. Do not rotate Visit Identity during reconnect grace. Explicit reset/leave clears the client id and ends the Visit.

Presence Count includes currently connected sessions only, including the current Guest once subscribed. Multiple tabs count separately even when they share the same Visit Identity. Guests in reconnect grace retain Visit ownership for attribution, but do not count as present until reconnected.

Committed Drawings are permanent. There is no undo window, eraser, or removal workflow in v1. White is paint, not deletion. Users repair or revise marks by drawing over them, preserving the shared accumulated history of the World.

## Drawing model

Drawings are stored as ordered paths in canonical Sphere coordinates, not screen coordinates, face-local pixels, or texture pixels. Encode each path point as a normalized 3D unit vector `{ x, y, z }` on the Sphere surface. A Drawing remains one owned stroke even when rendering must split it across cube faces or projection boundaries.

Use a fixed ten-color Drawing Palette represented as explicit hex colors: `#111111`, `#ffffff`, `#d92d20`, `#f97316`, `#facc15`, `#16a34a`, `#2563eb`, `#7c3aed`, `#7c4a2d`, and `#d2b48c`. White is visual paint only, not an eraser. Use two Brush Sizes: fine and bold. Brush Sizes are angular widths on the Sphere surface, not screen-pixel or texture-pixel widths.

Do not support pressure-sensitive strokes in v1. Store sampled canonical points after lightweight client-side simplification; do not store Bezier curves.

Drawing path points do not store per-point timestamps or cube face ids. Derive cube face from the unit vector during rendering/rasterization. Path simplification happens after converting pointer hits to unit vectors, using angular or chord distance on the Sphere. Store a new point when distance from the previous stored point is roughly 25-40% of the selected Brush Size's angular width, then tune after rendering tests.

Drawing samples come from front-facing raycast intersections with the Sphere. If the pointer leaves the Sphere or has no valid visible-surface intersection, the stroke pauses or ends.

If zoom drops below the Drawing Zoom Threshold during a stroke, cancel the stroke unless valid segments have already been sampled while above the threshold. Drawing permission is evaluated continuously.

Drawing Mode is derived from zoom only. When zoomed out below the Drawing Zoom Threshold, the drawing controls area shows "zoom in to draw". When zoomed in at or beyond the threshold, that area is replaced by the Drawing Palette and Brush Size controls.

The "zoom in to draw" affordance is actionable. Activating it zooms the current View past the Drawing Zoom Threshold to a comfortable default drawing zoom.

Server validation is intentionally minimal: active Visit Identity, correct World, non-empty point list, maximum point count/payload size, approximately unit-length coordinates, allowed palette color, and allowed Brush Size. Do not attempt to prove Drawing Zoom Threshold server-side in v1.

## View behavior

View state is client-owned in v1. The server does not persist personal rotation, framing, zoom, or Auto-Rotate preference.

Represent View state in the URL with debounced updates so a Guest can share a View. Manual View state includes a normalized Sphere-to-View orientation quaternion and normalized zoom. Auto-Rotate View is represented as a separate URL state that replaces manual orientation in the URL, but zoom remains part of the URL in both modes. If no zoom is present, use Initial View zoom.

Use normalized app-level zoom from `0..1`, where `0` is the Initial View far zoom and `1` is the closest allowed drawing zoom. Initially set the Drawing Zoom Threshold around `0.65` and comfortable default drawing zoom around `0.8`; map this normalized value to Three.js camera behavior internally.

Initial View is Auto-Rotate View enabled at zoom `0`, not a fixed location.

URL View State does not include Visit Identity or drawing tool selections. Visit Identity stays in `localStorage` with server expiry. Drawing Palette color and Brush Size are local preferences stored in `localStorage`.

Use one debounced `history.replaceState` mechanism for ordinary View rotation, inertia, zoom, and Auto-Rotate URL updates. Do not continuously write View orientation while Auto-Rotate is active; write Auto-Rotate state and zoom only. Include a small copy-link control that flushes pending debounced View updates before copying the current URL.

Auto-Rotate View has separate preference and activity state:

- `autoRotateEnabled`: the Guest's preference.
- `autoRotateActive`: derived from preference plus current zoom.

When the Guest zooms past the Drawing Zoom Threshold, Auto-Rotate becomes suspended rather than turned off. If enabled, it resumes automatically after zooming back out below the threshold. The control should represent off, on, and suspended-on states. In suspended-on state, the Guest can still turn the preference off.

Auto-Rotate incrementally moves the current View orientation in a fixed pleasant direction while active. The current Auto-Rotate orientation is not written to the URL. When the Guest manually rotates their View of the Sphere, Auto-Rotate turns off and URL state becomes manual orientation plus zoom at the current orientation. Turning Auto-Rotate on continues from the current View orientation instead of jumping to a separate tour phase. Zooming while Auto-Rotate is active keeps Auto-Rotate enabled unless the zoom level suspends activity.

## Realtime protocol

Use the Fastify server for HTTP plus WebSocket behavior. Keep active connections, Presence Count membership, and In-Progress Strokes in memory for v1. Deploy one server instance initially.

Presence Count is exact within the single v1 server instance.

WebSocket subscribe initializes the connection with Visit Identity. After that, the server associates the socket with the Visit and messages do not repeat Visit Identity.

One Visit Identity may have multiple simultaneous connections. Treat them as one Visit for ownership, but count each subscribed connection separately for Presence Count.

In-Progress Strokes are ephemeral WebSocket events keyed by connection plus client-generated stroke id. They are not stored in Postgres. Clear active In-Progress Strokes when their connection disconnects.

Committed Drawings become durable only after server confirmation. Clients may render their own In-Progress Stroke immediately; after commit, replace it with the server-confirmed Drawing.

Bootstrap returns:

- World id.
- Latest Snapshot face URLs/version.
- Current unbaked Drawings.
- Presence Count.
- Drawing settings.
- Drawing Zoom Threshold and comfortable default drawing zoom.
- Initial View.
- Current server time.
- Current World revision.

The WebSocket subscribe message includes `lastSeenRevision`. The server sends missed committed Drawing, Snapshot promotion, and reset events after that revision before live events. In-Progress Strokes do not need catch-up.

Initial WebSocket message types:

Client to server:

- `subscribe`
- `stroke_started`
- `stroke_updated`
- `stroke_cancelled`
- `drawing_commit_requested`
- `ping`

Server to client:

- `subscribed`
- `presence_changed`
- `stroke_started`
- `stroke_updated`
- `stroke_cancelled`
- `drawing_committed`
- `snapshot_promoted`
- `world_reset`
- `error`
- `pong`

Snapshot promotion emits one `snapshot_promoted` event containing the new Snapshot version/background face URLs and a cutoff revision or baked Drawing id range/list. Clients swap the baked background and rebuild the unbaked overlay.

Admin force-snapshot can promote a new Snapshot for operational recovery or migration.

`drawing_committed` includes the full committed Drawing. `snapshot_promoted` does not include the full remaining unbaked Drawing list during normal live delivery.

Use the same shared Zod schemas for revision-bearing events whether they are delivered through bootstrap catch-up or live WebSocket. Server errors use structured codes such as `invalid_visit`, `validation_failed`, `rate_limited`, `stale_revision`, and `server_error`.

The client reconnects automatically with backoff using the same Visit Identity and last seen revision. If catch-up succeeds, continue. If `lastSeenRevision` is older than retained `world_events`, the server responds with `stale_revision` and the client re-bootstraps. If the Visit expired, the client starts a new Visit. Do not preserve or replay unsent In-Progress Strokes across reconnect in v1.

Show a minimal connection status indicator for connecting, reconnecting, and offline. During reconnect/offline states, disable committing new Drawings and show drawing controls as unavailable.

While reconnecting/offline, Palette and Brush Size controls may remain visible when zoomed in, but are disabled. Users may still rotate and zoom the View locally.

## Rendering and snapshots

Use Three.js for the Sphere and View interaction, with regular React/HTML/CSS controls around it.

The Sphere stage is full-viewport and full-bleed. UI overlays sit over the Sphere rather than reserving layout space. Use fixed top and bottom overlays on both desktop and mobile:

- Top overlay: app identity, Presence Count, connection state, copy-link, and Auto-Rotate control.
- Bottom overlay: zoom affordance, Drawing Mode controls, Drawing Palette, and Brush Size controls.
- Overlay containers should not block Sphere gestures in empty space; only actual controls capture pointer events.
- Keep overlays compact, always visible, and translucent enough that the Sphere remains visually dominant.
- Initial View zoom should show the whole Sphere. At closer zoom levels, overlays may overlap the Sphere edges.

Desktop input behavior:

- Below the Drawing Zoom Threshold, click-drag rotates the Guest's View of the Sphere.
- At or beyond the Drawing Zoom Threshold, click-drag draws on the Sphere.
- Ordinary scroll rotates the Guest's View of the Sphere. Trackpad/browser pinch zoom, represented as ctrl/cmd-wheel, zooms the View in both rotation and Drawing Mode.
- Manual View rotation uses grab-and-keep surface interaction: pointer down anchors a visible Sphere point, valid pointer moves keep that point under the pointer by applying quaternion deltas to the Guest's View Orientation, and pointer moves off the visible Sphere pause rotation until a valid hit returns. This changes only the Guest's View, not the shared World.

Mobile input behavior:

- Below the Drawing Zoom Threshold, one-finger drag rotates the Guest's View of the Sphere.
- At or beyond the Drawing Zoom Threshold, one-finger drag draws on the Sphere.
- At or beyond the Drawing Zoom Threshold, two-finger drag rotates the Guest's View of the Sphere.
- Pinch zoom remains available.

View rotation has quaternion/angular-velocity inertia after drag rotation, including zoomed-in two-finger rotation gestures. Inertia starts only when release angular velocity exceeds a small threshold, so settled/precise gestures stop immediately. Starting a drawing gesture or new rotation gesture cancels current inertia.

The baked Sphere background is a cube-map with six square faces. Drawings remain canonical Sphere-coordinate paths; cube faces are raster output only.

Use 2048x2048 per cube face for v1 baked Snapshot faces and client overlay textures. Monitor mobile GPU memory; 1024x1024 is the fallback.

Create an initial Snapshot with six blank white opaque cube faces during setup/seed. Baked Snapshot faces are fully composited opaque images. Client unbaked overlay faces are transparent textures composited over the baked cube-map.

Rasterization should intentionally overdraw or bleed strokes onto neighboring cube faces near face edges to hide seams. Do not clamp canonical Drawings at face boundaries.

Client rendering:

- Load the latest baked Snapshot cube-map as the base Sphere texture.
- Render committed unbaked Drawings into a client-side overlay cube-map texture.
- Incrementally paint normal committed Drawing events into the overlay.
- Rebuild the overlay from the unbaked Drawing list after bootstrap, reconnect catch-up, Snapshot promotion, or ambiguity.
- Render active In-Progress Strokes as temporary geometry or transient overlay.

Do not enable drawing until bootstrap has returned current World state and the unbaked overlay is built. It is acceptable to show the baked Snapshot first with drawing unavailable while the overlay rebuilds.

Snapshot rasterization runs server-side in a background worker. The worker renders eligible canonical Sphere-coordinate Drawings into the latest cube-map background, writes new immutable face objects, then promotes the Snapshot in Postgres.

Snapshot trigger:

- Run a periodic worker check, initially every 60 seconds.
- Snapshot when there are at least 500 eligible unbaked Drawings.
- Also snapshot when the oldest eligible unbaked Drawing is older than 24 hours and there are at least 50 eligible Drawings.
- Eligible means old enough to avoid racing very recent commits and not already baked.

Snapshot creation is staged and idempotent:

- Select a cutoff revision at job start.
- Render eligible Drawings at or below the cutoff revision onto the previous current Snapshot.
- Render and store new face images under versioned keys.
- Create or update a pending Snapshot record.
- In one database transaction, mark eligible Drawings baked and promote the Snapshot.
- If promotion fails, clients keep using the previous Snapshot plus unbaked Drawings.

New Drawings that become eligible while a Snapshot is rendering wait for the next Snapshot. Retain enough Drawing data early on to support full rebuild/debug paths, but normal promotion is incremental.

Do not hold a database lock during rasterization. Take a short transaction lock only during promotion/revision assignment. During promotion, verify the previous current Snapshot is still the expected one, mark Drawings baked, update the current Snapshot and revision, append the event, and commit. Drawing commits may briefly contend during this promotion transaction but should continue while rasterization runs.

Keep baked Drawing rows initially with `snapshot_id` for debugging, recovery, and possible re-rendering. Exclude baked Drawings from normal client load.

## Snapshot face storage

Use a `SnapshotFaceStore` interface. Local development writes faces to an ignored runtime directory such as `.data/snapshots/`. The live app writes immutable public Snapshot faces to AWS S3. Postgres stores only metadata and face locations.

Snapshot face URLs are public. Writes are server-only. Each promoted Snapshot uses immutable versioned keys; do not overwrite currently referenced face objects in place.

## Operations and deployment

Run the live app directly on a Linux VPS, not Docker.

Use Nginx to serve built React assets, terminate TLS, and reverse-proxy `/api` and WebSocket routes to the Fastify server.

Use PM2 to run separate long-lived Node processes:

- API/WebSocket server.
- Snapshot worker.

Keep the application process-manager agnostic: normal Node entrypoints, PM2 config for v1 operations.

Use Railway Postgres for live and local development database access. Use AWS S3 for live Snapshot faces.

Include:

- PM2 ecosystem config.
- Nginx config template and deployment notes.
- No full-server provisioning script in v1.

Avoid cookie-authenticated state-changing endpoints in v1. Send Visit Identity explicitly in headers or request bodies, and validate allowed HTTP/WebSocket origins. Configure allowed origins through environment variables with local dev defaults and strict production values.

Expected configuration surface:

- `DATABASE_URL`.
- Public app origin / allowed origins.
- Server host and port.
- Snapshot store mode, fixed to S3 for deployment.
- AWS region, S3 bucket, and credentials.
- PM2 process names.
- Rate limit settings.
- Snapshot trigger thresholds.
- Visit timeout.
- Drawing/view settings.

## Operational controls

V1 has no product-level moderation, reporting, bans, or persistent identity. Include operational controls only:

- Per-Visit rate limits.
- Payload size caps.
- Fixed palette and Brush Size validation.
- Protected script or admin-only endpoint for reset, clearing unbaked Drawings, and forcing Snapshots.

## Implementation milestones

### 1. Workspace and contracts (complete)

Create the TypeScript workspace, React/Vite client, Fastify server, shared package, Drizzle setup, Vitest setup, and baseline environment loading.

Acceptance checks:

- `apps/client`, `apps/server`, and `packages/shared` build.
- Vitest runs across the workspace.
- Drizzle can connect to Railway Postgres and run an initial migration.
- Shared Zod schemas are importable from client and server.

### 2. Shared geometry and settings (complete)

Implement the canonical Drawing model, unit-vector validation, cube-face selection, path clipping/bleed helpers, normalized zoom settings, palette/brush constants, and snapshot eligibility helpers.

Acceptance checks:

- Vitest covers unit-vector coordinate handling, cube-face selection, edge clipping/bleed, palette/brush validation, normalized zoom thresholds, and Snapshot eligibility.
- Brush Sizes are represented as angular Sphere-surface widths.
- Drawing paths do not include timestamps or face ids.

### 3. Durable World and realtime foundation (complete)

Implement the initial schema, seed the single World and blank Snapshot, create Visit Identity handling, bootstrap, WebSocket subscribe, revision assignment, `world_events`, Presence Count, reconnect, and stale-revision recovery.

Acceptance checks:

- Bootstrap returns Snapshot faces, unbaked Drawings, settings, Presence Count, server time, and revision.
- A Visit Identity survives refresh/reconnect within the 2-minute grace period.
- Presence Count counts each subscribed tab/connection, even when multiple tabs share one Visit Identity.
- WebSocket catch-up delivers missed revision events or returns `stale_revision`.

### 4. Globe View and controls

Build the Three.js Sphere, cube-map background loading, URL View State, Initial View, Auto-Rotate states, normalized zoom, inertia, desktop/mobile gesture behavior, connection indicator, copy-link control, and zoom-derived Drawing Mode controls.

Acceptance checks:

- Initial View is Auto-Rotate at zoom `0`.
- URL state represents either manual orientation quaternion+zoom or Auto-Rotate+zoom, using debounced `replaceState`.
- Manual rotation turns Auto-Rotate off; zoom can suspend and resume Auto-Rotate.
- Manual rotation uses grab-and-keep surface interaction; inertia applies after meaningful angular velocity and stops immediately when drawing starts.
- Below the Drawing Zoom Threshold, the controls show actionable "zoom in to draw"; above it, they show Palette and Brush Size controls.

### 5. Live drawing

Implement raycast-based drawing, Sphere-space path simplification, In-Progress Stroke broadcast, committed Drawing confirmation, minimal server validation, and local overlay updates.

Acceptance checks:

- In-Progress Strokes are visible to other connected clients and clear on disconnect.
- Committed Drawings appear after server confirmation with full Drawing payloads.
- Drawing is unavailable until bootstrap and overlay rebuild complete.
- Offline/reconnecting states disable Drawing commit while preserving local View controls.

### 6. Cube-map overlay rendering

Implement client-side transparent overlay cube-map painting for committed unbaked Drawings, incremental paint on normal commits, rebuild-on-reconnect/Snapshot promotion, and seam bleed across neighboring faces.

Acceptance checks:

- Baked Snapshot faces and unbaked overlay faces composite correctly.
- Face boundaries do not visibly clamp strokes.
- Overlay can rebuild from the bootstrap unbaked Drawing list.
- Mobile memory can fall back to 1024x1024 faces if needed.

### 7. Snapshot worker and storage

Implement `SnapshotFaceStore`, local `.data/snapshots/` storage, server-side rasterization, staged/idempotent Snapshot promotion, cutoff revision selection, immutable face keys, `snapshot_promoted`, forced Snapshot, and AWS S3 storage.

Acceptance checks:

- Worker snapshots eligible Drawings according to configured thresholds.
- Promotion uses a short transaction and does not lock during rasterization.
- Failed pending Snapshots do not affect clients.
- Clients handle `snapshot_promoted` by swapping backgrounds and rebuilding overlays.
- Local filesystem and AWS S3 stores share the same interface.

### 8. Operations and deployment

Add operational force-snapshot tooling, PM2 ecosystem config, Nginx template, deployment notes, production environment documentation, rate limits, payload caps, and origin validation.

Acceptance checks:

- The VPS can run separate PM2 processes for server and Snapshot worker.
- Nginx serves the built React app and proxies API/WebSocket routes.
- Railway Postgres and AWS S3 config are documented.
- Admin force-snapshot can promote a new Snapshot and return its revision.
- Required environment/config keys are listed and validated at startup.
