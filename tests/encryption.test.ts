import { describe, it, expect } from 'vitest';
import {
  StaticKeyProvider,
  EncryptionCodec,
  encryptionMiddleware,
  decryptionMiddleware,
  META_ENCODINGS,
  META_KEY_ID,
  META_NONCE,
  ENCODING_ENCRYPTED,
} from '../src/encryption.js';
import type { Job } from '../src/job.js';
import type { JobContext } from '../src/middleware.js';

function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function makeJob(args: unknown[] = ['hello', 42], meta: Record<string, unknown> = {}): Job {
  return {
    specversion: '1.0',
    id: 'job-1',
    type: 'test.job',
    queue: 'default',
    args,
    meta,
  };
}

function makeContext(job: Job): JobContext {
  return {
    job: { ...job },
    attempt: 1,
    queue: job.queue,
    workerId: 'test-worker',
    metadata: new Map(),
    signal: new AbortController().signal,
  };
}

function providerWithKey(keyId = 'key-1'): { provider: StaticKeyProvider; key: Uint8Array } {
  const key = randomKey();
  const provider = new StaticKeyProvider(new Map([[keyId, key]]), keyId);
  return { provider, key };
}

// ---- StaticKeyProvider ----

describe('StaticKeyProvider', () => {
  it('returns correct key for known ID', async () => {
    const key = randomKey();
    const provider = new StaticKeyProvider(new Map([['k1', key]]), 'k1');
    const retrieved = await provider.getKey('k1');
    expect(retrieved).toEqual(key);
  });

  it('throws for unknown key ID', async () => {
    const { provider } = providerWithKey('k1');
    await expect(provider.getKey('unknown')).rejects.toThrow('Unknown key ID: unknown');
  });

  it('returns currentKeyId', () => {
    const { provider } = providerWithKey('my-key');
    expect(provider.getCurrentKeyId()).toBe('my-key');
  });

  it('throws if currentKeyId is not in the map', () => {
    const key = randomKey();
    expect(() => new StaticKeyProvider(new Map([['a', key]]), 'b')).toThrow(
      "Current key ID 'b' not found",
    );
  });

  it('throws if key is not 32 bytes', () => {
    const shortKey = new Uint8Array(16);
    expect(() => new StaticKeyProvider(new Map([['k', shortKey]]), 'k')).toThrow(
      'Key must be 32 bytes',
    );
  });
});

// ---- EncryptionCodec ----

describe('EncryptionCodec', () => {
  it('roundtrip — encrypt then decrypt produces original plaintext', async () => {
    const { provider } = providerWithKey();
    const codec = new EncryptionCodec(provider);
    const plaintext = new TextEncoder().encode('secret payload');

    const { ciphertext, nonce, keyId } = await codec.encrypt(plaintext);
    const decrypted = await codec.decrypt(ciphertext, nonce, keyId);

    expect(new TextDecoder().decode(decrypted)).toBe('secret payload');
  });

  it('wrong key — decrypt with different key throws', async () => {
    const { provider: providerA } = providerWithKey('keyA');
    const { provider: providerB } = providerWithKey('keyB');

    const codecA = new EncryptionCodec(providerA);
    const codecB = new EncryptionCodec(providerB);

    const plaintext = new TextEncoder().encode('data');
    const { ciphertext, nonce } = await codecA.encrypt(plaintext);

    await expect(codecB.decrypt(ciphertext, nonce, 'keyB')).rejects.toThrow();
  });

  it('nonce uniqueness — two encryptions produce different ciphertexts', async () => {
    const { provider } = providerWithKey();
    const codec = new EncryptionCodec(provider);
    const plaintext = new TextEncoder().encode('same data');

    const result1 = await codec.encrypt(plaintext);
    const result2 = await codec.encrypt(plaintext);

    expect(result1.ciphertext).not.toEqual(result2.ciphertext);
    expect(result1.nonce).not.toEqual(result2.nonce);
  });

  it('key rotation — provider with multiple keys works', async () => {
    const oldKey = randomKey();
    const newKey = randomKey();
    const keys = new Map([
      ['v1', oldKey],
      ['v2', newKey],
    ]);

    // Encrypt with old key
    const oldProvider = new StaticKeyProvider(new Map(keys), 'v1');
    const oldCodec = new EncryptionCodec(oldProvider);
    const plaintext = new TextEncoder().encode('rotated secret');
    const { ciphertext, nonce, keyId } = await oldCodec.encrypt(plaintext);
    expect(keyId).toBe('v1');

    // Decrypt with provider whose current key is v2 but still has v1
    const newProvider = new StaticKeyProvider(new Map(keys), 'v2');
    const newCodec = new EncryptionCodec(newProvider);
    const decrypted = await newCodec.decrypt(ciphertext, nonce, 'v1');

    expect(new TextDecoder().decode(decrypted)).toBe('rotated secret');
  });
});

// ---- Middleware ----

describe('encryptionMiddleware', () => {
  it('sets meta keys correctly', async () => {
    const { provider } = providerWithKey('test-key');
    const codec = new EncryptionCodec(provider);
    const mw = encryptionMiddleware(codec);

    let captured: Job | null = null;
    await mw(makeJob(), async (job) => {
      captured = job;
      return job;
    });

    expect(captured).not.toBeNull();
    const meta = captured!.meta!;
    expect(meta[META_ENCODINGS]).toEqual([ENCODING_ENCRYPTED]);
    expect(meta[META_KEY_ID]).toBe('test-key');
    expect(typeof meta[META_NONCE]).toBe('string');
    expect((meta[META_NONCE] as string).length).toBeGreaterThan(0);
  });

  it('replaces args with single base64 ciphertext string', async () => {
    const { provider } = providerWithKey();
    const codec = new EncryptionCodec(provider);
    const mw = encryptionMiddleware(codec);

    let captured: Job | null = null;
    await mw(makeJob(['a', 'b', 'c']), async (job) => {
      captured = job;
      return job;
    });

    expect(captured!.args).toHaveLength(1);
    expect(typeof captured!.args[0]).toBe('string');
  });
});

describe('decryptionMiddleware', () => {
  it('roundtrips through encrypt → decrypt middleware', async () => {
    const { provider } = providerWithKey();
    const codec = new EncryptionCodec(provider);
    const encMw = encryptionMiddleware(codec);
    const decMw = decryptionMiddleware(codec);

    const originalArgs = ['hello', 42, true, null];
    const job = makeJob(originalArgs);

    // Encrypt
    let encryptedJob: Job | null = null;
    await encMw(job, async (j) => {
      encryptedJob = j;
      return j;
    });

    // Decrypt
    const ctx = makeContext(encryptedJob!);
    let decryptedArgs: unknown[] | undefined;
    await decMw(ctx, async () => {
      decryptedArgs = ctx.job.args;
      return undefined;
    });

    expect(decryptedArgs).toEqual(originalArgs);
  });

  it('passes through unencrypted jobs unchanged', async () => {
    const { provider } = providerWithKey();
    const codec = new EncryptionCodec(provider);
    const decMw = decryptionMiddleware(codec);

    const job = makeJob(['plain']);
    const ctx = makeContext(job);

    let called = false;
    await decMw(ctx, async () => {
      called = true;
      return undefined;
    });

    expect(called).toBe(true);
    expect(ctx.job.args).toEqual(['plain']);
  });

  it('throws when encrypted job is missing nonce or key_id', async () => {
    const { provider } = providerWithKey();
    const codec = new EncryptionCodec(provider);
    const decMw = decryptionMiddleware(codec);

    const job = makeJob(['ciphertext'], {
      [META_ENCODINGS]: [ENCODING_ENCRYPTED],
      // missing key_id and nonce
    });
    const ctx = makeContext(job);

    await expect(decMw(ctx, async () => undefined)).rejects.toThrow(
      'missing required meta',
    );
  });
});
