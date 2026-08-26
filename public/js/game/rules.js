export const PROTOCOL_VERSION = 'ecd-v1';
export const STANDARD_SEATS = Object.freeze(Array.from({ length: 12 }, (_, index) => index + 1));
export const MAX_TURNS = 15;
export const RESULT_HOLD_MS = 5000;
export const REVEAL_TIMEOUT_MS = 90000;

const CHALLENGE_RULES = Object.freeze({
  no_shock: { targetScore: 40, shockLimit: 3, seats: STANDARD_SEATS },
  six_turns: { targetScore: 40, shockLimit: 3, seats: STANDARD_SEATS },
  high_risk: { targetScore: 30, shockLimit: 2, seats: [7, 8, 9, 10, 11, 12] },
  sudden: { targetScore: 25, shockLimit: 1, seats: STANDARD_SEATS }
});

export function rulesFor(challengeId = null) {
  const selected = CHALLENGE_RULES[challengeId];
  return selected
    ? { targetScore: selected.targetScore, shockLimit: selected.shockLimit, seats: [...selected.seats] }
    : { targetScore: 40, shockLimit: 3, seats: [...STANDARD_SEATS] };
}

export function setterIndexFor(turnNumber, gameNumber = 1) {
  return (turnNumber + gameNumber) % 2 === 0 ? 0 : 1;
}

export function turnKey(turnNumber, setterIndex) {
  return `${setterIndex === 0 ? 'h' : 'g'}${String(turnNumber).padStart(6, '0')}`;
}

export function cleanName(value) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  return [...(cleaned || 'PLAYER')].slice(0, 16).join('');
}

export function isSeat(value, seats = STANDARD_SEATS) {
  return Number.isInteger(value) && seats.includes(value);
}
