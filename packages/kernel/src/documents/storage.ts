/**
 * Cloudflare R2 — the object store bytes actually live in.
 *
 * R2 is S3-compatible, so this is a thin wrapper around `@aws-sdk/client-s3`
 * pointed at R2's S3-compatible endpoint (see docs/04-infrastructure.md). The
 * browser uploads and downloads DIRECTLY against R2 through a short-lived
 * presigned URL this module issues — the Fastify API never proxies file
 * bytes through its own JSON request/response cycle. That is the whole
 * design: this file mints URLs, `documents/service.ts` never touches a byte.
 *
 * **Configuration is optional at the process level, not at the call site.**
 * A tenant that has never uploaded a document, and this sandboxed dev/test
 * environment specifically, must be able to run every OTHER kernel function
 * — create a folder, list documents, link one to an entity, lock and unlock
 * — with zero R2 environment variables set. Only the three functions here
 * that genuinely need to reach R2 are allowed to fail, and they fail with a
 * specific, named error rather than a stack trace from inside the AWS SDK.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const UPLOAD_EXPIRY_SECONDS = 15 * 60;
const DOWNLOAD_EXPIRY_SECONDS = 5 * 60;

export class StorageNotConfiguredError extends Error {
  override readonly name = 'StorageNotConfiguredError';
}

interface R2Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Reads the required env vars, or throws naming whichever is missing.
 *
 * Names match `.env.example`'s existing `S3_*` convention (this project's
 * own — R2 is only ever referred to as "the S3-compatible store", never
 * assumed to be the sole provider), not an R2-specific one: `S3_ENDPOINT` is
 * already the full endpoint URL, not an account id to build one from.
 *
 * Checked every call rather than cached at module load: this file is
 * imported by every kernel consumer whether or not they ever touch a
 * document, so a missing var must not throw at import time — only when a
 * caller actually tries to reach the store.
 */
function requireConfig(): R2Config {
  const endpoint = process.env.S3_ENDPOINT;
  if (!endpoint) throw new StorageNotConfiguredError('S3_ENDPOINT is not set.');

  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  if (!accessKeyId) throw new StorageNotConfiguredError('S3_ACCESS_KEY_ID is not set.');

  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!secretAccessKey) throw new StorageNotConfiguredError('S3_SECRET_ACCESS_KEY is not set.');

  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new StorageNotConfiguredError('S3_BUCKET is not set.');

  return { endpoint, region: process.env.S3_REGION ?? 'auto', accessKeyId, secretAccessKey, bucket };
}

function client(config: R2Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * A presigned PUT URL the browser uploads straight to, bypassing the API.
 *
 * ~15 minutes: long enough for a slow connection to push a large drawing set,
 * short enough that a leaked URL is not a standing hole.
 */
export async function presignUploadUrl(key: string, contentType: string): Promise<string> {
  const config = requireConfig();
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client(config), command, { expiresIn: UPLOAD_EXPIRY_SECONDS });
}

/**
 * A presigned GET URL the browser downloads straight from, bypassing the API.
 *
 * Sets `response-content-disposition` so the browser saves the file under its
 * original name rather than the opaque storage key — R2 does not otherwise
 * know what the object was called. ~5 minutes: a download link is clicked
 * immediately or not at all.
 */
export async function presignDownloadUrl(key: string, fileName: string): Promise<string> {
  const config = requireConfig();
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${fileName.replace(/"/g, '')}"`,
  });
  return getSignedUrl(client(config), command, { expiresIn: DOWNLOAD_EXPIRY_SECONDS });
}

/** Removes an object outright — used when a version or document is purged. */
export async function deleteObject(key: string): Promise<void> {
  const config = requireConfig();
  await client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}
