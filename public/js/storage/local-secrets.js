const PREFIX = 'ecd_pending_secret:';
const SECRET_TTL_MS = 10 * 60 * 1000;

function legacyKeyFor(roomId, matchId, turnNumber) {
  return `${PREFIX}${roomId}:${matchId}:${turnNumber}`;
}

function keyFor(roomId, matchId, turnNumber, commitHash) {
  return `${legacyKeyFor(roomId, matchId, turnNumber)}:${commitHash}`;
}

export function savePendingSecret(secret) {
  const value = { ...secret, expiresAt: Date.now() + SECRET_TTL_MS };
  localStorage.setItem(keyFor(secret.roomId, secret.matchId, secret.turnNumber, secret.commitHash), JSON.stringify(value));
}

export function loadPendingSecret(roomId, matchId, turnNumber, commitHash) {
  try {
    const key = keyFor(roomId, matchId, turnNumber, commitHash);
    let raw = localStorage.getItem(key);
    if (!raw) {
      raw = sessionStorage.getItem(key);
      if (raw) sessionStorage.removeItem(key);
    }
    if (!raw) {
      const legacyKey = legacyKeyFor(roomId, matchId, turnNumber);
      raw = localStorage.getItem(legacyKey) || sessionStorage.getItem(legacyKey);
      try { localStorage.removeItem(legacyKey); } catch {}
      try { sessionStorage.removeItem(legacyKey); } catch {}
    }
    const value = JSON.parse(raw || 'null');
    const valid = value
      && typeof value === 'object'
      && value.roomId === roomId
      && value.matchId === matchId
      && value.turnNumber === turnNumber
      && Number.isInteger(value.seat)
      && value.seat >= 1
      && value.seat <= 12
      && typeof value.nonce === 'string'
      && /^[a-f0-9]{32,128}$/.test(value.nonce)
      && value.commitHash === commitHash
      && /^[a-f0-9]{64}$/.test(String(commitHash || ''))
      && (!value.expiresAt || (Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()));
    if (!valid) {
      localStorage.removeItem(key);
      return null;
    }
    if (!value.expiresAt) savePendingSecret(value);
    else if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
    return value;
  } catch {
    return null;
  }
}

export function removePendingSecret(roomId, matchId, turnNumber, commitHash) {
  const key = keyFor(roomId, matchId, turnNumber, commitHash);
  try { localStorage.removeItem(key); } catch {}
  try { sessionStorage.removeItem(key); } catch {}
}

export { SECRET_TTL_MS };
