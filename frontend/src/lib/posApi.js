import { API_URL, ApiError } from '../api/client';
import { tr } from './i18n.jsx';

// Calls to the restaurant till's API (/api/pos), signed with a till
// session token rather than a user's sign-in: the till (/pos) and the
// kitchen screen (/kds) are opened with a staff PIN, not an account.
export async function posFetch(method, path, token, body) {
  var headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  var res = await fetch(API_URL + path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  var text = await res.text();
  var data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    var err = data && data.error;
    throw new ApiError(res.status, err ? err.code : 'error', err ? err.message : tr('Something went wrong.'));
  }
  return data;
}
