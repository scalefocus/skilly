// S3-compatible object storage (web side). Stores uploaded skill bundles. Mirrors the
// worker's store so both read/write the same bucket. SKILLY_SPEC.md §2, §6.
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const BUCKET = process.env.S3_BUCKET ?? "skilly-artifacts";

export interface ObjectListing {
  key: string;
  lastModified: Date | null;
}

export interface ArtifactStore {
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** Delete one object; missing keys are a no-op (S3 semantics). */
  delete(key: string): Promise<void>;
  /** List every object under a key prefix (paginated internally). Used only by the
   *  chunked-upload staging sweep (§6) — the staging prefix stays small by construction. */
  list(prefix: string): Promise<ObjectListing[]>;
}

export function s3ArtifactStore(): ArtifactStore {
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    // Fail fast when object storage is unreachable (e.g. the endpoint host can't be resolved):
    // the default 3 attempts with backoff turned a dead endpoint into a ~15s hang. 2 attempts
    // surfaces the error quickly so the route can return a clear "storage unavailable" message.
    maxAttempts: 2,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.S3_SECRET_KEY ?? "",
    },
  });
  return {
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    },
    async put(key, body, contentType = "application/gzip") {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    },
    async list(prefix) {
      const out: ObjectListing[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
        for (const o of page.Contents ?? []) {
          if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified ?? null });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
  };
}
