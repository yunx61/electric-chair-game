import { verifyCommit } from './commitment.js';
import { DISCONNECT_TIMEOUT_MS, isSeat, matchKey, MAX_TURNS, PROTOCOL_VERSION, RESULT_HOLD_MS, REVEAL_TIMEOUT_MS, rulesFor, setterIndexFor, turnKey } from './rules.js';

function isOnline(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.connections && Object.keys(entry.connections).length > 0) return true;
  return entry.state === 'online';
}

function emptyPlayer(name, presence) {
  return { name, score: 0, shocks: 0, wins: 0, connected: isOnline(presence), isAI: false };
}

function invalidState(base, detail) {
  return { ...base, phase: 'game_over', winnerIndex: null, endReason: 'protocol_violation', protocolError: detail, canSetTrap: false, canChooseSeat: false };
}

function gameOutcome(players, remainingSeats, actorIndex, rules) {
  const actor = players[actorIndex];
  if (actor.shocks >= rules.shockLimit) return { winnerIndex: 1 - actorIndex, reason: 'shock_limit' };
  if (actor.score >= rules.targetScore) return { winnerIndex: actorIndex, reason: 'target_score' };
  if (remainingSeats.length <= 1) return { winnerIndex: players[0].score === players[1].score ? null : (players[0].score > players[1].score ? 0 : 1), reason: 'one_seat_left' };
  return null;
}

async function completedWinner(roomId, room, gameKey, match, host, guest) {
  const leaves = room.game?.leaves?.[gameKey] || {};
  if (leaves[host.uid]) return 1;
  if (leaves[guest.uid]) return 0;
  const claims = room.game?.disconnectForfeits?.[gameKey] || {};
  if (claims[host.uid]?.reason === 'disconnect_timeout') return 0;
  if (claims[guest.uid]?.reason === 'disconnect_timeout') return 1;
  const matchId = match?.meta?.matchId;
  if (!/^[A-Za-z0-9_-]{22}$/.test(String(matchId || ''))) return null;
  const players = [{ score: 0, shocks: 0 }, { score: 0, shocks: 0 }];
  const remaining = [...rulesFor().seats];
  for (let turnNumber = 1; turnNumber <= MAX_TURNS; turnNumber += 1) {
    const setterIndex = setterIndexFor(turnNumber, 1);
    const sitterIndex = 1 - setterIndex;
    const setterUid = setterIndex === 0 ? host.uid : guest.uid;
    const sitterUid = sitterIndex === 0 ? host.uid : guest.uid;
    const event = match.turns?.[turnKey(turnNumber, setterIndex)];
    if (!event?.commit || !event.choice) return null;
    if (event.forfeit?.uid === sitterUid) return sitterIndex;
    if (!event.reveal || event.commit.uid !== setterUid || event.choice.uid !== sitterUid) return null;
    if (!await verifyCommit(event.commit.hash, { roomId, matchId, turnNumber, trapperUid: setterUid, seat: event.reveal.seat, nonce: event.reveal.nonce })) return null;
    const shocked = event.choice.seat === event.reveal.seat;
    if (shocked) { players[sitterIndex].score = 0; players[sitterIndex].shocks += 1; }
    else { players[sitterIndex].score += event.choice.seat; remaining.splice(remaining.indexOf(event.choice.seat), 1); }
    const outcome = gameOutcome(players, remaining, sitterIndex, rulesFor());
    if (outcome) return outcome.winnerIndex;
  }
  return null;
}

function disconnectedOutcome(room, gameKey, players, you, host, guest, now) {
  const leaves = room.game?.leaves?.[gameKey] || {};
  if (leaves[host.uid]) return { winnerIndex: 1, reason: 'opponent_left' };
  if (leaves[guest.uid]) return { winnerIndex: 0, reason: 'opponent_left' };
  const claims = room.game?.disconnectForfeits?.[gameKey] || {};
  const yourUid = you === 0 ? host.uid : guest.uid;
  if (claims[yourUid]?.reason === 'disconnect_timeout') return { winnerIndex: you, reason: 'disconnect_timeout' };
  const opponentIndex = 1 - you;
  const opponentPresence = room.presence?.[opponentIndex === 0 ? host.uid : guest.uid];
  const lastChanged = Number(opponentPresence?.lastChanged || 0);
  if (!players[opponentIndex].connected && lastChanged > 0) {
    return { disconnectDeadline: lastChanged + DISCONNECT_TIMEOUT_MS, disconnectClaimable: now >= lastChanged + DISCONNECT_TIMEOUT_MS };
  }
  return {};
}

function resolveExternal(state, disconnect, players) {
  if (disconnect.winnerIndex == null) return { ...state, ...disconnect };
  players[disconnect.winnerIndex].wins += 1;
  return {
    ...state, ...disconnect, players, phase: 'game_over', endReason: disconnect.reason,
    winnerIndex: disconnect.winnerIndex, canSetTrap: false, canChooseSeat: false,
    replay: { ...state.replay, endReason: disconnect.reason, winnerIndex: disconnect.winnerIndex }
  };
}

export async function replayOnlineGame({ roomId, room, uid, now = Date.now() }) {
  const meta = room?.meta || {};
  const host = meta.host || {};
  const guest = meta.guest || null;
  const you = uid === host.uid ? 0 : (uid === guest?.uid ? 1 : -1);
  if (you < 0) throw new Error('このルームの参加者ではありません');
  if (meta.protocolVersion && meta.protocolVersion !== PROTOCOL_VERSION) throw new Error('この対戦は旧バージョンです。新しいルームを作成してください');
  const presence = room.presence || {};
  const players = [emptyPlayer(host.name || 'PLAYER 1', presence[host.uid]), guest ? emptyPlayer(guest.name || 'PLAYER 2', presence[guest.uid]) : null];
  const currentKey = room.game?.currentKey || matchKey(1);
  const currentGame = room.game?.matches?.[currentKey];
  const gameNumber = Number(currentGame?.meta?.gameNumber || 1);
  const nextKey = matchKey(gameNumber + 1);
  const votes = room.game?.rematchVotes?.[nextKey] || {};
  for (const [key, match] of Object.entries(room.game?.matches || {})) {
    if (Number(match?.meta?.gameNumber) >= gameNumber) continue;
    const winner = await completedWinner(roomId, room, key, match, host, guest);
    if (winner != null) players[winner].wins += 1;
  }
  const base = {
    roomId, code: String(roomId).toUpperCase(), mode: 'human', challengeId: null,
    rules: rulesFor(), players, you, turnNumber: 0, gameNumber,
    remainingSeats: [...rulesFor().seats], lastResult: null, winnerIndex: null, endReason: null,
    rematchVotes: [Boolean(votes[host.uid]), Boolean(guest && votes[guest.uid])],
    canSetTrap: false, canChooseSeat: false, revealDeadline: null,
    disconnectDeadline: null, disconnectClaimable: false, protocolError: null,
    replay: { version: PROTOCOL_VERSION, roomId, gameNumber, players: [host.name, guest?.name], turns: [] }
  };
  if (!guest) return { ...base, phase: 'waiting', setterIndex: null, sitterIndex: null };
  const matchId = currentGame?.meta?.matchId;
  if (!/^[A-Za-z0-9_-]{22}$/.test(String(matchId || ''))) return { ...base, phase: 'waiting', setterIndex: null, sitterIndex: null };
  const disconnect = disconnectedOutcome(room, currentKey, players, you, host, guest, now);
  const rules = rulesFor();
  const remainingSeats = [...rules.seats];
  const turns = currentGame.turns || {};
  const transcript = [];
  let lastResult = null;
  for (let turnNumber = 1; turnNumber <= MAX_TURNS; turnNumber += 1) {
    const setterIndex = setterIndexFor(turnNumber, 1);
    const sitterIndex = 1 - setterIndex;
    const setterUid = setterIndex === 0 ? host.uid : guest.uid;
    const sitterUid = sitterIndex === 0 ? host.uid : guest.uid;
    const key = turnKey(turnNumber, setterIndex);
    const event = turns[key] || {};
    const state = { ...base, ...disconnect, players, remainingSeats: [...remainingSeats], turnNumber, setterIndex, sitterIndex, matchId, matchKey: currentKey, lastResult, replay: { ...base.replay, turns: transcript } };
    if (!event.commit) return resolveExternal({ ...state, phase: 'set_trap', canSetTrap: you === setterIndex, canChooseSeat: false }, disconnect, players);
    if (event.commit.uid !== setterUid || !/^[a-f0-9]{64}$/.test(String(event.commit.hash || ''))) return invalidState(state, 'COMMIT_INVALID');
    if (!event.choice) return resolveExternal({ ...state, phase: 'choose_seat', commitHash: event.commit.hash, canSetTrap: false, canChooseSeat: you === sitterIndex }, disconnect, players);
    if (event.choice.uid !== sitterUid || !isSeat(event.choice.seat, remainingSeats)) return invalidState(state, 'CHOICE_INVALID');
    if (!event.reveal) {
      if (event.forfeit) {
        if (event.forfeit.uid !== sitterUid || event.forfeit.reason !== 'reveal_timeout') return invalidState(state, 'FORFEIT_INVALID');
        return { ...state, commitHash: event.commit.hash, phase: 'game_over', winnerIndex: sitterIndex, endReason: 'reveal_timeout', replay: { ...state.replay, endReason: 'reveal_timeout', winnerIndex: sitterIndex } };
      }
      return resolveExternal({ ...state, phase: 'reveal_wait', commitHash: event.commit.hash, revealDeadline: Number(event.choice.at || 0) + REVEAL_TIMEOUT_MS, canSetTrap: false, canChooseSeat: false }, disconnect, players);
    }
    if (event.reveal.uid !== setterUid || !isSeat(event.reveal.seat, remainingSeats)) return invalidState(state, 'REVEAL_INVALID');
    const valid = await verifyCommit(event.commit.hash, { roomId, matchId, turnNumber, trapperUid: setterUid, seat: event.reveal.seat, nonce: event.reveal.nonce });
    if (!valid) return invalidState(state, 'COMMIT_REVEAL_MISMATCH');
    const sitter = players[sitterIndex];
    const before = sitter.score;
    const shocked = event.choice.seat === event.reveal.seat;
    if (shocked) { sitter.score = 0; sitter.shocks += 1; }
    else { sitter.score += event.choice.seat; remainingSeats.splice(remainingSeats.indexOf(event.choice.seat), 1); }
    lastResult = { seat: event.choice.seat, trapSeat: event.reveal.seat, shocked, playerIndex: sitterIndex, pointsBefore: before, pointsAfter: sitter.score, gained: shocked ? 0 : event.choice.seat };
    transcript.push({ turnNumber, commitHash: event.commit.hash, choice: event.choice.seat, trap: event.reveal.seat, nonce: event.reveal.nonce, result: lastResult });
    const outcome = gameOutcome(players, remainingSeats, sitterIndex, rules);
    const resultUntil = Number(event.reveal.at || 0) + RESULT_HOLD_MS;
    if (outcome && now >= resultUntil) {
      if (outcome.winnerIndex != null) players[outcome.winnerIndex].wins += 1;
      return { ...state, players, remainingSeats: [...remainingSeats], lastResult, phase: 'game_over', winnerIndex: outcome.winnerIndex, endReason: outcome.reason, turnNumber, replay: { ...state.replay, turns: transcript, endReason: outcome.reason, winnerIndex: outcome.winnerIndex } };
    }
    if (now < resultUntil) return { ...state, players, remainingSeats: [...remainingSeats], lastResult, phase: 'result', resultUntil, turnNumber, replay: { ...state.replay, turns: transcript } };
  }
  return invalidState({ ...base, players, remainingSeats }, 'TURN_LIMIT_EXCEEDED');
}
