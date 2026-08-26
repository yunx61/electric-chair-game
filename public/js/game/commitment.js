import { PROTOCOL_VERSION } from './rules.js';

const encoder = new TextEncoder();
const HEX_32_BYTES = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[a-f0-9]{32,128}$/;
const SAFE_FIELD = /^[A-Za-z0-9_-]{1,128}$/;

function assertField(name, value) {
  const text = String(value);
  if (!SAFE_FIELD.test(text)) throw new TypeError(`${name} is invalid`);
  return text;
}

function bytesToHex(bytes) {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function canonicalCommit({ roomId, matchId, turnNumber, trapperUid, seat, nonce }) {
  const fields = [
    PROTOCOL_VERSION,
    assertField('roomId', roomId),
    assertField('matchId', matchId),
    String(Number(turnNumber)),
    assertField('trapperUid', trapperUid),
    String(Number(seat)),
    String(nonce).toLowerCase()
  ];
  if (!Number.isInteger(Number(turnNumber)) || Number(turnNumber) < 1) throw new TypeError('turnNumber is invalid');
  if (!Number.isInteger(Number(seat)) || Number(seat) < 1 || Number(seat) > 12) throw new TypeError('seat is invalid');
  if (!NONCE_PATTERN.test(fields[6])) throw new TypeError('nonce is invalid');
  return fields.map(value => `${encoder.encode(value).byteLength}:${value}`).join('|');
}

export async function createCommit(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalCommit(input)));
  return bytesToHex(new Uint8Array(digest));
}

export async function verifyCommit(hash, input) {
  if (!HEX_32_BYTES.test(String(hash || ''))) return false;
  return (await createCommit(input)) === hash;
}
