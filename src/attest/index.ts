/**
 * OJS Verifiable Compute Attestation.
 *
 * Provides attestation interfaces and implementations for hardware-backed
 * (AWS Nitro, Intel TDX, AMD SEV-SNP) and software-only (PQC / HMAC-SHA256)
 * verifiable compute.
 *
 * @example
 * ```ts
 * import { NoneAttestor, PQCOnlyAttestor } from '@openjobspec/sdk/attest';
 *
 * const attestor = new NoneAttestor();
 * const result = await attestor.attest({
 *   jobId: 'job-1',
 *   jobType: 'ml.train',
 *   argsHash: 'sha256:abc',
 *   resultHash: 'sha256:def',
 *   timestamp: new Date(),
 * });
 * ```
 *
 * @packageDocumentation
 */

export { QuoteType, SignatureAlgorithm } from './types.js';
export type {
  QuoteTypeValue,
  SignatureAlgorithmValue,
  AttestInput,
  AttestResult,
  Quote,
  Jurisdiction,
  ModelFingerprint,
  Signature,
  Receipt,
} from './types.js';

import type { AttestInput, AttestResult, Receipt } from './types.js';
import { QuoteType, SignatureAlgorithm } from './types.js';

// ---------------------------------------------------------------------------
// Attestor interface
// ---------------------------------------------------------------------------

/** Interface implemented by all attestation back-ends. */
export interface Attestor {
  /** Human-readable identifier for this attestor. */
  name(): string;

  /** Produce an attestation result for the given input. */
  attest(input: AttestInput): Promise<AttestResult>;

  /** Check a previously produced receipt. */
  verify(receipt: Receipt): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Hardware attestation is not available on this platform. */
export class AttestationNotAvailableError extends Error {
  constructor() {
    super('attest: hardware attestation not available on this platform');
    this.name = 'AttestationNotAvailableError';
  }
}

// ---------------------------------------------------------------------------
// NoneAttestor
// ---------------------------------------------------------------------------

/** Default no-op attestor that always succeeds. */
export class NoneAttestor implements Attestor {
  name(): string {
    return 'none';
  }

  async attest(input: AttestInput): Promise<AttestResult> {
    return {
      quote: {
        type: QuoteType.None,
        evidence: new Uint8Array(0),
        nonce: '',
        issuedAt: input.timestamp,
      },
      signature: { algorithm: SignatureAlgorithm.Ed25519, value: '', keyId: '' },
    };
  }

  async verify(_receipt: Receipt): Promise<void> {
    // Always succeeds.
  }
}

// ---------------------------------------------------------------------------
// PQCOnlyAttestor
// ---------------------------------------------------------------------------

/**
 * Software-only PQC-ready attestor using HMAC-SHA256 (placeholder).
 *
 * Uses the Web Crypto API — works in browsers and Node.js 18+.
 * A future version will use ML-DSA-65 once WebCrypto supports it.
 */
export class PQCOnlyAttestor implements Attestor {
  private readonly _secret: Uint8Array;
  private readonly _keyId: string;

  constructor(secret: Uint8Array, keyId: string) {
    this._secret = secret;
    this._keyId = keyId;
  }

  name(): string {
    return 'pqc-only';
  }

  async attest(input: AttestInput): Promise<AttestResult> {
    const digest = await attestDigest(input);
    const sig = await hmacSign(this._secret, digest);

    return {
      quote: {
        type: QuoteType.PQCOnly,
        evidence: digest,
        nonce: hexEncode(digest.slice(0, 16)),
        issuedAt: input.timestamp,
      },
      signature: {
        algorithm: 'hmac-sha256',
        value: hexEncode(sig),
        keyId: this._keyId,
      },
    };
  }

  async verify(receipt: Receipt): Promise<void> {
    if (!receipt.quote) {
      throw new Error('attest: receipt has no quote');
    }
    const expected = await hmacSign(this._secret, receipt.quote.evidence);
    const actual = hexDecode(receipt.signature.value);

    if (!timingSafeEqual(expected, actual)) {
      throw new Error('attest: HMAC-SHA256 signature verification failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Hardware stubs
// ---------------------------------------------------------------------------

/** Placeholder for AWS Nitro Enclave attestation. */
export class NitroAttestor implements Attestor {
  name(): string {
    return 'aws-nitro';
  }
  async attest(_input: AttestInput): Promise<AttestResult> {
    throw new AttestationNotAvailableError();
  }
  async verify(_receipt: Receipt): Promise<void> {
    throw new AttestationNotAvailableError();
  }
}

/** Placeholder for Intel TDX attestation. */
export class TDXAttestor implements Attestor {
  name(): string {
    return 'intel-tdx';
  }
  async attest(_input: AttestInput): Promise<AttestResult> {
    throw new AttestationNotAvailableError();
  }
  async verify(_receipt: Receipt): Promise<void> {
    throw new AttestationNotAvailableError();
  }
}

/** Placeholder for AMD SEV-SNP attestation. */
export class SEVAttestor implements Attestor {
  name(): string {
    return 'amd-sev-snp';
  }
  async attest(_input: AttestInput): Promise<AttestResult> {
    throw new AttestationNotAvailableError();
  }
  async verify(_receipt: Receipt): Promise<void> {
    throw new AttestationNotAvailableError();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (zero dependencies — uses Web Crypto API)
// ---------------------------------------------------------------------------

async function attestDigest(e: AttestInput): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(e.argsHash),
    encoder.encode(e.resultHash),
    encoder.encode(e.timestamp.toISOString()),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    buf.set(p, offset);
    offset += p.length;
  }
  const hash = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(hash);
}

async function hmacSign(secret: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, data);
  return new Uint8Array(sig);
}

function hexEncode(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex character at position ${i * 2}`);
    }
    bytes[i] = byte;
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
