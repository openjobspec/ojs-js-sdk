/**
 * Private, synchronous, cross-runtime UUID v4 provider.
 *
 * Not exported from the package's public surface (`src/index.ts`) — this is
 * an internal implementation detail used to generate worker IDs, event IDs,
 * and request IDs.
 */

import { getRandomBytes } from './crypto.js';

/** Assembles 16 random bytes into a canonical RFC 4122 version-4 UUID string. */
function bytesToUuidV4(bytes: Uint8Array): string {
  // Set the version (0100) and variant (10xx) bits per RFC 4122 §4.4.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Synchronously generates an RFC 4122 version-4 UUID string, working
 * identically across Node.js 18/20/22, browsers, and bundlers.
 */
export function generateUuidV4(): string {
  return bytesToUuidV4(getRandomBytes(16));
}
