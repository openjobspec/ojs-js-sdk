import { describe, it, expect } from 'vitest';
import {
  NoneAttestor,
  PQCOnlyAttestor,
  NitroAttestor,
  TDXAttestor,
  SEVAttestor,
  AttestationNotAvailableError,
  QuoteType,
  SignatureAlgorithm,
  type Attestor,
  type AttestInput,
  type Receipt,
} from '../src/attest/index.js';

function makeInput(overrides: Partial<AttestInput> = {}): AttestInput {
  return {
    jobId: 'job-1',
    jobType: 'ml.train',
    argsHash: 'sha256:abc123',
    resultHash: 'sha256:def456',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('NoneAttestor', () => {
  it('reports its name', () => {
    expect(new NoneAttestor().name()).toBe('none');
  });

  it('always succeeds and returns a "none" quote with empty evidence', async () => {
    const attestor = new NoneAttestor();
    const result = await attestor.attest(makeInput());

    expect(result.quote?.type).toBe(QuoteType.None);
    expect(result.quote?.evidence).toEqual(new Uint8Array(0));
    expect(result.quote?.issuedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(result.signature.algorithm).toBe(SignatureAlgorithm.Ed25519);
  });

  it('verify() always resolves without throwing, for any receipt', async () => {
    const attestor = new NoneAttestor();
    const receipt: Receipt = {
      jobId: 'job-1',
      signature: { algorithm: SignatureAlgorithm.Ed25519, value: 'garbage', keyId: '' },
      issuedAt: new Date(),
    };
    await expect(attestor.verify(receipt)).resolves.toBeUndefined();
  });

  it('returns a genuine Promise from attest()/verify() rather than throwing synchronously', () => {
    const attestor = new NoneAttestor();
    const p1 = attestor.attest(makeInput());
    const p2 = attestor.verify({
      jobId: 'x',
      signature: { algorithm: 'ed25519', value: '', keyId: '' },
      issuedAt: new Date(),
    });
    expect(p1).toBeInstanceOf(Promise);
    expect(p2).toBeInstanceOf(Promise);
  });
});

describe('PQCOnlyAttestor', () => {
  const secret = new Uint8Array(32).fill(7);

  it('reports its name', () => {
    expect(new PQCOnlyAttestor(secret, 'key-1').name()).toBe('pqc-only');
  });

  it('produces a quote and an HMAC-SHA256 signature identified by the shared constant', async () => {
    const attestor = new PQCOnlyAttestor(secret, 'key-1');
    const result = await attestor.attest(makeInput());

    expect(result.quote?.type).toBe(QuoteType.PQCOnly);
    expect(result.quote?.evidence.length).toBe(32); // SHA-256 digest
    expect(result.quote?.nonce).toMatch(/^[0-9a-f]{32}$/); // first 16 bytes, hex
    expect(result.signature.algorithm).toBe(SignatureAlgorithm.HmacSha256);
    expect(result.signature.algorithm).toBe('hmac-sha256');
    expect(result.signature.keyId).toBe('key-1');
    expect(result.signature.value).toMatch(/^[0-9a-f]+$/);
  });

  it('produces a deterministic digest/signature for identical input', async () => {
    const attestor = new PQCOnlyAttestor(secret, 'key-1');
    const a = await attestor.attest(makeInput());
    const b = await attestor.attest(makeInput());

    expect(a.quote?.nonce).toBe(b.quote?.nonce);
    expect(a.signature.value).toBe(b.signature.value);
  });

  it('produces different signatures for different args/result hashes', async () => {
    const attestor = new PQCOnlyAttestor(secret, 'key-1');
    const a = await attestor.attest(makeInput({ argsHash: 'sha256:aaa' }));
    const b = await attestor.attest(makeInput({ argsHash: 'sha256:bbb' }));

    expect(a.signature.value).not.toBe(b.signature.value);
  });

  it('round-trips: a receipt built from attest() verifies successfully', async () => {
    const attestor = new PQCOnlyAttestor(secret, 'key-1');
    const result = await attestor.attest(makeInput());

    const receipt: Receipt = {
      jobId: 'job-1',
      quote: result.quote,
      signature: result.signature,
      issuedAt: makeInput().timestamp,
    };

    await expect(attestor.verify(receipt)).resolves.toBeUndefined();
  });

  it('rejects verification when the receipt has no quote', async () => {
    const attestor = new PQCOnlyAttestor(secret, 'key-1');
    const receipt: Receipt = {
      jobId: 'job-1',
      signature: { algorithm: SignatureAlgorithm.HmacSha256, value: 'aa', keyId: 'key-1' },
      issuedAt: new Date(),
    };

    await expect(attestor.verify(receipt)).rejects.toThrow('receipt has no quote');
  });

  it('rejects verification when the signature has been tampered with', async () => {
    const attestor = new PQCOnlyAttestor(secret, 'key-1');
    const result = await attestor.attest(makeInput());

    const tamperedReceipt: Receipt = {
      jobId: 'job-1',
      quote: result.quote,
      signature: { ...result.signature, value: result.signature.value.replace(/^./, (c) => (c === '0' ? '1' : '0')) },
      issuedAt: makeInput().timestamp,
    };

    await expect(attestor.verify(tamperedReceipt)).rejects.toThrow('verification failed');
  });

  it('rejects verification when the evidence has been tampered with', async () => {
    const attestor = new PQCOnlyAttestor(secret, 'key-1');
    const result = await attestor.attest(makeInput());
    const evidence = result.quote!.evidence.slice();
    evidence[0] = (evidence[0]! + 1) % 256;

    const tamperedReceipt: Receipt = {
      jobId: 'job-1',
      quote: { ...result.quote!, evidence },
      signature: result.signature,
      issuedAt: makeInput().timestamp,
    };

    await expect(attestor.verify(tamperedReceipt)).rejects.toThrow('verification failed');
  });

  it('rejects verification when signed with a different secret', async () => {
    const attestor = new PQCOnlyAttestor(secret, 'key-1');
    const otherAttestor = new PQCOnlyAttestor(new Uint8Array(32).fill(9), 'key-2');

    const result = await otherAttestor.attest(makeInput());
    const receipt: Receipt = {
      jobId: 'job-1',
      quote: result.quote,
      signature: result.signature,
      issuedAt: makeInput().timestamp,
    };

    await expect(attestor.verify(receipt)).rejects.toThrow('verification failed');
  });
});

describe('Hardware attestor stubs', () => {
  const stubs: Array<{ name: string; make: () => Attestor; label: string }> = [
    { name: 'NitroAttestor', make: () => new NitroAttestor(), label: 'aws-nitro' },
    { name: 'TDXAttestor', make: () => new TDXAttestor(), label: 'intel-tdx' },
    { name: 'SEVAttestor', make: () => new SEVAttestor(), label: 'amd-sev-snp' },
  ];

  for (const { name, make, label } of stubs) {
    describe(name, () => {
      it(`reports "${label}" as its name`, () => {
        expect(make().name()).toBe(label);
      });

      it('rejects attest() with AttestationNotAvailableError as a genuine (asynchronous) Promise rejection, not a synchronous throw', async () => {
        const attestor = make();
        let thrown = false;
        let attestPromise: Promise<unknown> | undefined;
        try {
          attestPromise = attestor.attest(makeInput());
        } catch {
          thrown = true;
        }
        // Must not throw synchronously — callers doing `await attestor.attest(...)`
        // inside their own try/catch (or a bare `.catch()`) must be able to
        // rely on a rejected Promise, not a JS exception raised before any
        // Promise is even returned.
        expect(thrown).toBe(false);
        expect(attestPromise).toBeInstanceOf(Promise);
        await expect(attestPromise).rejects.toBeInstanceOf(AttestationNotAvailableError);
      });

      it('rejects verify() with AttestationNotAvailableError as a genuine Promise rejection', async () => {
        const attestor = make();
        const receipt: Receipt = {
          jobId: 'job-1',
          signature: { algorithm: 'ed25519', value: '', keyId: '' },
          issuedAt: new Date(),
        };
        let thrown = false;
        let verifyPromise: Promise<unknown> | undefined;
        try {
          verifyPromise = attestor.verify(receipt);
        } catch {
          thrown = true;
        }
        expect(thrown).toBe(false);
        await expect(verifyPromise).rejects.toBeInstanceOf(AttestationNotAvailableError);
      });
    });
  }
});

describe('AttestationNotAvailableError', () => {
  it('has the expected name and message', () => {
    const err = new AttestationNotAvailableError();
    expect(err.name).toBe('AttestationNotAvailableError');
    expect(err.message).toContain('hardware attestation not available');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('QuoteType / SignatureAlgorithm constants', () => {
  it('exposes the documented quote type values', () => {
    expect(QuoteType.AWSNitro).toBe('aws-nitro-v1');
    expect(QuoteType.IntelTDX).toBe('intel-tdx-v4');
    expect(QuoteType.AMDSEVSNP).toBe('amd-sev-snp-v2');
    expect(QuoteType.PQCOnly).toBe('pqc-only');
    expect(QuoteType.None).toBe('none');
  });

  it('exposes the documented signature algorithm values, including HmacSha256', () => {
    expect(SignatureAlgorithm.Ed25519).toBe('ed25519');
    expect(SignatureAlgorithm.MLDSA65).toBe('ml-dsa-65');
    expect(SignatureAlgorithm.HybridEdMLDSA).toBe('hybrid:Ed25519+ML-DSA-65');
    expect(SignatureAlgorithm.HmacSha256).toBe('hmac-sha256');
  });
});
