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
import { cleanName, REVEAL_TIMEOUT_MS, turnKey } from '../game/rules.js';
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
    this.state = null;
    this.stopRoom = null;
    this.refreshTimer = null;
    this.timeoutTimer = null;
    this.renderVersion = 0;
    this.serverTimeOffset = 0;
    this.stopOffset = null;
    this.gameCreation = null;
    this.revealInFlight = null;
    this.forfeitInFlight = null;
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
        this.callbacks.onError?.('ルームが見つかりません');
        return;
      }
      this.room = snapshot.val();
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

  async setTrap(seat) {
    const state = this.state;
    if (!state.canSetTrap || !state.remainingSeats.includes(seat)) throw new Error('今はそのイスに仕掛けられません');
    const nonce = generateNonce();
    const secret = { roomId: this.roomId, matchId: state.matchId, turnNumber: state.turnNumber, seat, nonce };
    const hash = await createCommit({ ...secret, trapperUid: this.user.uid });
    savePendingSecret({ ...secret, commitHash: hash });
    const key = turnKey(state.turnNumber, state.setterIndex);
    try {
      await set(ref(this.db, `rooms/${this.roomId}/game/turns/${key}/commit`), {
        uid: this.user.uid,
        hash,
        at: serverTimestamp()
      });
    } catch (error) {
      removePendingSecret(this.roomId, state.matchId, state.turnNumber);
      throw error;
    }
  }

  async chooseSeat(seat) {
    const state = this.state;
    if (!state.canChooseSeat || !state.remainingSeats.includes(seat)) throw new Error('今はそのイスを選べません');
    const key = turnKey(state.turnNumber, state.setterIndex);
    await set(ref(this.db, `rooms/${this.roomId}/game/turns/${key}/choice`), {
      uid: this.user.uid,
      seat,
      at: serverTimestamp()
    });
  }

  async close() {
    this.closed = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.timeoutTimer);
    this.stopRoom?.();
    this.stopRoom = null;
    this.stopOffset?.();
    this.stopOffset = null;
    if (this.db && this.roomId && this.user) {
      set(ref(this.db, `rooms/${this.roomId}/presence/${this.user.uid}`), {
        state: 'offline',
        lastChanged: serverTimestamp()
      }).catch(() => {});
    }
    this.callbacks.onConnection?.('offline');
  }
}

export async function createOnlineSession(callbacks) {
  return new OnlineSession(callbacks).initialize();
}

export { ROOM_PATTERN, REVEAL_TIMEOUT_MS };
