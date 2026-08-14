/* Junkyard Olympics — shared login across the bracket site and the jukebox.
   Sessions live in a cookie on .junkyardolympics.com so one login works on
   both sites. Accounts/passwords are managed by the music worker's user db. */
'use strict';

const Auth = (() => {
  const AUTH_URL = localStorage.getItem('ba-auth-url') || 'https://music.junkyardolympics.com';
  const KEY = 'jo-auth';

  function readCookie() {
    const m = document.cookie.match(/(?:^|;\s*)jo_auth=([^;]+)/);
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
  }

  let session = readCookie() || JSON.parse(localStorage.getItem(KEY) || 'null');

  function persist() {
    localStorage.setItem(KEY, JSON.stringify(session));
    const v = encodeURIComponent(JSON.stringify(session));
    const base = `jo_auth=${v}; path=/; max-age=604800; SameSite=Lax`;
    document.cookie = base;
    if (location.hostname.endsWith('junkyardolympics.com')) {
      document.cookie = base + '; domain=.junkyardolympics.com';
    }
  }

  async function login(name, password) {
    const res = await fetch(AUTH_URL + '/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'login failed');
    session = { token: d.token, name: d.user.name, role: d.user.role || 'guest' };
    persist();
    return session;
  }

  function logout() {
    session = null;
    localStorage.removeItem(KEY);
    document.cookie = 'jo_auth=; path=/; max-age=0';
    if (location.hostname.endsWith('junkyardolympics.com')) {
      document.cookie = 'jo_auth=; path=/; max-age=0; domain=.junkyardolympics.com';
    }
  }

  return {
    login, logout,
    get ok() { return !!session; },
    get name() { return session ? session.name : ''; },
    get role() { return session ? session.role : 'guest'; },
    get isHost() { return !!session && session.role === 'host'; },
    get token() { return session ? session.token : ''; },
  };
})();
