import { z } from "zod";

const configSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    APP_ORIGIN: z.string().url().default("http://localhost:5173"),
    SERVER_HOST: z.string().default("127.0.0.1"),
    SERVER_PORT: z.coerce.number().int().positive().default(47291),
    SNAPSHOT_STORE_MODE: z.literal("s3").default("s3"),
    AWS_REGION: z.string().default("us-east-1"),
    AWS_S3_BUCKET: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    VISIT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
    SNAPSHOT_CHECK_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
    SNAPSHOT_MIN_ELIGIBLE_DRAWINGS: z.coerce.number().int().positive().default(500),
    SNAPSHOT_AGE_HOURS: z.coerce.number().int().positive().default(24),
    SNAPSHOT_MIN_AGED_DRAWINGS: z.coerce.number().int().positive().default(50),
    ADMIN_SECRET: z.string().min(1).optional()
  })
  .superRefine((config, ctx) => {
    for (const key of ["AWS_S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const) {
      if (!config[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is required when SNAPSHOT_STORE_MODE=s3`,
          path: [key]
        });
      }
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
