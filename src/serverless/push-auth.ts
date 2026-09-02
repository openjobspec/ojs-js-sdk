/**
 * Private, cross-runtime authentication helpers for OJS HTTP push delivery.
 *
 * The exact request bytes are authenticated before JSON decoding or handler
 * dispatch. This module deliberately avoids Node-only APIs because it is used
 * by Cloudflare Workers and Vercel Edge Functions as well as AWS Lambda.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import {
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from '@noble/hashes/utils';

/** Shared, additive authentication options for every HTTP push adapter. */
export interface PushAuthOptions {
  /** Primary HMAC signing secret. */
  signingSecret?: string | undefined;
  /** Additional accepted secrets for zero-downtime key rotation. */
  signingSecrets?: string[] | undefined;
  /** Maximum permitted past or future timestamp skew. Default: 300 seconds. */
  freshnessSeconds?: number | undefined;
  /** Maximum raw HTTP body size. Default: 10 MiB. */
  maxBodyBytes?: number | undefined;
  /**
   * Disable signature verification explicitly.
   *
   * This also enables the legacy bare-Job request body for migration. Never
   * enable it on a publicly reachable production endpoint.
   */
  allowInsecurePush?: boolean | undefined;
}

type PushAuthFailure = { ok: false; status: number; error: string };

export type PushAuthResult = { ok: true } | PushAuthFailure;

export type PushBodyReadResult =
  | { ok: true; rawBody: Uint8Array }
  | PushAuthFailure;

const DEFAULT_FRESHNESS_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_TIMESTAMP_HEADER_BYTES = 32;
const MAX_SIGNATURE_HEADER_BYTES = 8 * 1024;
const MAX_SIGNATURES = 32;
const SHA256_BYTES = 32;
const SIGNATURE_PREFIX = 'sha256=';
const encoder = new TextEncoder();

function invalidConfiguration(message: string): PushAuthFailure {
  return {
    ok: false,
    status: 500,
    error: `Invalid push authentication configuration: ${message}`,
  };
}

function resolvePositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number | PushAuthFailure {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    return invalidConfiguration(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function resolveSecrets(options: PushAuthOptions): string[] | PushAuthFailure {
  const candidates: unknown[] = [
    options.signingSecret,
    ...(Array.isArray(options.signingSecrets) ? options.signingSecrets : []),
  ];

  if (
    options.signingSecrets !== undefined &&
    !Array.isArray(options.signingSecrets)
  ) {
    return invalidConfiguration('signingSecrets must be an array');
  }

  const secrets: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue;
    if (typeof candidate !== 'string') {
      return invalidConfiguration('signing secrets must be strings');
    }
    secrets.push(candidate);
  }
  return secrets;
}

function parseTimestamp(value: string | null | undefined):
  | { ok: true; seconds: number }
  | PushAuthFailure {
  if (!value) {
    return { ok: false, status: 401, error: 'Missing X-OJS-Timestamp header' };
  }
  if (encoder.encode(value).byteLength > MAX_TIMESTAMP_HEADER_BYTES) {
    return { ok: false, status: 400, error: 'X-OJS-Timestamp header is too large' };
  }
  if (!/^[0-9]+$/.test(value)) {
    return { ok: false, status: 401, error: 'Invalid X-OJS-Timestamp header' };
  }

  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    return { ok: false, status: 401, error: 'Invalid X-OJS-Timestamp header' };
  }
  return { ok: true, seconds };
}

function parseSignatures(value: string | null | undefined):
  | { ok: true; signatures: Uint8Array[] }
  | PushAuthFailure {
  if (!value) {
    return { ok: false, status: 401, error: 'Missing X-OJS-Signature header' };
  }
  if (encoder.encode(value).byteLength > MAX_SIGNATURE_HEADER_BYTES) {
    return { ok: false, status: 400, error: 'X-OJS-Signature header is too large' };
  }

  const parts = value.split(',');
  if (parts.length === 0 || parts.length > MAX_SIGNATURES) {
    return { ok: false, status: 400, error: 'Too many signature candidates' };
  }

  const signatures: Uint8Array[] = [];
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (
      part.length !== SIGNATURE_PREFIX.length + SHA256_BYTES * 2 ||
      !part.startsWith(SIGNATURE_PREFIX)
    ) {
      return { ok: false, status: 401, error: 'Invalid X-OJS-Signature header' };
    }

    try {
      const signature = hexToBytes(part.slice(SIGNATURE_PREFIX.length));
      if (signature.length !== SHA256_BYTES) {
        return { ok: false, status: 401, error: 'Invalid X-OJS-Signature header' };
      }
      signatures.push(signature);
    } catch {
      return { ok: false, status: 401, error: 'Invalid X-OJS-Signature header' };
    }
  }
  return { ok: true, signatures };
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function asBytes(rawBody: string | Uint8Array): Uint8Array {
  return typeof rawBody === 'string' ? utf8ToBytes(rawBody) : rawBody;
}

/** Resolve and validate the configured raw-body limit. */
export function resolveMaxBodyBytes(
  options: PushAuthOptions,
): number | PushAuthFailure {
  return resolvePositiveInteger(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
    'maxBodyBytes',
  );
}

/**
 * Read a Fetch API request without ever buffering more than maxBodyBytes.
 */
export async function readBoundedRequestBody(
  request: Request,
  options: PushAuthOptions,
): Promise<PushBodyReadResult> {
  const resolvedLimit = resolveMaxBodyBytes(options);
  if (typeof resolvedLimit !== 'number') return resolvedLimit;

  const contentLength = request.headers.get('content-length');
  if (contentLength && /^[0-9]+$/.test(contentLength)) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > resolvedLimit
    ) {
      return { ok: false, status: 413, error: 'Request body too large' };
    }
  }

  if (!request.body) {
    return { ok: true, rawBody: new Uint8Array() };
  }

  // A body that has already been read (`bodyUsed`) or is currently locked
  // by another reader (`request.body.locked`) cannot be read again: the
  // Streams spec makes `ReadableStream.prototype.getReader()` throw a
  // `TypeError` in both cases. Checked proactively for a precise,
  // specific error message in the common case (a caller/framework that
  // already consumed the body, e.g. via `request.clone()` misuse or a
  // duplicate parse elsewhere in the same handler), but `getReader()`
  // itself is still wrapped below in case some other runtime rejects a
  // `getReader()` call for a reason these two flags do not predict.
  if (request.bodyUsed || request.body.locked) {
    return {
      ok: false,
      status: 400,
      error: 'Request body has already been read or is locked by another reader',
    };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    // getReader() itself failed synchronously (Finding: push-auth body
    // acquisition) -- must never throw out of this function uncaught; a
    // controlled HTTP 400 lets every adapter (Cloudflare, Vercel, Lambda)
    // return a normal structured error response instead of an unhandled
    // rejection/thrown error escaping the handler.
    return { ok: false, status: 400, error: 'Failed to read request body' };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > resolvedLimit) {
        await reader.cancel('OJS push body exceeds configured limit').catch(() => undefined);
        return { ok: false, status: 413, error: 'Request body too large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: 'Failed to read request body' };
  } finally {
    reader.releaseLock();
  }

  // Allocate the final buffer once and copy each chunk in place. Using
  // `concatBytes(...chunks)` here would spread every chunk as a call
  // argument, which risks exceeding the JS engine's call-stack/argument
  // limit when a request arrives as many small fragments (e.g. hundreds of
  // thousands of 1-byte chunks from a slow-loris style stream).
  const rawBody = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    rawBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, rawBody };
}

/**
 * Verify an OJS push signature over timestamp + "." + the exact body bytes.
 */
export function verifyPushSignature(
  rawBody: string | Uint8Array,
  timestampHeader: string | null | undefined,
  signatureHeader: string | null | undefined,
  secrets: string[],
  freshnessSeconds: number = DEFAULT_FRESHNESS_SECONDS,
  maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES,
): PushAuthResult {
  const resolvedFreshness = resolvePositiveInteger(
    freshnessSeconds,
    DEFAULT_FRESHNESS_SECONDS,
    'freshnessSeconds',
  );
  if (typeof resolvedFreshness !== 'number') return resolvedFreshness;

  const resolvedBodyLimit = resolvePositiveInteger(
    maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
    'maxBodyBytes',
  );
  if (typeof resolvedBodyLimit !== 'number') return resolvedBodyLimit;

  const bodyBytes = asBytes(rawBody);
  if (bodyBytes.byteLength > resolvedBodyLimit) {
    return { ok: false, status: 413, error: 'Request body too large' };
  }

  const timestamp = parseTimestamp(timestampHeader);
  if (!timestamp.ok) return timestamp;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp.seconds) > resolvedFreshness) {
    return {
      ok: false,
      status: 401,
      error: 'Request timestamp outside freshness window',
    };
  }

  const parsedSignatures = parseSignatures(signatureHeader);
  if (!parsedSignatures.ok) return parsedSignatures;

  const prefix = utf8ToBytes(`${timestampHeader}.`);
  const signedPayload = concatBytes(prefix, bodyBytes);
  let matched = 0;

  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    const expected = hmac(sha256, utf8ToBytes(secret), signedPayload);
    for (const signature of parsedSignatures.signatures) {
      matched |= constantTimeEqual(expected, signature) ? 1 : 0;
    }
  }

  return matched === 1
    ? { ok: true }
    : { ok: false, status: 401, error: 'Signature verification failed' };
}

/** Apply fail-closed configuration and signature verification. */
export function verifyPushAuth(
  rawBody: string | Uint8Array,
  timestampHeader: string | null | undefined,
  signatureHeader: string | null | undefined,
  options: PushAuthOptions,
): PushAuthResult {
  const resolvedBodyLimit = resolveMaxBodyBytes(options);
  if (typeof resolvedBodyLimit !== 'number') return resolvedBodyLimit;

  const bodyBytes = asBytes(rawBody);
  if (bodyBytes.byteLength > resolvedBodyLimit) {
    return { ok: false, status: 413, error: 'Request body too large' };
  }

  if (options.allowInsecurePush === true) {
    return { ok: true };
  }

  const secrets = resolveSecrets(options);
  if (!Array.isArray(secrets)) return secrets;
  if (secrets.length === 0) {
    return {
      ok: false,
      status: 500,
      error: 'No signing secret configured and allowInsecurePush is not enabled',
    };
  }

  return verifyPushSignature(
    bodyBytes,
    timestampHeader,
    signatureHeader,
    secrets,
    options.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS,
    resolvedBodyLimit,
  );
}
