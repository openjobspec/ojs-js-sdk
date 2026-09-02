import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PQCOnlyAttestor, SignatureAlgorithm } from '../src/attest/index.js';
import {
  __resetCryptoRuntimeForTests,
  __setCryptoRuntimeForTests,
  getWebCrypto,
} from '../src/crypto.js';
import { DurableContext } from '../src/durable.js';
import { EncryptionCodec, StaticKeyProvider } from '../src/encryption.js';
import { OJSNotFoundError } from '../src/errors.js';
import { generateUuidV4 } from '../src/uuid.js';
import type { Transport, TransportRequestOptions, TransportResponse } from '../src/transport/types.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface StubWebCrypto {
  crypto: {
    getRandomValues: <T extends ArrayBufferView>(array: T) => T;
    subtle: {
      digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>;
      importKey: (
        format: string,
        keyData: BufferSource | JsonWebKey,
        algorithm: AlgorithmIdentifier,
        extractable: boolean,
        keyUsages: readonly KeyUsage[],
      ) => Promise<CryptoKey>;
      encrypt: (algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => Promise<ArrayBuffer>;
      decrypt: (algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => Promise<ArrayBuffer>;
      sign: (algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => Promise<ArrayBuffer>;
    };
  };
}

function makeCompleteWebCryptoStub(): StubWebCrypto {
  const subtle = {
    digest: vi.fn(async (_algorithm: AlgorithmIdentifier, _data: BufferSource) => new ArrayBuffer(32)),
    importKey: vi.fn(async () => ({}) as CryptoKey),
    encrypt: vi.fn(async (_algorithm: AlgorithmIdentifier, _key: CryptoKey, _data: BufferSource) => new ArrayBuffer(16)),
    decrypt: vi.fn(async (_algorithm: AlgorithmIdentifier, _key: CryptoKey, _data: BufferSource) => new ArrayBuffer(16)),
    sign: vi.fn(async (_algorithm: AlgorithmIdentifier, _key: CryptoKey, _data: BufferSource) => new ArrayBuffer(32)),
  };

  return {
    crypto: {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => array,
      subtle,
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockTransport(checkpointState?: unknown): Transport {
  return {
    async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
      if (options.method === 'GET' && options.path.startsWith('/jobs/')) {
        if (checkpointState === undefined) {
          throw new OJSNotFoundError('checkpoint', 'unknown');
        }
        return {
          body: {
            job_id: 'job-id',
            state: checkpointState,
            sequence: 1,
            created_at: new Date().toISOString(),
          } as T,
          status: 200,
          headers: {},
        };
      }
      if (options.method === 'GET' && options.path.startsWith('/checkpoints/')) {
        throw new OJSNotFoundError('checkpoint', 'unknown');
      }

      return { body: {} as T, status: 200, headers: {} };
    },
  };
}

function makeAttestInput() {
  return {
    jobId: 'job-1',
    jobType: 'ml.train',
    argsHash: 'sha256:abc123',
    resultHash: 'sha256:def456',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function runImportSmoke(moduleType: 'esm' | 'cjs'): string {
  const tempDir = mkdtempSync(join(PACKAGE_ROOT, '.crypto-smoke-'));

  try {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ type: moduleType === 'esm' ? 'module' : 'commonjs' }, null, 2),
    );

    for (const relativePath of ['src/crypto.ts', 'src/uuid.ts']) {
      const source = readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8');
      const output = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: moduleType === 'esm' ? ts.ModuleKind.ES2022 : ts.ModuleKind.CommonJS,
          esModuleInterop: true,
        },
      }).outputText;

      const targetPath = join(tempDir, relativePath.replace(/\.ts$/, '.js'));
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, output);
    }

    const runnerPath = join(tempDir, moduleType === 'esm' ? 'runner.mjs' : 'runner.cjs');
    const runner = moduleType === 'esm'
      ? `
import assert from 'node:assert/strict';
Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
const { getWebCrypto } = await import('./src/crypto.js');
const { generateUuidV4 } = await import('./src/uuid.js');
const webCrypto = await getWebCrypto();
assert.equal(typeof webCrypto.subtle.digest, 'function');
assert.match(generateUuidV4(), new RegExp(${JSON.stringify(UUID_V4_RE.source)}, 'i'));
console.log('ok');
`
      : `
const assert = require('node:assert/strict');
Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
const { getWebCrypto } = require('./src/crypto.js');
const { generateUuidV4 } = require('./src/uuid.js');
(async () => {
  const webCrypto = await getWebCrypto();
  assert.equal(typeof webCrypto.subtle.digest, 'function');
  assert.match(generateUuidV4(), new RegExp(${JSON.stringify(UUID_V4_RE.source)}, 'i'));
  console.log('ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    writeFileSync(runnerPath, runner);

    return execFileSync(process.execPath, [runnerPath], {
      cwd: tempDir,
      encoding: 'utf8',
    }).trim();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe.sequential('private crypto runtime', () => {
  afterEach(() => {
    __resetCryptoRuntimeForTests();
    vi.restoreAllMocks();
  });

  it('uses complete ambient crypto without attempting the Node fallback', async () => {
    const ambient = makeCompleteWebCryptoStub();
    const importer = vi.fn(async () => ({ webcrypto: makeCompleteWebCryptoStub().crypto }));

    __setCryptoRuntimeForTests({
      ambientCrypto: () => ambient.crypto,
      nodeCryptoImporter: importer,
    });

    await expect(getWebCrypto()).resolves.toBe(ambient.crypto);
    await expect(getWebCrypto()).resolves.toBe(ambient.crypto);
    expect(importer).not.toHaveBeenCalled();
  });

  it('falls back to node:crypto.webcrypto when ambient crypto is absent', async () => {
    const fallback = makeCompleteWebCryptoStub();
    const importer = vi.fn(async () => ({ webcrypto: fallback.crypto }));

    __setCryptoRuntimeForTests({
      ambientCrypto: () => undefined,
      nodeCryptoImporter: importer,
    });

    await expect(getWebCrypto()).resolves.toBe(fallback.crypto);
    await expect(getWebCrypto()).resolves.toBe(fallback.crypto);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('falls back when ambient crypto is only partially implemented', async () => {
    const fallback = makeCompleteWebCryptoStub();
    const importer = vi.fn(async () => ({ webcrypto: fallback.crypto }));

    __setCryptoRuntimeForTests({
      ambientCrypto: () => ({
        getRandomValues: <T extends ArrayBufferView>(array: T): T => array,
        subtle: {
          digest: async (_algorithm: AlgorithmIdentifier, _data: BufferSource) => new ArrayBuffer(32),
        },
      }),
      nodeCryptoImporter: importer,
    });

    await expect(getWebCrypto()).resolves.toBe(fallback.crypto);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent fallback loads and caches the resolved provider', async () => {
    const fallback = makeCompleteWebCryptoStub();
    const pendingImport = deferred<{ webcrypto: StubWebCrypto['crypto'] }>();
    const importer = vi.fn(() => pendingImport.promise);

    __setCryptoRuntimeForTests({
      ambientCrypto: () => undefined,
      nodeCryptoImporter: importer,
    });

    const first = getWebCrypto();
    const second = getWebCrypto();
    const third = getWebCrypto();

    expect(importer).toHaveBeenCalledTimes(1);

    pendingImport.resolve({ webcrypto: fallback.crypto });

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      fallback.crypto,
      fallback.crypto,
      fallback.crypto,
    ]);
    await expect(getWebCrypto()).resolves.toBe(fallback.crypto);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('clears a failed fallback cache so later calls can retry safely', async () => {
    const fallback = makeCompleteWebCryptoStub();
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ webcrypto: fallback.crypto });

    __setCryptoRuntimeForTests({
      ambientCrypto: () => undefined,
      nodeCryptoImporter: importer,
    });

    await expect(getWebCrypto()).rejects.toThrow('Web Crypto API is unavailable in this runtime');
    await expect(getWebCrypto()).resolves.toBe(fallback.crypto);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('provides deterministic private seams for UUID and durable randomness', async () => {
    const byteSequences = [
      Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]),
      Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    ];

    __setCryptoRuntimeForTests({
      randomBytes: (byteLength: number): Uint8Array => {
        const next = byteSequences.shift();
        if (!next) {
          throw new Error('unexpected randomBytes() call');
        }
        expect(next.length).toBe(byteLength);
        return next;
      },
    });

    expect(generateUuidV4()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');

    const durable = await DurableContext.create(createMockTransport(), 'job-1', 1);
    expect(durable.random(4)).toBe('deadbeef');
  });

  it('lets AES-GCM use deterministic nonce bytes from the private seam', async () => {
    const nonce = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    __setCryptoRuntimeForTests({
      ambientCrypto: () => undefined,
      nodeCryptoImporter: async () => import('node:crypto'),
      randomBytes: (byteLength: number): Uint8Array => {
        expect(byteLength).toBe(12);
        return nonce.slice();
      },
    });

    const key = Uint8Array.from(Array.from({ length: 32 }, (_unused, index) => index));
    const provider = new StaticKeyProvider(new Map([['key-1', key]]), 'key-1');
    const codec = new EncryptionCodec(provider);

    const result = await codec.encrypt(new TextEncoder().encode('secret payload'));
    expect(result.nonce).toEqual(nonce);
  });

  it('keeps encryption and attestation working via the Node fallback with no ambient crypto', async () => {
    const importer = vi.fn(async () => import('node:crypto'));

    __setCryptoRuntimeForTests({
      ambientCrypto: () => undefined,
      nodeCryptoImporter: importer,
    });

    const key = Uint8Array.from(Array.from({ length: 32 }, (_unused, index) => index + 1));
    const provider = new StaticKeyProvider(new Map([['key-1', key]]), 'key-1');
    const codec = new EncryptionCodec(provider);

    const plaintext = new TextEncoder().encode('secret payload');
    const { ciphertext, nonce, keyId } = await codec.encrypt(plaintext);
    const decrypted = await codec.decrypt(ciphertext, nonce, keyId);
    expect(new TextDecoder().decode(decrypted)).toBe('secret payload');

    const attestor = new PQCOnlyAttestor(new Uint8Array(32).fill(7), 'key-1');
    const attested = await attestor.attest(makeAttestInput());
    expect(attested.signature.algorithm).toBe(SignatureAlgorithm.HmacSha256);
    await expect(attestor.verify({
      jobId: 'job-1',
      quote: attested.quote,
      signature: attested.signature,
      issuedAt: makeAttestInput().timestamp,
    })).resolves.toBeUndefined();

    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('falls back to the real Node provider when ambient crypto is browser-like but incomplete', async () => {
    const importer = vi.fn(async () => import('node:crypto'));

    __setCryptoRuntimeForTests({
      ambientCrypto: () => ({
        getRandomValues: <T extends ArrayBufferView>(array: T): T => array,
        subtle: {
          digest: async (_algorithm: AlgorithmIdentifier, _data: BufferSource) => new ArrayBuffer(32),
        },
      }),
      nodeCryptoImporter: importer,
    });

    const attestor = new PQCOnlyAttestor(new Uint8Array(32).fill(9), 'key-2');
    const attested = await attestor.attest(makeAttestInput());
    expect(attested.quote?.evidence).toHaveLength(32);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('supports clean ESM import and fallback execution with no ambient crypto', () => {
    expect(runImportSmoke('esm')).toBe('ok');
  });

  it('supports clean CJS import and fallback execution with no ambient crypto', () => {
    expect(runImportSmoke('cjs')).toBe('ok');
  });
});
