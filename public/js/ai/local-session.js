import { cleanName, rulesFor } from '../game/rules.js';

const AI_PROFILES = Object.freeze({
  rei: { id: 'rei', name: 'レイ', style: '冷徹分析型' },
  gou: { id: 'gou', name: 'ゴウ', style: '豪胆ギャンブラー' },
  mika: { id: 'mika', name: 'ミカ', style: '読心トリックスター' },
  nagi: { id: 'nagi', name: 'ナギ', style: '慎重堅実型' }
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const data = new Uint32Array(1);
  do crypto.getRandomValues(data); while (data[0] >= limit);
  return data[0] % max;
}

function weightedPick(items, scoreFn) {
  const scores = items.map(item => Math.max(0.001, scoreFn(item)));
  const total = scores.reduce((sum, score) => sum + score, 0);
  let cursor = (randomInt(1_000_000) / 1_000_000) * total;
  for (let index = 0; index < items.length; index += 1) {
    cursor -= scores[index];
    if (cursor <= 0) return items[index];
  }
  return items.at(-1);
}

const frequency = (items, value) => items.filter(item => item === value).length;
function recency(items, value) {
  let score = 0;
  items.slice(-6).forEach((item, index) => { if (item === value) score += index + 1; });
  return score;
}

export class LocalAiSession {
  constructor({ name, aiId, difficulty, challengeId, callbacks = {} }) {
    this.callbacks = callbacks;
    this.profile = AI_PROFILES[aiId] || AI_PROFILES.rei;
    this.difficulty = ['easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal';
    this.challengeId = challengeId || null;
    this.rules = rulesFor(challengeId);
    this.closed = false;
    this.busy = false;
    this.history = { traps: [[], []], sits: [[], []] };
    this.transcript = [];
    this.state = {
      roomId: null,
      code: this.difficulty.toUpperCase(),
      mode: 'ai',
      challengeId: this.challengeId,
      rules: this.rules,
      players: [
        { name: cleanName(name), score: 0, shocks: 0, wins: 0, connected: true, isAI: false },
        { name: this.profile.name, score: 0, shocks: 0, wins: 0, connected: true, isAI: true }
      ],
      you: 0,
      phase: 'set_trap',
      setterIndex: randomInt(2),
      sitterIndex: null,
      remainingSeats: [...this.rules.seats],
      turnNumber: 1,
      gameNumber: 1,
      lastResult: null,
      winnerIndex: null,
      endReason: null,
      rematchVotes: [false, false],
      ai: { ...this.profile, difficulty: this.difficulty },
      canSetTrap: false,
      canChooseSeat: false
    };
    this.state.sitterIndex = 1 - this.state.setterIndex;
    this.emit();
    this.scheduleAi();
  }

  emit() {
    if (this.closed) return;
    this.state.canSetTrap = this.state.phase === 'set_trap' && this.state.setterIndex === 0 && !this.busy;
    this.state.canChooseSeat = this.state.phase === 'choose_seat' && this.state.sitterIndex === 0 && !this.busy;
    this.callbacks.onConnection?.('connected');
    this.callbacks.onState?.(structuredClone(this.state));
  }

  async action(message) {
    if (this.closed) return;
    if (message.type === 'set_trap') return this.setTrap(message.seat, 0);
    if (message.type === 'choose_seat') return this.chooseSeat(message.seat, 0);
    if (message.type === 'rematch_vote') return this.restart();
    if (message.type === 'leave') return this.close();
  }

  async setTrap(seat, index) {
    if (this.busy || this.state.phase !== 'set_trap' || this.state.setterIndex !== index || !this.state.remainingSeats.includes(seat)) {
      throw new Error('今はそのイスに仕掛けられません');
    }
    this.busy = true;
    this.trapSeat = seat;
    this.history.traps[index].push(seat);
    this.state.phase = 'choose_seat';
    this.state.lastResult = null;
    this.busy = false;
    this.emit();
    this.scheduleAi();
  }

  async chooseSeat(seat, index) {
    if (this.busy || this.state.phase !== 'choose_seat' || this.state.sitterIndex !== index || !this.state.remainingSeats.includes(seat)) {
      throw new Error('今はそのイスを選べません');
    }
    this.busy = true;
    const sitter = this.state.players[index];
    const before = sitter.score;
    const shocked = seat === this.trapSeat;
    this.history.sits[index].push(seat);
    if (shocked) {
      sitter.score = 0;
      sitter.shocks += 1;
    } else {
      sitter.score += seat;
      this.state.remainingSeats = this.state.remainingSeats.filter(value => value !== seat);
    }
    this.state.lastResult = {
      seat,
      trapSeat: this.trapSeat,
      shocked,
      playerIndex: index,
      pointsBefore: before,
      pointsAfter: sitter.score,
      gained: shocked ? 0 : seat
    };
    this.transcript.push({ turnNumber: this.state.turnNumber, setterIndex: this.state.setterIndex, choice: seat, trap: this.trapSeat, result: { ...this.state.lastResult } });
    this.trapSeat = null;
    this.state.phase = 'result';
    this.busy = false;
    const outcome = this.outcome(index);
    this.emit();
    await delay(5000);
    if (this.closed || this.state.phase !== 'result') return;
    if (outcome) this.endGame(outcome.winnerIndex, outcome.reason);
    else this.nextTurn();
  }

  outcome(actorIndex) {
    const actor = this.state.players[actorIndex];
    if (actor.shocks >= this.rules.shockLimit) return { winnerIndex: 1 - actorIndex, reason: 'shock_limit' };
    if (actor.score >= this.rules.targetScore) return { winnerIndex: actorIndex, reason: 'target_score' };
    if (this.state.remainingSeats.length <= 1) {
      const [a, b] = this.state.players;
      return { winnerIndex: a.score === b.score ? null : (a.score > b.score ? 0 : 1), reason: 'one_seat_left' };
    }
    return null;
  }

  nextTurn() {
    const previousSetter = this.state.setterIndex;
    this.state.setterIndex = this.state.sitterIndex;
    this.state.sitterIndex = previousSetter;
    this.state.turnNumber += 1;
    this.state.phase = 'set_trap';
    this.state.lastResult = null;
    this.emit();
    this.scheduleAi();
  }

  endGame(winnerIndex, reason) {
    this.state.phase = 'game_over';
    this.state.winnerIndex = winnerIndex;
    this.state.endReason = reason;
    this.state.lastResult = null;
    if (winnerIndex != null) this.state.players[winnerIndex].wins += 1;
    this.state.analysis = this.buildAnalysis();
    this.state.replay = {
      version: 'ecd-local-v1', mode: 'ai', gameNumber: this.state.gameNumber,
      players: this.state.players.map(player => player.name), ai: { ...this.state.ai },
      turns: structuredClone(this.transcript), winnerIndex, endReason: reason
    };
    this.emit();
  }

  restart() {
    this.state.players.forEach(player => { player.score = 0; player.shocks = 0; });
    this.state.remainingSeats = [...this.rules.seats];
    this.state.turnNumber = 1;
    this.state.gameNumber += 1;
    this.state.setterIndex = randomInt(2);
    this.state.sitterIndex = 1 - this.state.setterIndex;
    this.state.phase = 'set_trap';
    this.state.lastResult = null;
    this.state.winnerIndex = null;
    this.state.endReason = null;
    this.history = { traps: [[], []], sits: [[], []] };
    this.transcript = [];
    this.state.analysis = null;
    this.state.replay = null;
    this.emit();
    this.scheduleAi();
  }

  buildAnalysis() {
    const seats = this.history.sits[0];
    const traps = this.history.traps[0];
    const favorite = items => items.length ? [...new Set(items)].sort((a, b) => frequency(items, b) - frequency(items, a))[0] : null;
    const average = seats.length ? (seats.reduce((sum, seat) => sum + seat, 0) / seats.length).toFixed(1) : '—';
    const repeats = seats.slice(1).filter((seat, index) => seat === seats[index]).length;
    return {
      title: `${this.profile.name}の対戦分析`,
      summary: `選択平均 ${average}番 / よく座ったイス ${favorite(seats) ?? '—'}番 / よく仕掛けたイス ${favorite(traps) ?? '—'}番 / 連続同手 ${repeats}回`,
      tip: Number(average) >= 8 ? '高得点側へ寄る傾向があります。次戦は中間のイスも混ぜると読まれにくくなります。' : '慎重な選択が多めです。勝ち切れる局面では高得点も候補に入れましょう。'
    };
  }

  humanSeatTendency(seat) {
    const sits = this.history.sits[0];
    const human = this.state.players[0];
    let tendency = frequency(sits, seat) * 1.05 + recency(sits, seat) * 0.34 + seat * 0.05;
    if (human.score >= Math.max(18, this.rules.targetScore - 15) && human.score + seat >= this.rules.targetScore) tendency += 2.5;
    if (human.shocks >= this.rules.shockLimit - 1 && seat <= 6) tendency += 1.25;
    return tendency;
  }

  aiTrapChoice() {
    const seats = this.state.remainingSeats;
    if (this.difficulty === 'easy') return seats[randomInt(seats.length)];
    return weightedPick(seats, seat => {
      const observed = frequency(this.history.sits[0], seat) + (this.difficulty === 'hard' ? recency(this.history.sits[0], seat) * 0.55 : 0);
      let score = 1 + seat * 0.18 + observed * (this.difficulty === 'hard' ? 2.2 : 1.05);
      if (this.difficulty === 'hard') score += this.humanSeatTendency(seat) * 1.45;
      if (this.profile.id === 'gou') score += seat >= 9 ? 3.5 : seat * 0.08;
      if (this.profile.id === 'nagi') score += seat >= 7 && seat <= 10 ? 1.7 : (seat >= 11 ? 0.7 : 0);
      if (this.profile.id === 'mika') score += ((seat + this.state.turnNumber) % 3 === 0 ? 1.5 : 0) + randomInt(2200) / 1000;
      if (this.profile.id === 'rei') score += seat * 0.16 + observed * 1.2;
      return score;
    });
  }

  aiSeatChoice() {
    const seats = this.state.remainingSeats;
    const traps = this.history.traps[0];
    const ai = this.state.players[1];
    if (this.difficulty === 'easy') return seats[randomInt(seats.length)];
    return weightedPick(seats, seat => {
      const risk = 0.42 + seat * 0.052 + frequency(traps, seat) * 0.82 + recency(traps, seat) * 0.26;
      let score;
      if (this.profile.id === 'gou') score = Math.pow(seat, 1.55) / (1 + risk * (this.difficulty === 'hard' ? 0.35 : 0.18));
      else if (this.profile.id === 'nagi') score = (seat * 0.9 + 4) / (1 + risk * (this.difficulty === 'hard' ? 2.3 : 1.4));
      else if (this.profile.id === 'mika') score = (seat * 1.15 + randomInt(8000) / 1000) / (1 + risk * (this.difficulty === 'hard' ? 1.25 : 0.7));
      else score = (seat * 1.35 + 2) / (1 + risk * (this.difficulty === 'hard' ? 1.8 : 0.9));
      if (ai.shocks >= this.rules.shockLimit - 1) score /= 1 + risk * 1.8;
      if (ai.score + seat >= this.rules.targetScore) score *= 1.75;
      return Math.max(0.01, score);
    });
  }

  async scheduleAi() {
    if (this.closed || this.state.phase === 'game_over') return;
    const isAiTurn = (this.state.phase === 'set_trap' && this.state.setterIndex === 1)
      || (this.state.phase === 'choose_seat' && this.state.sitterIndex === 1);
    if (!isAiTurn || this.busy) return;
    this.busy = true;
    this.emit();
    const base = this.difficulty === 'hard' ? 650 : (this.difficulty === 'normal' ? 900 : 1150);
    await delay(base + 200 + randomInt(500));
    this.busy = false;
    if (this.closed) return;
    if (this.state.phase === 'set_trap' && this.state.setterIndex === 1) await this.setTrap(this.aiTrapChoice(), 1);
    else if (this.state.phase === 'choose_seat' && this.state.sitterIndex === 1) await this.chooseSeat(this.aiSeatChoice(), 1);
  }

  close() {
    this.closed = true;
    this.callbacks.onConnection?.('offline');
  }
}

export function createLocalAiSession(options) {
  return new LocalAiSession(options);
}
