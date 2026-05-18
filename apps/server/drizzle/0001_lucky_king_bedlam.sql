CREATE INDEX "drawings_world_status_idx" ON "drawings" USING btree ("world_id","status");--> statement-breakpoint
CREATE INDEX "drawings_visit_status_idx" ON "drawings" USING btree ("visit_id","status");--> statement-breakpoint
CREATE INDEX "snapshots_world_status_idx" ON "snapshots" USING btree ("world_id","status");--> statement-breakpoint
CREATE INDEX "visits_world_status_idx" ON "visits" USING btree ("world_id","status");--> statement-breakpoint
CREATE INDEX "world_events_world_revision_idx" ON "world_events" USING btree ("world_id","revision");