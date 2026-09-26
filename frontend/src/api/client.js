import { tr } from '../lib/i18n.jsx';
// Thin fetch wrapper around the backend API (../../backend). Keeps a single
// place that knows about the base URL, bearer token, and error shape
// (backend/src/utils/errors.js: { error: { code, message } }).
// Exported for the restaurant POS page (RestaurantPosPage.jsx), which
// can't use the `api` object below for its own /pos/* calls — that object
// always injects whatever user token happens to be in localStorage
// (TOKEN_KEY), but a POS till has its own separate, unattended-device
// session token (see restaurantPos.service.js) that has to win instead.
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
// The server origin without the trailing /api — for plain <img src> tags
// pointed at a public, unauthenticated route like /api/menu-photos/:id
// (restaurant menu item photos), which are relative to the API server,
// not the Vite dev server the frontend itself is served from.
export const API_ORIGIN = API_URL.replace(/\/api\/?$/, '');
const TOKEN_KEY = 'bamboo.token';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(method, path, body) {
  var headers = {};
  var token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  var res = await fetch(API_URL + path, {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  var data = null;
  var text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (!res.ok) {
    var err = data && data.error;
    throw new ApiError(res.status, err ? err.code : 'error', err ? err.message : tr('Something went wrong.'));
  }
  return data;
}

async function upload(path, formData) {
  var headers = {};
  var token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;

  var res = await fetch(API_URL + path, { method: 'POST', headers: headers, body: formData });
  var text = await res.text();
  var data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    var err = data && data.error;
    throw new ApiError(res.status, err ? err.code : 'error', err ? err.message : tr('Something went wrong.'));
  }
  return data;
}

export const api = {
  get: function (path) { return request('GET', path); },
  post: function (path, body) { return request('POST', path, body === undefined ? {} : body); },
  patch: function (path, body) { return request('PATCH', path, body === undefined ? {} : body); },
  put: function (path, body) { return request('PUT', path, body === undefined ? {} : body); },
  del: function (path) { return request('DELETE', path); },
  upload: upload
};

// kernel.js: handlers['auth.login']
// deviceToken: this browser's "don't ask again" token for two-step sign-in,
// if it has one for this email. The answer is either a session, or
// { twoStepRequired, challenge } — then verifyLogin() with the code.
export function login(email, password, deviceToken) {
  return request('POST', '/auth/login', { email: email, password: password, deviceToken: deviceToken || undefined });
}

// "Text me a code" / "Email me a code" during the two-step sign-in
// (channel 'sms' | 'email') -> { sentTo: '•••• 3456', channel }
export function sendLoginCode(challenge, channel) {
  return request('POST', '/auth/login/send-code', { challenge: challenge, channel: channel });
}

export function verifyLogin(challenge, code, rememberDevice) {
  return request('POST', '/auth/login/verify', { challenge: challenge, code: code, rememberDevice: !!rememberDevice });
}

// "Forgot your password?" — a code to the account's address -> { channel,
// sentTo, expiresInMinutes }; then the code and a new password.
export function forgotPassword(email) {
  return request('POST', '/auth/password/forgot', { email: email });
}
export function resetPassword(email, code, newPassword) {
  return request('POST', '/auth/password/reset', { email: email, code: code, newPassword: newPassword });
}

// kernel.js: handlers['auth.logout']
export function logout() {
  return request('POST', '/auth/logout');
}

// kernel.js: api.currentContext()
export function getMe() {
  return request('GET', '/me');
}
