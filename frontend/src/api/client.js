// Thin fetch wrapper around the backend API (../../backend). Keeps a single
// place that knows about the base URL, bearer token, and error shape
// (backend/src/utils/errors.js: { error: { code, message } }).
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
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
    throw new ApiError(res.status, err ? err.code : 'error', err ? err.message : 'Something went wrong.');
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
    throw new ApiError(res.status, err ? err.code : 'error', err ? err.message : 'Something went wrong.');
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
export function login(email, password) {
  return request('POST', '/auth/login', { email: email, password: password });
}

// kernel.js: handlers['auth.logout']
export function logout() {
  return request('POST', '/auth/logout');
}

// kernel.js: api.currentContext()
export function getMe() {
  return request('GET', '/me');
}
