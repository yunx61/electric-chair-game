import {
  get, getAuth, getDatabase, getApps, initializeApp, initializeAppCheck,
  onAuthStateChanged, onDisconnect, onValue, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider, ref,
  runTransaction, serverTimestamp, set, signInAnonymously
} from '../vendor/firebase.js';
import { createCommit, generateNonce } from '../game/commitment.js';
import { replayOnlineGame } from '../game/replay.js';
import { cleanName, matchKey, MAX_GAMES, PROTOCOL_VERSION, REVEAL_TIMEOUT_MS, ROOM_TTL_MS, turnKey } from '../game/rules.js';
import { loadPendingSecret, removePendingSecret, savePendingSecret } from '../storage/local-secrets.js';
import { appCheckProvider, appCheckSiteKey, loadFirebaseConfig } from './config.js';

const ROOM_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const FIREBASE_APP_NAME = 'electric-chair-duel-v4-1-0-final';
let sharedFirebase = null;

function randomId(bytes = 16) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  let binary = '';
  values.forEach(value => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function authReady(auth) {
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, user => {
      if (!user) return;
      stop();
      resolve(user);
    }, reject);
    if (!auth.currentUser) signInAnonymously(auth).catch(reject);
  });
}

export class OnlineSession {
  constructor(callbacks = {}) {
    Object.assign(this, {
      callbacks, app: null, auth: null, db: null, user: null, roomId: null, room: null,
      hostRoom: false, state: null, stopRoom: null, stopOffset: null, stopConnected: null,
      refreshTimer: null, timeoutTimer: null, roomExpiryTimer: null, disconnectTimer: null,
      renderVersion: 0, serverTimeOffset: 0, gameCreation: null, rematchCreation: null,
      revealInFlight: null, forfeitInFlight: null, disconnectInFlight: false,
      pendingAction: null, expiringRoom: false, closed: false, closePromise: null,
      connectionId: randomId(), presenceDisconnect: [], roomSlot: null
    });
  }

  async initialize() {
    if (!sharedFirebase) {
      const config = await loadFirebaseConfig();
      const app = getApps().find(candidate => candidate.name === FIREBASE_APP_NAME) || initializeApp(config, FIREBASE_APP_NAME);
      const siteKey = appCheckSiteKey();
      if (siteKey) {
        const Provider = appCheckProvider() === 'v3' ? ReCaptchaV3Provider : ReCaptchaEnterpriseProvider;
        initializeAppCheck(app, { provider: new Provider(siteKey), isTokenAutoRefreshEnabled: true });
      }
      sharedFirebase = { app, auth: getAuth(app), db: getDatabase(app) };
    }
    ({ app: this.app, auth: this.auth, db: this.db } = sharedFirebase);
    this.stopOffset = onValue(ref(this.db, '.info/serverTimeOffset'), snapshot => { this.serverTimeOffset = Number(snapshot.val()) || 0; });
    this.callbacks.onConnection?.('connecting');
    this.user = await authReady(this.auth);
    this.callbacks.onConnection?.('connected');
    return this;
  }

  async createRoom(name) {
    await this.cleanupStaleReservations();
    const roomId = randomId();
    const reservationRef = await this.reserveRoomSlot(roomId);
    try {
      await set(ref(this.db, `rooms/${roomId}`), {
        meta: { schemaVersion: 2, protocolVersion: PROTOCOL_VERSION, roomId, createdAt: serverTimestamp(), host: { uid: this.user.uid, name: cleanName(name) } }
      });
    } catch (error) {
      await set(reservationRef, null).catch(() => {});
      throw error;
    }
    this.hostRoom = true;
    await this.attach(roomId);
  }

  async cleanupStaleReservations() {
    const snapshot = await get(ref(this.db, `userRooms/${this.user.uid}`)).catch(() => null);
    const reservations = snapshot?.val() || {};
    await Promise.all(Object.keys(reservations).map(slot => set(ref(this.db, `userRooms/${this.user.uid}/${slot}`), null).catch(() => {})));
  }

  async reserveRoomSlot(roomId) {
    for (const slot of ['slot1', 'slot2', 'slot3']) {
      const slotRef = ref(this.db, `userRooms/${this.user.uid}/${slot}`);
      const result = await runTransaction(slotRef, current => current == null ? roomId : undefined, { applyLocally: false }).catch(() => null);
      if (result?.committed && result.snapshot.val() === roomId) { this.roomSlot = slot; return slotRef; }
    }
    throw new Error('作成できる有効ルームは3件までです');
  }

  async joinRoom(roomId, name) {
    const normalized = String(roomId || '').trim();
    if (!ROOM_PATTERN.test(normalized)) throw new Error('22文字の招待コードを入力してください');
    const guestRef = ref(this.db, `rooms/${normalized}/meta/guest`);
    const result = await runTransaction(guestRef, current => {
      if (current == null) return { uid: this.user.uid, name: cleanName(name), protocolVersion: PROTOCOL_VERSION, joinedAt: serverTimestamp() };
      if (current.uid === this.user.uid) return current;
      return;
    }, { applyLocally: false });
    if (!result.committed || result.snapshot.val()?.uid !== this.user.uid) throw new Error('このルームには参加できません（満員・期限切れ・旧バージョンの可能性があります）');
    this.hostRoom = false;
    await this.attach(normalized);
  }

  async resume(roomId) {
    if (!ROOM_PATTERN.test(String(roomId || ''))) throw new Error('再接続情報が無効です');
    await this.attach(roomId);
  }

  async attach(roomId) {
    this.roomId = roomId;
    try { localStorage.setItem('ec_session', JSON.stringify({ roomId })); } catch {}
    this.stopConnected?.();
    this.stopConnected = onValue(ref(this.db, '.info/connected'), snapshot => {
      if (snapshot.val() !== true || this.closed) { this.callbacks.onConnection?.('reconnecting'); return; }
      this.registerPresence().catch(error => this.callbacks.onError?.(error.message || '接続状態を更新できません'));
    });
    this.stopRoom?.();
    this.stopRoom = onValue(ref(this.db, `rooms/${roomId}`), snapshot => {
      if (!snapshot.exists()) { if (!this.expiringRoom) this.callbacks.onError?.('ルームが見つかりません'); return; }
      this.room = snapshot.val();
      if (this.room?.meta?.protocolVersion !== PROTOCOL_VERSION) { this.callbacks.onError?.('旧バージョンのルームです。新しく作り直してください'); return; }
      this.hostRoom = this.room.meta.host?.uid === this.user.uid;
      const expiresIn = Number(this.room.meta.createdAt) + ROOM_TTL_MS - this.serverNow();
      clearTimeout(this.roomExpiryTimer);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) { this.expireRoom(); return; }
      this.roomExpiryTimer = setTimeout(() => this.expireRoom(), expiresIn + 50);
      this.ensureGame().catch(error => this.callbacks.onError?.(error.message));
      this.ensureRematch().catch(error => this.callbacks.onError?.(error.message));
      this.refreshState().catch(error => this.callbacks.onError?.(error.message));
    }, error => { this.callbacks.onConnection?.('offline'); this.callbacks.onError?.(error.message || '同期に失敗しました'); });
    this.callbacks.onSession?.({ roomId });
  }

  async registerPresence() {
    const connectionRef = ref(this.db, `rooms/${this.roomId}/presence/${this.user.uid}/connections/${this.connectionId}`);
    const changedRef = ref(this.db, `rooms/${this.roomId}/presence/${this.user.uid}/lastChanged`);
    const disconnectConnection = onDisconnect(connectionRef);
    const disconnectChanged = onDisconnect(changedRef);
    await disconnectConnection.remove();
    await disconnectChanged.set(serverTimestamp());
    this.presenceDisconnect = [disconnectConnection, disconnectChanged];
    try { await set(connectionRef, { at: serverTimestamp() }); }
    catch (error) {
      const existing = await get(connectionRef).catch(() => null);
      if (!existing?.exists()) throw error;
    }
    await set(changedRef, serverTimestamp());
    this.callbacks.onConnection?.('connected');
  }

  async ensureGame() {
    if (!this.room?.meta?.guest || this.room.game?.matches?.m000001?.meta) return;
    if (!this.hostRoom || this.gameCreation) return this.gameCreation;
    this.gameCreation = (async () => {
      await set(ref(this.db, `rooms/${this.roomId}/game/matches/m000001/meta`), { schemaVersion: 2, gameNumber: 1, matchId: randomId(), createdAt: serverTimestamp() });
      await set(ref(this.db, `rooms/${this.roomId}/game/currentKey`), 'm000001');
    })().finally(() => { this.gameCreation = null; });
    return this.gameCreation;
  }

  async ensureRematch() {
    if (!this.hostRoom || this.rematchCreation || this.state?.phase !== 'game_over') return;
    const nextNumber = Number(this.state.gameNumber) + 1;
    if (nextNumber > MAX_GAMES) return;
    const nextKey = matchKey(nextNumber);
    const votes = this.room?.game?.rematchVotes?.[nextKey] || {};
    const hostUid = this.room.meta.host.uid;
    const guestUid = this.room.meta.guest.uid;
    if (!votes[hostUid] || !votes[guestUid] || this.room.game?.matches?.[nextKey]?.meta) return;
    this.rematchCreation = (async () => {
      await set(ref(this.db, `rooms/${this.roomId}/game/matches/${nextKey}/meta`), { schemaVersion: 2, gameNumber: nextNumber, matchId: randomId(), createdAt: serverTimestamp() });
      await set(ref(this.db, `rooms/${this.roomId}/game/currentKey`), nextKey);
    })().finally(() => { this.rematchCreation = null; });
    return this.rematchCreation;
  }

  async refreshState() {
    const version = ++this.renderVersion;
    const state = await replayOnlineGame({ roomId: this.roomId, room: this.room, uid: this.user.uid, now: this.serverNow() });
    if (this.closed || version !== this.renderVersion) return;
    this.state = state;
    const pending = this.pendingAction;
    if (pending && (pending.matchId !== state.matchId || pending.turnNumber !== state.turnNumber || (pending.type === 'set_trap' && state.phase !== 'set_trap') || (pending.type === 'choose_seat' && state.phase !== 'choose_seat'))) this.pendingAction = null;
    state.clockOffset = this.serverTimeOffset;
    this.callbacks.onState?.(state);
    this.scheduleDerivedRefresh(state);
    await this.maybeReveal(state);
    await this.maybeForfeit(state);
    await this.maybeDisconnectForfeit(state);
  }

  scheduleDerivedRefresh(state) {
    clearTimeout(this.refreshTimer); clearTimeout(this.timeoutTimer); clearTimeout(this.disconnectTimer);
    if (state.phase === 'result' && state.resultUntil) this.refreshTimer = setTimeout(() => this.refreshState().catch(() => {}), Math.max(0, state.resultUntil - this.serverNow()) + 20);
    if (state.phase === 'reveal_wait' && state.revealDeadline) this.timeoutTimer = setTimeout(() => this.refreshState().catch(() => {}), Math.max(0, state.revealDeadline - this.serverNow()) + 50);
    if (state.disconnectDeadline && state.phase !== 'game_over') this.disconnectTimer = setTimeout(() => this.refreshState().catch(() => {}), Math.max(0, state.disconnectDeadline - this.serverNow()) + 50);
  }

  async maybeReveal(state) {
    if (state.phase !== 'reveal_wait' || state.you !== state.setterIndex) return;
    const secret = loadPendingSecret(this.roomId, state.matchId, state.turnNumber, state.commitHash);
    if (!secret) { this.callbacks.onError?.('公開用データを復元できません。相手側でタイムアウト終了になります'); return; }
    const key = turnKey(state.turnNumber, state.setterIndex);
    if (this.revealInFlight === key) return;
    this.revealInFlight = key;
    try {
      await set(ref(this.db, `rooms/${this.roomId}/game/matches/${state.matchKey}/turns/${key}/reveal`), { uid: this.user.uid, seat: secret.seat, nonce: secret.nonce, at: serverTimestamp() });
      removePendingSecret(this.roomId, state.matchId, state.turnNumber, state.commitHash);
    } catch (error) { this.callbacks.onError?.(error.message || '結果を公開できませんでした'); }
    finally { if (this.revealInFlight === key) this.revealInFlight = null; }
  }

  async maybeForfeit(state) {
    if (state.phase !== 'reveal_wait' || state.you !== state.sitterIndex || this.serverNow() < state.revealDeadline) return;
    const key = turnKey(state.turnNumber, state.setterIndex);
    if (this.forfeitInFlight === key) return;
    this.forfeitInFlight = key;
    try { await set(ref(this.db, `rooms/${this.roomId}/game/matches/${state.matchKey}/turns/${key}/forfeit`), { uid: this.user.uid, reason: 'reveal_timeout', at: serverTimestamp() }); }
    catch (error) { if (!String(error?.code || '').includes('PERMISSION_DENIED')) this.callbacks.onError?.('タイムアウト処理に失敗しました'); }
    finally { if (this.forfeitInFlight === key) this.forfeitInFlight = null; }
  }

  async maybeDisconnectForfeit(state) {
    if (!state.disconnectClaimable || state.phase === 'game_over' || this.disconnectInFlight) return;
    this.disconnectInFlight = true;
    const opponentUid = this.room.meta.host.uid === this.user.uid ? this.room.meta.guest.uid : this.room.meta.host.uid;
    try { await set(ref(this.db, `rooms/${this.roomId}/game/disconnectForfeits/${state.matchKey}/${this.user.uid}`), { uid: this.user.uid, opponentUid, reason: 'disconnect_timeout', at: serverTimestamp() }); }
    catch (error) { if (!String(error?.code || '').includes('PERMISSION_DENIED')) this.callbacks.onError?.('切断判定を確定できませんでした'); }
    finally { this.disconnectInFlight = false; }
  }

  async action(message) {
    if (!this.state || !this.roomId) throw new Error('対戦を同期中です');
    if (message.type === 'set_trap') return this.withActionLock(() => this.setTrap(message.seat));
    if (message.type === 'choose_seat') return this.withActionLock(() => this.chooseSeat(message.seat));
    if (message.type === 'rematch_vote') return this.voteRematch();
    if (message.type === 'leave') return this.leave();
  }

  async withActionLock(task) {
    if (!navigator.locks?.request) return task();
    const lockName = `ecd:${this.roomId}:${this.state.matchId}:${this.state.turnNumber}:${this.user.uid}`;
    let acquired = false;
    const result = await navigator.locks.request(lockName, { ifAvailable: true }, lock => {
      if (!lock) return null;
      acquired = true;
      return task();
    });
    if (!acquired) throw new Error('別のタブで同じターンを操作中です');
    return result;
  }

  async setTrap(seat) {
    const state = this.state;
    if (!state.canSetTrap || !state.remainingSeats.includes(seat)) throw new Error('今はそのイスに仕掛けられません');
    if (this.pendingAction) throw new Error('直前の操作を送信中です');
    const action = { type: 'set_trap', matchId: state.matchId, turnNumber: state.turnNumber };
    this.pendingAction = action;
    let hash = null;
    try {
      const nonce = generateNonce();
      const secret = { roomId: this.roomId, matchId: state.matchId, turnNumber: state.turnNumber, seat, nonce };
      hash = await createCommit({ ...secret, trapperUid: this.user.uid });
      savePendingSecret({ ...secret, commitHash: hash });
      const key = turnKey(state.turnNumber, state.setterIndex);
      await set(ref(this.db, `rooms/${this.roomId}/game/matches/${state.matchKey}/turns/${key}/commit`), { uid: this.user.uid, hash, at: serverTimestamp() });
    } catch (error) {
      if (this.pendingAction === action) this.pendingAction = null;
      if (hash) removePendingSecret(this.roomId, state.matchId, state.turnNumber, hash);
      throw error;
    }
  }

  async chooseSeat(seat) {
    const state = this.state;
    if (!state.canChooseSeat || !state.remainingSeats.includes(seat)) throw new Error('今はそのイスを選べません');
    if (this.pendingAction) throw new Error('直前の操作を送信中です');
    const action = { type: 'choose_seat', matchId: state.matchId, turnNumber: state.turnNumber };
    this.pendingAction = action;
    try {
      const key = turnKey(state.turnNumber, state.setterIndex);
      await set(ref(this.db, `rooms/${this.roomId}/game/matches/${state.matchKey}/turns/${key}/choice`), { uid: this.user.uid, seat, at: serverTimestamp() });
    } catch (error) { if (this.pendingAction === action) this.pendingAction = null; throw error; }
  }

  async voteRematch() {
    if (this.state.phase !== 'game_over') throw new Error('対戦終了後に再戦できます');
    if (this.state.gameNumber >= MAX_GAMES) throw new Error('同じルームでは10試合までです');
    const nextKey = matchKey(this.state.gameNumber + 1);
    await set(ref(this.db, `rooms/${this.roomId}/game/rematchVotes/${nextKey}/${this.user.uid}`), { uid: this.user.uid, at: serverTimestamp() });
  }

  async leave() {
    if (this.state?.matchKey && this.state.phase !== 'waiting' && this.state.phase !== 'game_over') {
      await set(ref(this.db, `rooms/${this.roomId}/game/leaves/${this.state.matchKey}/${this.user.uid}`), { uid: this.user.uid, at: serverTimestamp() }).catch(() => {});
    }
    return this.close();
  }

  serverNow() { return Date.now() + this.serverTimeOffset; }

  expireRoom() {
    if (this.expiringRoom || this.closed) return;
    this.expiringRoom = true;
    clearTimeout(this.roomExpiryTimer);
    this.stopRoom?.(); this.stopRoom = null;
    try { localStorage.removeItem('ec_session'); } catch {}
    this.removeRoomAndReservation().catch(() => {});
    this.callbacks.onConnection?.('offline'); this.callbacks.onExpired?.();
  }

  async removeRoomAndReservation() {
    await set(ref(this.db, `rooms/${this.roomId}`), null);
    if (!this.hostRoom) return;
    const snapshot = await get(ref(this.db, `userRooms/${this.user.uid}`)).catch(() => null);
    const reservations = snapshot?.val() || {};
    const slot = this.roomSlot || Object.keys(reservations).find(key => reservations[key] === this.roomId);
    if (slot) await set(ref(this.db, `userRooms/${this.user.uid}/${slot}`), null).catch(() => {});
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  async finishClose() {
    this.closed = true;
    [this.refreshTimer, this.timeoutTimer, this.roomExpiryTimer, this.disconnectTimer].forEach(clearTimeout);
    this.stopRoom?.(); this.stopRoom = null; this.stopOffset?.(); this.stopOffset = null; this.stopConnected?.(); this.stopConnected = null;
    await Promise.all(this.presenceDisconnect.map(handle => handle.cancel().catch(() => {})));
    if (this.db && this.roomId && this.user && !this.expiringRoom) {
      const createdAt = Number(this.room?.meta?.createdAt);
      const expired = Number.isFinite(createdAt) && createdAt + ROOM_TTL_MS <= this.serverNow();
      const hasMoves = Object.values(this.room?.game?.matches || {}).some(match => match?.turns);
      const canRemovePreMove = this.hostRoom && !hasMoves;
      if (expired || canRemovePreMove) await this.removeRoomAndReservation().catch(() => {});
      else {
        await set(ref(this.db, `rooms/${this.roomId}/presence/${this.user.uid}/connections/${this.connectionId}`), null).catch(() => {});
        await set(ref(this.db, `rooms/${this.roomId}/presence/${this.user.uid}/lastChanged`), serverTimestamp()).catch(() => {});
      }
    }
    this.callbacks.onConnection?.('offline');
  }
}

export async function createOnlineSession(callbacks) { return new OnlineSession(callbacks).initialize(); }
export { ROOM_PATTERN, REVEAL_TIMEOUT_MS };
