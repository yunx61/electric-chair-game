import {
  getAuth,
  getDatabase,
  getApp,
  getApps,
  initializeApp,
  initializeAppCheck,
  onAuthStateChanged,
  onDisconnect,
  onValue,
  ReCaptchaV3Provider,
  ref,
  runTransaction,
  serverTimestamp,
  set,
  signInAnonymously
} from '../vendor/firebase.js';
import { createCommit, generateNonce } from '../game/commitment.js';
import { replayOnlineGame } from '../game/replay.js';
import { cleanName, REVEAL_TIMEOUT_MS, ROOM_TTL_MS, turnKey } from '../game/rules.js';
import { loadPendingSecret, removePendingSecret, savePendingSecret } from '../storage/local-secrets.js';
import { appCheckSiteKey, loadFirebaseConfig } from './config.js';

const ROOM_PATTERN = /^[A-Za-z0-9_-]{22}$/;
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
    this.callbacks = callbacks;
    this.app = null;
    this.auth = null;
    this.db = null;
    this.user = null;
    this.roomId = null;
    this.room = null;
    this.hostRoom = false;
    this.state = null;
    this.stopRoom = null;
    this.refreshTimer = null;
    this.timeoutTimer = null;
    this.roomExpiryTimer = null;
    this.renderVersion = 0;
    this.serverTimeOffset = 0;
    this.stopOffset = null;
    this.gameCreation = null;
    this.revealInFlight = null;
    this.forfeitInFlight = null;
    this.pendingAction = null;
    this.expiringRoom = false;
    this.closed = false;
  }

  async initialize() {
    if (!sharedFirebase) {
      const config = await loadFirebaseConfig();
      const app = getApps().length ? getApp() : initializeApp(config);
      const siteKey = appCheckSiteKey();
      if (siteKey) initializeAppCheck(app, { provider: new ReCaptchaV3Provider(siteKey), isTokenAutoRefreshEnabled: true });
      sharedFirebase = { app, auth: getAuth(app), db: getDatabase(app) };
    }
    ({ app: this.app, auth: this.auth, db: this.db } = sharedFirebase);
    this.stopOffset = onValue(ref(this.db, '.info/serverTimeOffset'), snapshot => {
      this.serverTimeOffset = Number(snapshot.val()) || 0;
    });
    this.callbacks.onConnection?.('connecting');
    this.user = await authReady(this.auth);
    this.callbacks.onConnection?.('connected');
    return this;
  }

  async createRoom(name) {
    const roomId = randomId();
    const roomRef = ref(this.db, `rooms/${roomId}`);
    await set(roomRef, {
      meta: {
        schemaVersion: 1,
        roomId,
        createdAt: serverTimestamp(),
        host: { uid: this.user.uid, name: cleanName(name) }
      }
    });
    this.hostRoom = true;
    await this.attach(roomId);
  }

  async joinRoom(roomId, name) {
    const normalized = String(roomId || '').trim();
    if (!ROOM_PATTERN.test(normalized)) throw new Error('22文字の招待コードを入力してください');
    const guestRef = ref(this.db, `rooms/${normalized}/meta/guest`);
    const result = await runTransaction(guestRef, current => {
      if (current == null) return { uid: this.user.uid, name: cleanName(name), joinedAt: serverTimestamp() };
      if (current.uid === this.user.uid) return current;
      return;
    }, { applyLocally: false });
    if (!result.committed || result.snapshot.val()?.uid !== this.user.uid) {
      throw new Error('このルームには参加できません');
    }
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
    const presenceRef = ref(this.db, `rooms/${roomId}/presence/${this.user.uid}`);
    await onDisconnect(presenceRef).set({ state: 'offline', lastChanged: serverTimestamp() });
    await set(presenceRef, { state: 'online', lastChanged: serverTimestamp() });
    this.stopRoom?.();
    this.stopRoom = onValue(ref(this.db, `rooms/${roomId}`), snapshot => {
      if (!snapshot.exists()) {
        if (!this.expiringRoom) this.callbacks.onError?.('ルームが見つかりません');
        return;
      }
      this.room = snapshot.val();
      this.hostRoom = this.room?.meta?.host?.uid === this.user.uid;
      const expiresIn = Number(this.room?.meta?.createdAt) + ROOM_TTL_MS - this.serverNow();
      clearTimeout(this.roomExpiryTimer);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
        this.expireRoom();
        return;
      }
      this.roomExpiryTimer = setTimeout(() => this.expireRoom(), expiresIn + 50);
      this.ensureGame().catch(error => this.callbacks.onError?.(error.message));
      this.refreshState().catch(error => this.callbacks.onError?.(error.message));
    }, error => {
      this.callbacks.onConnection?.('offline');
      this.callbacks.onError?.(error.message || '同期に失敗しました');
    });
    this.callbacks.onSession?.({ roomId });
  }

  async ensureGame() {
    if (!this.room?.meta?.guest || this.room.game?.meta) return;
    if (this.user.uid !== this.room.meta.host.uid) return;
    if (!this.gameCreation) {
      const matchId = randomId();
      this.gameCreation = set(ref(this.db, `rooms/${this.roomId}/game/meta`), {
        schemaVersion: 1,
        matchId,
        createdAt: serverTimestamp()
      }).finally(() => { this.gameCreation = null; });
    }
    await this.gameCreation;
  }

  async refreshState() {
    const version = ++this.renderVersion;
    const state = await replayOnlineGame({
      roomId: this.roomId,
      room: this.room,
      uid: this.user.uid,
      now: this.serverNow()
    });
    if (this.closed || version !== this.renderVersion) return;
    this.state = state;
    const pending = this.pendingAction;
    if (pending && (
      pending.matchId !== state.matchId
      || pending.turnNumber !== state.turnNumber
      || (pending.type === 'set_trap' && state.phase !== 'set_trap')
      || (pending.type === 'choose_seat' && state.phase !== 'choose_seat')
    )) this.pendingAction = null;
    state.clockOffset = this.serverTimeOffset;
    this.callbacks.onConnection?.('connected');
    this.callbacks.onState?.(state);
    this.scheduleDerivedRefresh(state);
    await this.maybeReveal(state);
    await this.maybeForfeit(state);
  }

  scheduleDerivedRefresh(state) {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.timeoutTimer);
    if (state.phase === 'result' && state.resultUntil) {
      this.refreshTimer = setTimeout(() => this.refreshState().catch(() => {}), Math.max(0, state.resultUntil - this.serverNow()) + 20);
    }
    if (state.phase === 'reveal_wait' && state.revealDeadline) {
      this.timeoutTimer = setTimeout(() => this.refreshState().catch(() => {}), Math.max(0, state.revealDeadline - this.serverNow()) + 50);
    }
  }

  async maybeReveal(state) {
    if (state.phase !== 'reveal_wait' || state.you !== state.setterIndex) return;
    const secret = loadPendingSecret(this.roomId, state.matchId, state.turnNumber);
    if (!secret) {
      this.callbacks.onError?.('公開用データを復元できません。相手側でタイムアウト終了になります');
      return;
    }
    const key = turnKey(state.turnNumber, state.setterIndex);
    if (this.revealInFlight === key) return;
    this.revealInFlight = key;
    try {
      await set(ref(this.db, `rooms/${this.roomId}/game/turns/${key}/reveal`), {
        uid: this.user.uid,
        seat: secret.seat,
        nonce: secret.nonce,
        at: serverTimestamp()
      });
      removePendingSecret(this.roomId, state.matchId, state.turnNumber);
    } catch (error) {
      this.callbacks.onError?.(error.message || '結果を公開できませんでした');
    } finally {
      if (this.revealInFlight === key) this.revealInFlight = null;
    }
  }

  async maybeForfeit(state) {
    if (state.phase !== 'reveal_wait' || state.you !== state.sitterIndex || this.serverNow() < state.revealDeadline) return;
    const key = turnKey(state.turnNumber, state.setterIndex);
    if (this.forfeitInFlight === key) return;
    this.forfeitInFlight = key;
    try {
      await set(ref(this.db, `rooms/${this.roomId}/game/turns/${key}/forfeit`), {
        uid: this.user.uid,
        reason: 'reveal_timeout',
        at: serverTimestamp()
      });
    } catch (error) {
      if (!String(error?.code || '').includes('PERMISSION_DENIED')) this.callbacks.onError?.('タイムアウト処理に失敗しました');
    } finally {
      if (this.forfeitInFlight === key) this.forfeitInFlight = null;
    }
  }

  async action(message) {
    if (!this.state || !this.roomId) throw new Error('対戦を同期中です');
    if (message.type === 'set_trap') return this.setTrap(message.seat);
    if (message.type === 'choose_seat') return this.chooseSeat(message.seat);
    if (message.type === 'rematch_vote') {
      this.callbacks.onError?.('ONLINEの再戦は新しい招待ルームで行ってください');
      return;
    }
    if (message.type === 'leave') return this.close();
  }

  serverNow() {
    return Date.now() + this.serverTimeOffset;
  }

  expireRoom() {
    if (this.expiringRoom || this.closed) return;
    this.expiringRoom = true;
    clearTimeout(this.roomExpiryTimer);
    this.stopRoom?.();
    this.stopRoom = null;
    try { localStorage.removeItem('ec_session'); } catch {}
    set(ref(this.db, `rooms/${this.roomId}`), null).catch(() => {});
    this.callbacks.onConnection?.('offline');
    this.callbacks.onExpired?.();
  }

  async setTrap(seat) {
    const state = this.state;
    if (!state.canSetTrap || !state.remainingSeats.includes(seat)) throw new Error('今はそのイスに仕掛けられません');
    if (this.pendingAction) throw new Error('直前の操作を送信中です');
    const action = { type: 'set_trap', matchId: state.matchId, turnNumber: state.turnNumber };
    this.pendingAction = action;
    try {
      const nonce = generateNonce();
      const secret = { roomId: this.roomId, matchId: state.matchId, turnNumber: state.turnNumber, seat, nonce };
      const hash = await createCommit({ ...secret, trapperUid: this.user.uid });
      savePendingSecret({ ...secret, commitHash: hash });
      const key = turnKey(state.turnNumber, state.setterIndex);
      await set(ref(this.db, `rooms/${this.roomId}/game/turns/${key}/commit`), {
        uid: this.user.uid,
        hash,
        at: serverTimestamp()
      });
    } catch (error) {
      if (this.pendingAction === action) this.pendingAction = null;
      removePendingSecret(this.roomId, state.matchId, state.turnNumber);
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
      await set(ref(this.db, `rooms/${this.roomId}/game/turns/${key}/choice`), {
        uid: this.user.uid,
        seat,
        at: serverTimestamp()
      });
    } catch (error) {
      if (this.pendingAction === action) this.pendingAction = null;
      throw error;
    }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.timeoutTimer);
    clearTimeout(this.roomExpiryTimer);
    this.stopRoom?.();
    this.stopRoom = null;
    this.stopOffset?.();
    this.stopOffset = null;
    if (this.db && this.roomId && this.user && !this.expiringRoom) {
      const createdAt = Number(this.room?.meta?.createdAt);
      const expired = Number.isFinite(createdAt) && createdAt + ROOM_TTL_MS <= this.serverNow();
      const canRemovePreMove = this.hostRoom && !this.room?.game?.turns;
      if (expired || canRemovePreMove) {
        await set(ref(this.db, `rooms/${this.roomId}`), null).catch(() => {});
      } else {
        await set(ref(this.db, `rooms/${this.roomId}/presence/${this.user.uid}`), {
          state: 'offline',
          lastChanged: serverTimestamp()
        }).catch(() => {});
      }
    }
    this.callbacks.onConnection?.('offline');
  }
}

export async function createOnlineSession(callbacks) {
  return new OnlineSession(callbacks).initialize();
}

export { ROOM_PATTERN, REVEAL_TIMEOUT_MS };
