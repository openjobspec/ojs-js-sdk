/**
 * Attestation data types for OJS verifiable compute.
 *
 * @packageDocumentation
 */

/** Quote type constants. */
export const QuoteType = {
  AWSNitro: 'aws-nitro-v1',
  IntelTDX: 'intel-tdx-v4',
  AMDSEVSNP: 'amd-sev-snp-v2',
  PQCOnly: 'pqc-only',
  None: 'none',
} as const;

export type QuoteTypeValue = (typeof QuoteType)[keyof typeof QuoteType];

/** Signature algorithm constants. */
export const SignatureAlgorithm = {
  Ed25519: 'ed25519',
  MLDSA65: 'ml-dsa-65',
  HybridEdMLDSA: 'hybrid:Ed25519+ML-DSA-65',
} as const;

export type SignatureAlgorithmValue =
  (typeof SignatureAlgorithm)[keyof typeof SignatureAlgorithm];

/** Input envelope for attestation. */
export interface AttestInput {
  readonly jobId: string;
  readonly jobType: string;
  readonly argsHash: string;
  readonly resultHash: string;
  readonly timestamp: Date;
}

/** Attestation evidence produced by the TEE or software layer. */
export interface Quote {
  readonly type: string;
  readonly evidence: Uint8Array;
  readonly nonce: string;
  readonly issuedAt: Date;
}

/** Where the attestation was produced. */
export interface Jurisdiction {
  readonly region: string;
  readonly datacenter: string;
  readonly prover: string;
}

/** ML model identity for auditability. */
export interface ModelFingerprint {
  readonly sha256: string;
  readonly registryUrl: string;
}

/** Cryptographic signature over the attestation. */
export interface Signature {
  readonly algorithm: string;
  readonly value: string;
  readonly keyId: string;
}

/** Result of a successful attestation. */
export interface AttestResult {
  readonly quote?: Quote;
  readonly jurisdiction?: Jurisdiction;
  readonly modelFingerprint?: ModelFingerprint;
  readonly signature: Signature;
}

/** Bundle a verifier needs to check an attestation. */
export interface Receipt {
  readonly jobId: string;
  readonly quote?: Quote;
  readonly jurisdiction?: Jurisdiction;
  readonly modelFingerprint?: ModelFingerprint;
  readonly signature: Signature;
  readonly issuedAt: Date;
}
