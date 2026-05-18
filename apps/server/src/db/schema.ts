import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";

export const drawingStatus = pgEnum("drawing_status", ["active", "baked"]);
export const snapshotStatus = pgEnum("snapshot_status", ["pending", "promoted", "failed"]);
export const visitStatus = pgEnum("visit_status", ["active", "expired"]);

export const worlds = pgTable("worlds", {
  id: uuid("id").primaryKey().defaultRandom(),
  currentSnapshotId: uuid("current_snapshot_id"),
  currentRevision: integer("current_revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const visits = pgTable(
  "visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    status: visitStatus("status").notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    worldStatusIdx: index("visits_world_status_idx").on(table.worldId, table.status)
  })
);

export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    status: snapshotStatus("status").notNull().default("pending"),
    faceUrls: jsonb("face_urls").notNull(),
    sourceFromRevision: integer("source_from_revision").notNull().default(0),
    sourceToRevision: integer("source_to_revision").notNull().default(0),
    promotedRevision: integer("promoted_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    promotedAt: timestamp("promoted_at", { withTimezone: true })
  },
  (table) => ({
    worldStatusIdx: index("snapshots_world_status_idx").on(table.worldId, table.status)
  })
);

export const drawings = pgTable(
  "drawings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    visitId: uuid("visit_id").notNull().references(() => visits.id),
    path: jsonb("path").notNull(),
    color: text("color").notNull(),
    brushSize: text("brush_size").notNull(),
    status: drawingStatus("status").notNull().default("active"),
    createdRevision: integer("created_revision").notNull(),
    snapshotId: uuid("snapshot_id").references(() => snapshots.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    worldStatusIdx: index("drawings_world_status_idx").on(table.worldId, table.status),
    visitStatusIdx: index("drawings_visit_status_idx").on(table.visitId, table.status)
  })
);

export const worldEvents = pgTable(
  "world_events",
  {
    revision: integer("revision").primaryKey(),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    worldRevisionIdx: index("world_events_world_revision_idx").on(table.worldId, table.revision)
  })
);

export const schema = {
  drawings,
  snapshots,
  visits,
  worlds,
  worldEvents
};

export const nowPlusVisitTimeout = (seconds: number) =>
  sql<Date>`now() + (${seconds} || ' seconds')::interval`;
