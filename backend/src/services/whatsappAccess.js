var { pool } = require('../db/pool');
var config = require('../config');

// Which WhatsApp number the OS uses, and with what token: the one connected
// from Integrations (Embedded Signup, saved in whatsapp_connection) when
// there is one, else WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN from
// Render. Kept in memory (loaded at start and after every connect or
// disconnect) so callers that can't wait — the Integrations list — can ask.
var row = null;

async function load() {
  try { row = (await pool.query('SELECT * FROM whatsapp_connection WHERE id = 1')).rows[0] || null; } catch (e) { row = null; }
  return get();
}

function get() {
  if (row) return { source: 'connect', phoneNumberId: row.phone_number_id, wabaId: row.waba_id, token: row.access_token, displayPhone: row.display_phone, coexistence: row.coexistence };
  var w = config.whatsapp;
  if (w.phoneNumberId && w.accessToken) return { source: 'env', phoneNumberId: w.phoneNumberId, wabaId: w.businessAccountId, token: w.accessToken, displayPhone: '', coexistence: false };
  return null;
}

// Ready to send and receive: a number and token, and the webhook's verify
// phrase (messages can't arrive without it).
function configured() { return !!(get() && config.whatsapp.verifyToken); }

module.exports = { load: load, get: get, configured: configured };
