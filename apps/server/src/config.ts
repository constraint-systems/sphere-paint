import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  SERVER_HOST: z.string().default("127.0.0.1"),
  SERVER_PORT: z.coerce.number().int().positive().default(3000),
  SNAPSHOT_STORE_MODE: z.enum(["local", "s3"]).default("local"),
  LOCAL_SNAPSHOT_DIR: z.string().default(".data/snapshots"),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_S3_BUCKET: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  VISIT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  SNAPSHOT_CHECK_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  SNAPSHOT_MIN_ELIGIBLE_DRAWINGS: z.coerce.number().int().positive().default(500),
  SNAPSHOT_AGE_HOURS: z.coerce.number().int().positive().default(24),
  SNAPSHOT_MIN_AGED_DRAWINGS: z.coerce.number().int().positive().default(50)
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
