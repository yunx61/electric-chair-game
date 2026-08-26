export async function loadFirebaseConfig() {
  if (globalThis.__FIREBASE_CONFIG__ && typeof globalThis.__FIREBASE_CONFIG__ === 'object') {
    return globalThis.__FIREBASE_CONFIG__;
  }
  const response = await fetch('/__/firebase/init.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Firebase Hostingの設定を取得できません');
  const config = await response.json();
  if (!config?.apiKey || !config?.projectId || !config?.databaseURL) {
    throw new Error('Firebaseプロジェクトの設定が不足しています');
  }
  return config;
}

export function appCheckSiteKey() {
  return typeof globalThis.__APP_CHECK_SITE_KEY__ === 'string'
    ? globalThis.__APP_CHECK_SITE_KEY__.trim()
    : '';
}
