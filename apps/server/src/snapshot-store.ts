import { GetObjectCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { CubeFaceName } from "@globe2/shared";
import type { AppConfig } from "./config";

export interface SnapshotFaceStore {
  writeFace(snapshotId: string, face: CubeFaceName, data: Buffer): Promise<string>;
  readFaceBuffer(url: string): Promise<Buffer | null>;
}

class S3SnapshotStore implements SnapshotFaceStore {
  private readonly client: S3Client;
  private readonly publicBaseUrl: string;

  constructor(
    private readonly bucket: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
  ) {
    this.client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    this.publicBaseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;
  }

  async writeFace(snapshotId: string, face: CubeFaceName, data: Buffer): Promise<string> {
    const key = `${snapshotId}/${face}.png`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: "image/png",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    return `${this.publicBaseUrl}/${key}`;
  }

  async readFaceBuffer(url: string): Promise<Buffer | null> {
    const key = this.keyFromPublicUrl(url);
    if (!key) {
      return null;
    }

    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return object.Body ? Buffer.from(await object.Body.transformToByteArray()) : null;
    } catch {
      return null;
    }
  }

  private keyFromPublicUrl(url: string): string | null {
    if (url.startsWith("/snapshots/blank-v2/")) {
      return null;
    }

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.origin !== this.publicBaseUrl) {
        return null;
      }
      return decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ""));
    } catch {
      return null;
    }
  }
}

export function createSnapshotStore(config: AppConfig): SnapshotFaceStore {
  if (!config.AWS_S3_BUCKET || !config.AWS_ACCESS_KEY_ID || !config.AWS_SECRET_ACCESS_KEY) {
    throw new Error("S3 snapshot store requires AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY");
  }
  return new S3SnapshotStore(
    config.AWS_S3_BUCKET,
    config.AWS_REGION,
    config.AWS_ACCESS_KEY_ID,
    config.AWS_SECRET_ACCESS_KEY,
  );
}
