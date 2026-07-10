// S3-compatible object storage (MinIO in dev, S3 in prod). Stores immutable skill
// artifact bundles (tar.gz). SKILLY_SPEC.md §2, §6.
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export interface ArtifactStore {
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
}

const BUCKET = process.env.S3_BUCKET ?? "skilly-artifacts";

export function s3ArtifactStore(): ArtifactStore {
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true, // required for MinIO
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.S3_SECRET_KEY ?? "",
    },
  });

  return {
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      const bytes = await out.Body!.transformToByteArray();
      return Buffer.from(bytes);
    },
    async put(key, body, contentType = "application/gzip") {
      await client.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }),
      );
    },
  };
}
