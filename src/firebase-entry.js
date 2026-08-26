export { getApp, getApps, initializeApp } from 'firebase/app';
export { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
export {
  getDatabase,
  get,
  onDisconnect,
  onValue,
  ref,
  runTransaction,
  serverTimestamp,
  set
} from 'firebase/database';
export { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
