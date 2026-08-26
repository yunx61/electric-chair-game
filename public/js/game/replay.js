import { verifyCommit } from './commitment.js';
import { isSeat, MAX_TURNS, RESULT_HOLD_MS, REVEAL_TIMEOUT_MS, rulesFor, setterIndexFor, turnKey } from './rules.js';

function emptyPlayer(name, connected) {
  return { name, score: 0, shocks: 0, wins: 0, connected: Boolean(connected), isAI: false };
}

function invalidState(base, detail) {
  return {
    ...base,
    phase: 'game_over',
    winnerIndex: null,
    endReason: 'protocol_violation',
    protocolError: detail,
    canSetTrap: false,
    canChooseSeat: false
  };
}

function gameOutcome(players, remainingSeats, actorIndex, rules) {
  const actor = players[actorIndex];
  if (actor.shocks >= rules.shockLimit) return { winnerIndex: 1 - actorIndex, reason: 'shock_limit' };
  if (actor.score >= rules.targetScore) return { winnerIndex: actorIndex, reason: 'target_score' };
  if (remainingSeats.length <= 1) {
    return {
      winnerIndex: players[0].score === players[1].score ? null : (players[0].score > players[1].score ? 0 : 1),
      reason: 'one_seat_left'
    };
  }
  return null;
}

export async function replayOnlineGame({ roomId, room, uid, now = Date.now() }) {
  const meta = room?.meta || {};
  const host = meta.host || {};
  const guest = meta.guest || null;
  const you = uid === host.uid ? 0 : (uid === guest?.uid ? 1 : -1);
  if (you < 0) throw new Error('このルームの参加者ではありません');

  const presence = room.presence || {};
  const players = [
    emptyPlayer(host.name || 'PLAYER 1', presence[host.uid]?.state === 'online'),
    guest ? emptyPlayer(guest.name || 'PLAYER 2', presence[guest.uid]?.state === 'online') : null
  ];
  const base = {
    roomId,
    code: String(roomId).slice(0, 6).toUpperCase(),
    mode: 'human',
    challengeId: null,
    rules: rulesFor(),
    players,
    you,
    turnNumber: 0,
    gameNumber: 1,
    remainingSeats: [...rulesFor().seats],
    lastResult: null,
    winnerIndex: null,
    endReason: null,
    rematchVotes: [false, false],
    canSetTrap: false,
    canChooseSeat: false,
    revealDeadline: null,
    protocolError: null
  };
  if (!guest) return { ...base, phase: 'waiting', setterIndex: null, sitterIndex: null };

  const game = room.game || {};
  const matchId = game.meta?.matchId;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(matchId || ''))) {
    return { ...base, phase: 'waiting', setterIndex: null, sitterIndex: null };
  }

  const rules = rulesFor();
  const remainingSeats = [...rules.seats];
  const turns = game.turns || {};
  let lastResult = null;

  for (let turnNumber = 1; turnNumber <= MAX_TURNS; turnNumber += 1) {
    const setterIndex = setterIndexFor(turnNumber, 1);
    const sitterIndex = 1 - setterIndex;
    const setterUid = setterIndex === 0 ? host.uid : guest.uid;
    const sitterUid = sitterIndex === 0 ? host.uid : guest.uid;
    const key = turnKey(turnNumber, setterIndex);
    const event = turns[key] || {};
    const state = {
      ...base,
      players,
      remainingSeats: [...remainingSeats],
      turnNumber,
      setterIndex,
      sitterIndex,
      matchId,
      lastResult
    };

    if (!event.commit) {
      return { ...state, phase: 'set_trap', canSetTrap: you === setterIndex, canChooseSeat: false };
    }
    if (event.commit.uid !== setterUid || !/^[a-f0-9]{64}$/.test(String(event.commit.hash || ''))) {
      return invalidState(state, 'COMMIT_INVALID');
    }
    if (!event.choice) {
      return { ...state, phase: 'choose_seat', canSetTrap: false, canChooseSeat: you === sitterIndex };
    }
    if (event.choice.uid !== sitterUid || !isSeat(event.choice.seat, remainingSeats)) {
      return invalidState(state, 'CHOICE_INVALID');
    }
    if (!event.reveal) {
      if (event.forfeit) {
        if (event.forfeit.uid !== sitterUid || event.forfeit.reason !== 'reveal_timeout') {
          return invalidState(state, 'FORFEIT_INVALID');
        }
        return { ...state, phase: 'game_over', winnerIndex: sitterIndex, endReason: 'reveal_timeout' };
      }
      return {
        ...state,
        phase: 'reveal_wait',
        revealDeadline: Number(event.choice.at || 0) + REVEAL_TIMEOUT_MS,
        canSetTrap: false,
        canChooseSeat: false
      };
    }
    if (event.reveal.uid !== setterUid || !isSeat(event.reveal.seat, remainingSeats)) {
      return invalidState(state, 'REVEAL_INVALID');
    }
    const commitmentValid = await verifyCommit(event.commit.hash, {
      roomId,
      matchId,
      turnNumber,
      trapperUid: setterUid,
      seat: event.reveal.seat,
      nonce: event.reveal.nonce
    });
    if (!commitmentValid) return invalidState(state, 'COMMIT_REVEAL_MISMATCH');

    const sitter = players[sitterIndex];
    const before = sitter.score;
    const shocked = event.choice.seat === event.reveal.seat;
    if (shocked) {
      sitter.score = 0;
      sitter.shocks += 1;
    } else {
      sitter.score += event.choice.seat;
      remainingSeats.splice(remainingSeats.indexOf(event.choice.seat), 1);
    }
    lastResult = {
      seat: event.choice.seat,
      trapSeat: event.reveal.seat,
      shocked,
      playerIndex: sitterIndex,
      pointsBefore: before,
      pointsAfter: sitter.score,
      gained: shocked ? 0 : event.choice.seat
    };
    const outcome = gameOutcome(players, remainingSeats, sitterIndex, rules);
    const resultUntil = Number(event.reveal.at || 0) + RESULT_HOLD_MS;
    if (outcome && now >= resultUntil) {
      if (outcome.winnerIndex != null) players[outcome.winnerIndex].wins = 1;
      return {
        ...state,
        players,
        remainingSeats: [...remainingSeats],
        lastResult,
        phase: 'game_over',
        winnerIndex: outcome.winnerIndex,
        endReason: outcome.reason,
        turnNumber
      };
    }
    if (now < resultUntil) {
      return {
        ...state,
        players,
        remainingSeats: [...remainingSeats],
        lastResult,
        phase: 'result',
        resultUntil,
        turnNumber
      };
    }
  }
  return invalidState({ ...base, players, remainingSeats }, 'TURN_LIMIT_EXCEEDED');
}
