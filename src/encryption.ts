/**
 * Client-side encryption middleware for OJS job args.
 *
 * Encrypts job arguments before enqueue and decrypts them in the worker,
 * ensuring sensitive data is never stored in plaintext in the backend.
 *
 * Uses AES-256-GCM via the Web Crypto API (Node.js 18+ and browsers).
 *
 * @example
 * ```ts
 * import { OJSClient, OJSWorker } from '@openjobspec/sdk';
 * import {
 *   StaticKeyProvider,
 *   EncryptionCodec,
 *   encryptionMiddleware,
 *   decryptionMiddleware,
 * } from '@openjobspec/sdk/encryption';
 *
 * const keys = new Map([['key-1', crypto.getRandomValues(new Uint8Array(32))]]);
 * const provider = new StaticKeyProvider(keys, 'key-1');
 * const codec = new EncryptionCodec(provider);
 *
 * // Client side
 * const client = new OJSClient({ url: 'http://localhost:8080' });
 * client.enqueueMiddleware.add('encryption', encryptionMiddleware(codec));
 *
 * // Worker side
 * const worker = new OJSWorker({ url: 'http://localhost:8080', queues: ['default'] });
 * worker.executionMiddleware.add('decryption', decryptionMiddleware(codec));
 * ```
 */

import type { Job, JsonValue } from './job.js';
import type { EnqueueMiddleware, ExecutionMiddleware, JobContext, NextFunction } from './middleware.js';

// ---- Meta Keys (OJS codec spec) ----

/** Meta key for the list of applied encodings (e.g. `["binary/encrypted"]`). */
export const META_ENCODINGS = 'ojs.codec.encodings';
/** Meta key recording which key ID was used (for rotation). */
export const META_KEY_ID = 'ojs.codec.key_id';
/** Meta key storing the base64-encoded nonce. */
export const META_NONCE = 'ojs.codec.nonce';

/** The encoding value indicating AES-256-GCM encryption. */
export const ENCODING_ENCRYPTED = 'binary/encrypted';

// Legacy meta keys (pre-spec) — checked during decryption for backward compat.
const LEGACY_META_ENCRYPTED = 'ojs.encryption.encrypted';
const LEGACY_META_KEY_ID = 'ojs.encryption.key_id';
const LEGACY_META_NONCE = 'ojs.encryption.nonce';

// ---- Key Provider ----

/** Supplies encryption keys. Implement this for KMS or vault integration. */
export interface KeyProvider {
  /** Retrieve a key by its identifier. */
  getKey(keyId: string): Promise<Uint8Array>;
  /** Return the identifier of the key to use for new encryptions. */
  getCurrentKeyId(): string;
}

/**
 * A key provider backed by an in-memory map of keys.
 * Suitable for testing and simple deployments. For production, consider
 * implementing {@link KeyProvider} against a KMS.
 */
export class StaticKeyProvider implements KeyProvider {
  private readonly keys: Map<string, Uint8Array>;
  private readonly currentKeyId: string;

  constructor(keys: Map<string, Uint8Array>, currentKeyId: string) {
    if (!keys.has(currentKeyId)) {
      throw new Error(`Current key ID '${currentKeyId}' not found in provided keys`);
    }
    const currentKey = keys.get(currentKeyId)!;
    if (currentKey.length !== 32) {
      throw new Error(`Key must be 32 bytes for AES-256 (got ${currentKey.length})`);
    }
    this.keys = new Map(keys);
    this.currentKeyId = currentKeyId;
  }

  getKey(keyId: string): Promise<Uint8Array> {
    const key = this.keys.get(keyId);
    if (!key) {
      return Promise.reject(new Error(`Unknown key ID: ${keyId}`));
    }
    return Promise.resolve(key);
  }

  getCurrentKeyId(): string {
    return this.currentKeyId;
  }
}

// ---- Base64 helpers (Node.js & browser) ----

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(encoded, 'base64'));
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---- Encryption Codec ----

/** Result of an encryption operation. */
export interface EncryptResult {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyId: string;
}

/**
 * AES-256-GCM encryption codec using the Web Crypto API.
 *
 * The codec is stateless — all key material comes from the {@link KeyProvider}.
 */
export class EncryptionCodec {
  private readonly keyProvider: KeyProvider;

  constructor(keyProvider: KeyProvider) {
    this.keyProvider = keyProvider;
  }

  /** Encrypt data using the current key. */
  async encrypt(data: Uint8Array): Promise<EncryptResult> {
    const keyId = this.keyProvider.getCurrentKeyId();
    const rawKey = await this.keyProvider.getKey(keyId);

    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt'],
    );

    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));

    const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      cryptoKey,
      data,
    );

    return {
      ciphertext: new Uint8Array(ciphertextBuffer),
      nonce,
      keyId,
    };
  }

  /** Decrypt ciphertext using the key identified by keyId. */
  async decrypt(ciphertext: Uint8Array, nonce: Uint8Array, keyId: string): Promise<Uint8Array> {
    const rawKey = await this.keyProvider.getKey(keyId);

    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );

    const plaintextBuffer = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      cryptoKey,
      ciphertext,
    );

    return new Uint8Array(plaintextBuffer);
  }
}

// ---- Middleware ----

/**
 * Enqueue middleware that encrypts job args before sending to the server.
 *
 * Serialises `args` as JSON, encrypts via AES-256-GCM, and stores the
 * base64-encoded ciphertext as the sole arg. Encryption metadata is
 * attached to `meta` so the worker can decrypt transparently.
 */
export function encryptionMiddleware(codec: EncryptionCodec): EnqueueMiddleware {
  return async (job: Job, next: (job: Job) => Promise<Job | null>): Promise<Job | null> => {
    const plaintext = new TextEncoder().encode(JSON.stringify(job.args));
    const { ciphertext, nonce, keyId } = await codec.encrypt(plaintext);

    const encryptedJob: Job = {
      ...job,
      args: [toBase64(ciphertext)],
      meta: {
        ...job.meta,
        [META_ENCODINGS]: [ENCODING_ENCRYPTED],
        [META_KEY_ID]: keyId,
        [META_NONCE]: toBase64(nonce),
      },
    };

    return next(encryptedJob);
  };
}

/**
 * Execution middleware that decrypts job args before the handler runs.
 *
 * Checks for `ojs.codec.encodings` containing `"binary/encrypted"`. If
 * present, decodes and decrypts the args, replacing them with the original
 * plaintext values. Also supports legacy `ojs.encryption.*` keys for
 * backward compatibility. Unencrypted jobs pass through unchanged.
 */
export function decryptionMiddleware(codec: EncryptionCodec): ExecutionMiddleware {
  return async (ctx: JobContext, next: NextFunction): Promise<unknown> => {
    const meta = ctx.job.meta;
    if (!meta) return next();

    // Detect encryption via new spec keys or legacy keys.
    const encodings = meta[META_ENCODINGS];
    const isEncrypted =
      (Array.isArray(encodings) && encodings.includes(ENCODING_ENCRYPTED)) ||
      meta[LEGACY_META_ENCRYPTED] === true;

    if (!isEncrypted) {
      return next();
    }

    const keyId = (meta[META_KEY_ID] ?? meta[LEGACY_META_KEY_ID]) as string | undefined;
    const nonceB64 = (meta[META_NONCE] ?? meta[LEGACY_META_NONCE]) as string | undefined;

    if (typeof keyId !== 'string' || typeof nonceB64 !== 'string') {
      throw new Error('Encrypted job is missing required meta: key_id or nonce');
    }

    if (ctx.job.args.length === 0 || typeof ctx.job.args[0] !== 'string') {
      return next();
    }

    const ciphertext = fromBase64(ctx.job.args[0] as string);
    const nonce = fromBase64(nonceB64);
    const plaintext = await codec.decrypt(ciphertext, nonce, keyId);

    const decoded: JsonValue[] = JSON.parse(new TextDecoder().decode(plaintext));
    ctx.job.args = decoded;

    return next();
  };
}
