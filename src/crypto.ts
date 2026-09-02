/**
 * Private cross-runtime crypto runtime for the SDK's internal UUID,
 * encryption, attestation, and durable-execution needs.
 *
 * Synchronous random bytes come from `@noble/hashes/utils` so Node 18 uses
 * Node's built-in `crypto` without relying on a `globalThis.crypto` global,
 * while browsers continue to use ambient Web Crypto.
 *
 * Asynchronous Web Crypto (`subtle`) is resolved lazily: use ambient
 * `globalThis.crypto` only when it is complete for the SDK's needs;
 * otherwise, in Node-compatible runtimes, fall back to `node:crypto`'s
 * `webcrypto` export without touching it at module-import time.
 *
 * This module is intentionally private: it is imported directly by internal
 * modules and tests, but is not re-exported from the package surface.
 */

import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils';

interface SDKSubtleCrypto {
  digest(algorithm: unknown, data: BufferSource): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: BufferSource | JsonWebKey,
    algorithm: unknown,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKey>;
  encrypt(algorithm: unknown, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  decrypt(algorithm: unknown, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  sign(algorithm: unknown, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
}

interface SDKWebCrypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  subtle: SDKSubtleCrypto;
}

interface NodeCryptoModule {
  webcrypto?: unknown;
}

interface CryptoRuntimeOverrides {
  ambientCrypto?: (() => unknown) | undefined;
  nodeCryptoImporter?: (() => Promise<NodeCryptoModule>) | undefined;
  randomBytes?: ((byteLength: number) => Uint8Array) | undefined;
}

const defaultAmbientCrypto = (): unknown => (globalThis as { crypto?: unknown }).crypto;

const NODE_CRYPTO_SPECIFIER = 'node:crypto';

const defaultNodeCryptoImporter = (): Promise<NodeCryptoModule> =>
  import(NODE_CRYPTO_SPECIFIER) as Promise<NodeCryptoModule>;

const defaultRandomBytes = (byteLength: number): Uint8Array => nobleRandomBytes(byteLength);

let ambientCrypto = defaultAmbientCrypto;
let nodeCryptoImporter = defaultNodeCryptoImporter;
let randomBytesImpl = defaultRandomBytes;

let cachedFallbackWebCrypto: SDKWebCrypto | undefined;
let pendingFallbackWebCrypto: Promise<SDKWebCrypto> | undefined;
let fallbackCacheEpoch = 0;

function invalidateFallbackCache(): void {
  fallbackCacheEpoch += 1;
  cachedFallbackWebCrypto = undefined;
  pendingFallbackWebCrypto = undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasFunction(value: unknown, key: string): boolean {
  return isObjectRecord(value) && typeof value[key] === 'function';
}

function asCompleteWebCrypto(value: unknown): SDKWebCrypto | undefined {
  if (!hasFunction(value, 'getRandomValues')) {
    return undefined;
  }

  const subtle = isObjectRecord(value) ? value.subtle : undefined;
  if (
    !hasFunction(subtle, 'digest') ||
    !hasFunction(subtle, 'importKey') ||
    !hasFunction(subtle, 'encrypt') ||
    !hasFunction(subtle, 'decrypt') ||
    !hasFunction(subtle, 'sign')
  ) {
    return undefined;
  }

  return value as SDKWebCrypto;
}

function assertByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError(`byteLength must be a non-negative safe integer (got ${byteLength})`);
  }
}

function validateRandomBytes(bytes: Uint8Array, expectedLength: number): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Crypto runtime randomBytes() must return a Uint8Array');
  }
  if (bytes.length !== expectedLength) {
    throw new Error(
      `Crypto runtime randomBytes() must return ${expectedLength} byte(s) (got ${bytes.length})`,
    );
  }
  return bytes;
}

function wrapUnavailableWebCryptoError(cause: unknown): Error {
  if (cause instanceof Error) {
    return new Error(
      'Web Crypto API is unavailable in this runtime and node:crypto.webcrypto could not be loaded.',
      { cause },
    );
  }

  return new Error(
    'Web Crypto API is unavailable in this runtime and node:crypto.webcrypto could not be loaded.',
  );
}

/**
 * Return cryptographically secure random bytes synchronously.
 *
 * Internally delegated to `@noble/hashes/utils` so Node 18 can use a
 * maintained Node-specific fallback while browsers continue to use
 * ambient Web Crypto.
 */
export function getRandomBytes(byteLength: number): Uint8Array {
  assertByteLength(byteLength);
  return validateRandomBytes(randomBytesImpl(byteLength), byteLength);
}

/**
 * Resolve a complete Web Crypto implementation for AES-GCM and SHA/HMAC.
 *
 * Ambient `globalThis.crypto` wins when complete; otherwise a lazy,
 * concurrency-safe Node fallback is used.
 */
export async function getWebCrypto(): Promise<SDKWebCrypto> {
  const ambient = asCompleteWebCrypto(ambientCrypto());
  if (ambient) {
    return ambient;
  }

  if (cachedFallbackWebCrypto) {
    return cachedFallbackWebCrypto;
  }

  if (pendingFallbackWebCrypto) {
    return pendingFallbackWebCrypto;
  }

  const epoch = fallbackCacheEpoch;
  const pending = (async (): Promise<SDKWebCrypto> => {
    try {
      const imported = await nodeCryptoImporter();
      const fallback = asCompleteWebCrypto(imported.webcrypto);
      if (!fallback) {
        throw new Error('node:crypto.webcrypto is unavailable or incomplete');
      }

      if (fallbackCacheEpoch === epoch) {
        cachedFallbackWebCrypto = fallback;
      }

      return fallback;
    } catch (error) {
      throw wrapUnavailableWebCryptoError(error);
    } finally {
      if (fallbackCacheEpoch === epoch) {
        pendingFallbackWebCrypto = undefined;
      }
    }
  })();

  pendingFallbackWebCrypto = pending;
  return pending;
}

/**
 * Override the private crypto runtime for deterministic tests.
 * @internal
 */
export function __setCryptoRuntimeForTests(overrides: CryptoRuntimeOverrides): void {
  if (overrides.ambientCrypto !== undefined) {
    ambientCrypto = overrides.ambientCrypto;
  }
  if (overrides.nodeCryptoImporter !== undefined) {
    nodeCryptoImporter = overrides.nodeCryptoImporter;
  }
  if (overrides.randomBytes !== undefined) {
    randomBytesImpl = overrides.randomBytes;
  }
  invalidateFallbackCache();
}

/**
 * Restore the default private crypto runtime after tests.
 * @internal
 */
export function __resetCryptoRuntimeForTests(): void {
  ambientCrypto = defaultAmbientCrypto;
  nodeCryptoImporter = defaultNodeCryptoImporter;
  randomBytesImpl = defaultRandomBytes;
  invalidateFallbackCache();
}
