const PREFIX = 'ecd_pending_secret:';

function keyFor(roomId, matchId, turnNumber) {
  return `${PREFIX}${roomId}:${matchId}:${turnNumber}`;
}

export function savePendingSecret(secret) {
  sessionStorage.setItem(keyFor(secret.roomId, secret.matchId, secret.turnNumber), JSON.stringify(secret));
}

export function loadPendingSecret(roomId, matchId, turnNumber) {
  try {
    const value = JSON.parse(sessionStorage.getItem(keyFor(roomId, matchId, turnNumber)) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function removePendingSecret(roomId, matchId, turnNumber) {
  sessionStorage.removeItem(keyFor(roomId, matchId, turnNumber));
}
