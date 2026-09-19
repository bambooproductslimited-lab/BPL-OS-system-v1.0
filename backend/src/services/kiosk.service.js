var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var config = require('../config');
var attendanceService = require('./attendance.service');
var { audit } = require('../utils/audit');
var pinAuth = require('../lib/pinAuth');

// The clock-in/out kiosk (an unattended iPad, no login) — an employee
// enters a 4-digit PIN and nothing else identifies them, so the PIN alone
// has to resolve to exactly one active employee (see migration 0025's
// comment on the hashing choice). Every attempt is rate-limited per
// caller IP since a 4-digit space (10,000 combinations) is guessable
// online if nothing throttles it. Rate limiting and PIN hashing now live
// in lib/pinAuth.js, shared with the restaurant POS's till login — both
// resolve the same kiosk_pin_hash column, so they share one counter too.

var PIN_LENGTH = pinAuth.PIN_LENGTH;
var checkRateLimit = pinAuth.checkRateLimit;
var recordFailure = pinAuth.recordFailure;
var recordSuccess = pinAuth.recordSuccess;
var hashPin = pinAuth.hashPin;

// Reversible copy of the PIN, stored alongside the hash above — see
// migration 0029's comment for why this exists as a second column instead
// of replacing the hash. Key is derived (scrypt, not used directly) from
// the same pepper so no separate secret needs configuring on Render; a
// fresh random IV per encryption means the same PIN encrypts differently
// every time it's set, so two employees sharing a PIN never show matching
// ciphertext.
var ENCRYPTION_KEY = crypto.scryptSync(config.kioskPinPepper, 'bamboo-os-kiosk-pin-encryption', 32);

function encryptPin(pin) {
  var iv = crypto.randomBytes(12);
  var cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  var ciphertext = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  var authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptPin(encrypted) {
  var raw = Buffer.from(encrypted, 'base64');
  var iv = raw.subarray(0, 12);
  var authTag = raw.subarray(12, 28);
  var ciphertext = raw.subarray(28);
  var decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// kiosk.setPin — admin sets/resets an employee's PIN (employees.routes.js,
// employee.write gated there). Exported here since the hashing/uniqueness
// concern belongs with the rest of the kiosk PIN logic.
//
// No visibleEmployee() check on the target employeeId, here or in
// clearPin()/getPin()/enrollFace()/clearFace()/getFaceStatus() below — all
// six gate on employee.write alone. A security review confirmed this is
// intentional, not an oversight: employee.write is only ever granted to
// hr_manager/finance_hr_manager/general_manager (see referenceData.js's
// ROLE_DEFS), all three explicitly company-wide. getPin() in particular
// reveals a plaintext PIN and enrollFace()/getFaceStatus() touch biometric
// data, so this is worth extra care if employee.write's grants ever
// change — add a visibleEmployee(ctx, emp) check back into all six
// functions if a narrower, department-scoped role is ever given
// employee.write.
async function setPin(ctx, employeeId, pin) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  if (!/^\d{4}$/.test(String(pin || ''))) fail('invalid', 'PIN must be exactly ' + PIN_LENGTH + ' digits.');
  var empRes = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  var hash = hashPin(pin);
  var encrypted = encryptPin(pin);
  try {
    await pool.query('UPDATE employees SET kiosk_pin_hash = $1, kiosk_pin_encrypted = $2 WHERE id = $3', [hash, encrypted, employeeId]);
  } catch (err) {
    if (err.code === '23505') fail('conflict', 'That PIN is already in use by another employee — choose a different one.');
    throw err;
  }
  await audit(pool, ctx, 'employee.kioskPin.set', 'employee', employeeId, 'Set a kiosk PIN for ' + emp.first_name + ' ' + emp.last_name + '.');
  return { ok: true };
}

// No visibleEmployee() check — see setPin()'s comment above.
async function clearPin(ctx, employeeId) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var empRes = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL, kiosk_pin_encrypted = NULL WHERE id = $1', [employeeId]);
  await audit(pool, ctx, 'employee.kioskPin.clear', 'employee', employeeId, 'Cleared the kiosk PIN for ' + emp.first_name + ' ' + emp.last_name + '.');
  return { ok: true };
}

// kiosk.getPin — reveal an employee's current PIN on demand. Gated the
// same as set/clear (employee.write): this doesn't hand PIN visibility to
// anyone new, only to people who could already learn any employee's PIN
// by resetting it. Every reveal is audit-logged, same principle as viewing
// an ID document — it's sensitive enough to leave a trail of who looked.
// No visibleEmployee() check — see setPin()'s comment above.
async function getPin(ctx, employeeId) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var empRes = await pool.query('SELECT id, first_name, last_name, kiosk_pin_hash, kiosk_pin_encrypted FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  // A PIN set before this feature existed (or via the TimeStation sync
  // before it was updated to store the recoverable copy too) only has the
  // hash — not recoverable, not a bug. HR resetting it via "Kiosk PIN" is
  // the only way to make an old PIN viewable going forward.
  if (!emp.kiosk_pin_hash) return { hasPin: false, pin: null };
  if (!emp.kiosk_pin_encrypted) return { hasPin: true, pin: null };
  await audit(pool, ctx, 'employee.kioskPin.view', 'employee', employeeId, 'Viewed the kiosk PIN for ' + emp.first_name + ' ' + emp.last_name + '.');
  return { hasPin: true, pin: decryptPin(emp.kiosk_pin_encrypted) };
}

// Face enrollment — HR/admin captures a reference descriptor SET for an
// employee (employee.write, same gate as the PIN itself): several
// 128-number vectors, one per head angle (straight on, turned left/right,
// tilted up/down — see FaceCapture.jsx's guided pose walk), not a single
// shot. A verification frame only has to be close to the nearest of these,
// which is what actually makes the match tolerant of whatever angle
// someone happens to be at when they look at the kiosk — the same reason
// Face ID has you move your head in a circle during its own setup. No
// photo is ever sent to or stored on the server, only these vectors (see
// migration 0039 — the column predates the move from one vector to a set,
// but jsonb doesn't care, and normalizeDescriptorSet below still accepts an
// old single-vector row as a one-pose set).
var FACE_DESCRIPTOR_LENGTH = 128;
var MIN_POSE_SAMPLES = 2;
var MAX_POSE_SAMPLES = 8;
// face-api.js's docs cite 0.6 as its FaceMatcher default, but 0.6 (and
// then 0.5) both still let different people match each other in practice on
// a laptop/kiosk webcam — that default is calibrated against cleaner input
// than a typical webcam produces. 0.42 is deliberately tight: a standard 2D
// webcam has no depth data to fall back on (unlike, say, an iPhone's
// infrared TrueDepth sensor, which is what actually gets Face ID to its
// ~1-in-1,000,000 false-accept rate — no amount of threshold tuning on a
// flat image reaches that), so the only lever here is trading some
// tolerance for lighting/angle variation for a much lower chance of
// accepting the wrong person. Paired with SsdMobilenetv1 (more accurate
// alignment than the tiny detector it replaced) and averaging several
// samples instead of trusting one frame (see FaceCapture.jsx) on both the
// enrollment and verification side.
var FACE_MATCH_THRESHOLD = 0.42;

function validateDescriptor(descriptor) {
  if (!Array.isArray(descriptor) || descriptor.length !== FACE_DESCRIPTOR_LENGTH) {
    fail('invalid', 'Invalid face descriptor.');
  }
  for (var i = 0; i < descriptor.length; i++) {
    if (typeof descriptor[i] !== 'number' || !isFinite(descriptor[i])) fail('invalid', 'Invalid face descriptor.');
  }
}

function validateDescriptorSet(set) {
  if (!Array.isArray(set) || set.length < MIN_POSE_SAMPLES || set.length > MAX_POSE_SAMPLES) {
    fail('invalid', 'Expected between ' + MIN_POSE_SAMPLES + ' and ' + MAX_POSE_SAMPLES + ' captured face angles.');
  }
  for (var i = 0; i < set.length; i++) validateDescriptor(set[i]);
}

// A row written before enrollment moved from one vector to a pose set (see
// module comment above) still has a single flat array of 128 numbers in
// face_descriptor rather than an array of those — treat that as a
// one-pose set rather than erroring, so an old enrollment quietly keeps
// working (just without the multi-angle tolerance a re-enrollment gets).
function normalizeDescriptorSet(raw) {
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'number') return [raw];
  return raw;
}

function euclideanDistance(a, b) {
  var sum = 0;
  for (var i = 0; i < a.length; i++) {
    var d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function nearestDistance(enrolledSet, descriptor) {
  var min = Infinity;
  for (var i = 0; i < enrolledSet.length; i++) {
    var d = euclideanDistance(enrolledSet[i], descriptor);
    if (d < min) min = d;
  }
  return min;
}

// No visibleEmployee() check — see setPin()'s comment above.
async function enrollFace(ctx, employeeId, descriptorSet) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  validateDescriptorSet(descriptorSet);
  var empRes = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  await pool.query(
    'UPDATE employees SET face_descriptor = $1, face_enrolled_at = now(), face_enrolled_by = $2 WHERE id = $3',
    [JSON.stringify(descriptorSet), ctx.employee.id, employeeId]
  );
  await audit(pool, ctx, 'employee.face.enroll', 'employee', employeeId, 'Enrolled a kiosk face match (' + descriptorSet.length + ' angles) for ' + emp.first_name + ' ' + emp.last_name + '.');
  return { ok: true };
}

// No visibleEmployee() check — see setPin()'s comment above.
async function clearFace(ctx, employeeId) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var empRes = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  await pool.query('UPDATE employees SET face_descriptor = NULL, face_enrolled_at = NULL, face_enrolled_by = NULL WHERE id = $1', [employeeId]);
  await audit(pool, ctx, 'employee.face.clear', 'employee', employeeId, 'Cleared the kiosk face match for ' + emp.first_name + ' ' + emp.last_name + '.');
  return { ok: true };
}

// No visibleEmployee() check — see setPin()'s comment above.
async function getFaceStatus(ctx, employeeId) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var res = await pool.query('SELECT face_enrolled_at FROM employees WHERE id = $1', [employeeId]);
  if (!res.rows[0]) fail('notfound', 'Employee not found.');
  return { enrolled: !!res.rows[0].face_enrolled_at, enrolledAt: res.rows[0].face_enrolled_at };
}

// Self-enrollment link — lets an employee walk through the same camera
// pose sequence themselves, from their own phone, instead of an HR
// staffer running FaceCapture on their behalf. expires_at is mandatory
// (unlike document_shares' nullable one) and the link is deleted the
// moment it's consumed: see migration 0055's comment for why a biometric
// enrollment link needs tighter handling than a read-only document link —
// a link that outlived its use, or that anyone but the intended employee
// could replay, would let them enroll THEIR face against someone else's
// clock-in identity.
var FACE_ENROLL_LINK_DEFAULT_DAYS = 3;
var FACE_ENROLL_LINK_MAX_DAYS = 14;

// No visibleEmployee() check — see setPin()'s comment above.
async function createFaceEnrollLink(ctx, employeeId, expiresInDays) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var empRes = await pool.query('SELECT id, first_name, last_name, status, kiosk_pin_hash FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  if (emp.status !== 'active') fail('conflict', 'Only an active employee can be sent a self-enrollment link.');
  // The PIN is what proves the person on the other end of the link is
  // actually this employee (see verifyFaceEnrollPin below) — a link sent
  // before a PIN exists would have no way to check that, so it's required
  // up front rather than failing confusingly once the employee opens it.
  if (!emp.kiosk_pin_hash) fail('conflict', 'Set a kiosk PIN for this employee first — the self-enrollment link asks them to confirm it.');
  var days = Math.max(1, Math.min(FACE_ENROLL_LINK_MAX_DAYS, Number(expiresInDays) || FACE_ENROLL_LINK_DEFAULT_DAYS));
  var token = crypto.randomBytes(24).toString('base64url');
  var expiresAt = new Date(Date.now() + days * 86400000);
  await pool.query(
    'INSERT INTO face_enroll_links (token, employee_id, expires_at, created_by) VALUES ($1,$2,$3,$4)',
    [token, employeeId, expiresAt, ctx.employee.id]
  );
  await audit(pool, ctx, 'employee.face.linkCreate', 'employee', employeeId, 'Generated a self-enrollment link for ' + emp.first_name + ' ' + emp.last_name + ' (expires ' + expiresAt.toISOString().slice(0, 10) + ').');
  return { token: token, expiresAt: expiresAt };
}

async function loadFaceEnrollLink(token) {
  var res = await pool.query(
    'SELECT l.id, l.employee_id, l.expires_at, e.first_name, e.last_name, e.status, e.face_enrolled_at, e.kiosk_pin_hash ' +
    'FROM face_enroll_links l JOIN employees e ON e.id = l.employee_id WHERE l.token = $1',
    [token]
  );
  var row = res.rows[0];
  if (!row) fail('notfound', 'This link is invalid or has already been used.');
  if (new Date(row.expires_at) < new Date()) {
    await pool.query('DELETE FROM face_enroll_links WHERE id = $1', [row.id]);
    fail('notfound', 'This link has expired — ask HR to send a new one.');
  }
  if (row.status !== 'active') fail('conflict', 'This employee record is no longer active.');
  return row;
}

// Public (token is the authorization) — returns only what the enrollment
// page needs to greet the right person; nothing else about the employee.
// requiresPin is always true in practice (createFaceEnrollLink refuses to
// generate a link for an employee with no PIN set) but is still reported
// explicitly rather than assumed, in case a link predates that guard.
async function getFaceEnrollTarget(token) {
  var row = await loadFaceEnrollLink(token);
  return { firstName: row.first_name, lastName: row.last_name, alreadyEnrolled: !!row.face_enrolled_at, requiresPin: !!row.kiosk_pin_hash };
}

// The link alone only proves someone has the URL, not that they're the
// employee it was sent for — see migration 0055 and kiosk.service.js's
// module comment. Requiring their kiosk PIN too (known only to them and
// HR, same as at the kiosk itself) closes that gap: whoever completes
// enrollment has to know something private to the employee, not just have
// forwarded/leaked access to a link. Same IP rate limiting as the kiosk's
// own PIN checks — this resolves the same kiosk_pin_hash secret space.
function verifyPinAgainstEmployee(row, pin, ip) {
  checkRateLimit(ip);
  pinAuth.validatePinFormat(pin);
  if (!row.kiosk_pin_hash || hashPin(pin) !== row.kiosk_pin_hash) {
    recordFailure(ip);
    fail('invalid', 'Incorrect PIN.');
  }
  recordSuccess(ip);
}

// Public — lets the enrollment page check the PIN before running the
// camera walk, so a wrong PIN fails fast instead of after 10 seconds of
// posing. Doesn't consume the link; enrollFaceViaLink re-checks the PIN
// itself right before writing, since this step alone is just a UX
// shortcut, not the actual authorization boundary.
async function verifyFaceEnrollPin(token, pin, ip) {
  var row = await loadFaceEnrollLink(token);
  verifyPinAgainstEmployee(row, pin, ip);
  return { ok: true };
}

// Public — see module comment above. actor is null in the audit entry
// (this wasn't done by any logged-in user); the summary makes clear it
// was a self-enrollment via link, not an HR-driven one.
async function enrollFaceViaLink(token, descriptorSet, pin, ip) {
  var row = await loadFaceEnrollLink(token);
  verifyPinAgainstEmployee(row, pin, ip);
  validateDescriptorSet(descriptorSet);
  await pool.query(
    'UPDATE employees SET face_descriptor = $1, face_enrolled_at = now(), face_enrolled_by = NULL WHERE id = $2',
    [JSON.stringify(descriptorSet), row.employee_id]
  );
  await pool.query('DELETE FROM face_enroll_links WHERE id = $1', [row.id]);
  await audit(pool, null, 'employee.face.enroll', 'employee', row.employee_id, row.first_name + ' ' + row.last_name + ' self-enrolled a kiosk face match (' + descriptorSet.length + ' angles) via link, PIN-verified.');
  return { ok: true };
}

// Reuses the existing WhatsApp Business Cloud API integration — same
// Ghana-specific "0" -> "233" normalization and same 24-hour customer-
// service-window platform limitation as shares.service.js's
// shareViaWhatsApp, which this mirrors. No visibleEmployee() check — see
// setPin()'s comment above (employee.write is checked by
// createFaceEnrollLink already having been called for this token to exist).
async function sendFaceEnrollLinkViaWhatsApp(ctx, employeeId, url) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var empRes = await pool.query('SELECT first_name, last_name, phone FROM employees WHERE id = $1', [employeeId]);
  var emp = empRes.rows[0];
  if (!emp) fail('notfound', 'Employee not found.');
  if (!emp.phone) fail('invalid', 'This employee has no phone number on file.');

  var digits = String(emp.phone).replace(/\D/g, '');
  if (digits.length === 10 && digits.charAt(0) === '0') digits = '233' + digits.slice(1);

  var whatsapp = require('./whatsapp.service');
  await whatsapp.sendMessage(digits, 'Hi ' + emp.first_name + ', please open this link to set up face recognition for the clock-in kiosk: ' + url + ' — it expires soon and only works once.');
  return { sent: true };
}

// kiosk.deviceConfig — the one thing the kiosk device needs to know about
// itself before anybody is standing in front of it: does this deployment use
// face verification at all? The iPad asks on startup so it can get the
// browser's camera permission out of the way while the idle PIN pad is on
// screen, instead of the permission dialog ambushing an employee halfway
// through clocking in (see KioskPage.jsx's camera priming). A deployment
// where nobody is enrolled never touches the camera and is never asked for it.
//
// Public and unauthenticated like the rest of this router, and deliberately
// nothing but a boolean — it says whether SOMEBODY has a face on file, never
// who, so it gives an unauthenticated caller nothing it didn't already know
// from the kiosk asking it for a face at all.
//
// (Named deviceConfig, not config: `config` at module scope is already
// require('../config') — the app's settings, secrets and all.)
async function deviceConfig() {
  var res = await pool.query(
    "SELECT 1 FROM employees WHERE face_descriptor IS NOT NULL AND status = 'active' LIMIT 1"
  );
  return { faceVerificationInUse: res.rowCount > 0 };
}

// kiosk.identify — resolves a PIN to the employee it belongs to, without
// clocking anything, so the kiosk knows before capturing a camera frame
// whether that employee has a face on file to check it against (see
// KioskPage.jsx). Same rate limiting as clock() itself, since this is the
// same PIN-guessing surface — an attacker gains nothing by probing this
// endpoint instead of the real one.
async function identify(pin, ip) {
  checkRateLimit(ip);
  if (!/^\d{4}$/.test(String(pin || ''))) {
    recordFailure(ip);
    fail('invalid', 'Enter a 4-digit PIN.');
  }
  var hash = hashPin(pin);
  var empRes = await pool.query(
    "SELECT id, first_name, last_name, face_descriptor FROM employees WHERE kiosk_pin_hash = $1 AND status = 'active'", [hash]
  );
  var emp = empRes.rows[0];
  if (!emp) {
    recordFailure(ip);
    fail('invalid', 'Incorrect PIN.');
  }
  recordSuccess(ip);
  return { employeeName: emp.first_name + ' ' + emp.last_name, requiresFace: !!emp.face_descriptor };
}

// kiosk.clock — the public, unauthenticated endpoint the iPad calls.
// Toggles: no attendance row yet today -> clock in; a row with clock_in
// but no clock_out -> clock out; both set -> a clean "already done" error.
//
// occurredAt is set only when the kiosk's offline queue (KioskPage.jsx) is
// replaying a tap that happened while the device had no connectivity — a
// live tap always omits it and gets the server's own now(), unchanged from
// before. This is the one place a client-supplied timestamp is trusted at
// all, and only to correctly backdate an already-authenticated tap
// (attendance.service.js's resolveOccurredAt still bounds/validates it) —
// never to skip PIN verification itself.
async function clock(pin, ip, occurredAt, location, faceDescriptor) {
  checkRateLimit(ip);
  if (!/^\d{4}$/.test(String(pin || ''))) {
    recordFailure(ip);
    fail('invalid', 'Enter a 4-digit PIN.');
  }
  var hash = hashPin(pin);
  var empRes = await pool.query(
    "SELECT id, first_name, last_name, face_descriptor FROM employees WHERE kiosk_pin_hash = $1 AND status = 'active'", [hash]
  );
  var emp = empRes.rows[0];
  if (!emp) {
    recordFailure(ip);
    fail('invalid', 'Incorrect PIN.');
  }

  // An employee with a face on file must match it every tap — the PIN
  // alone is no longer enough for them (that's the whole point: someone
  // else who knows/is handed their PIN can't clock them in). Nothing
  // changes for an employee who was never enrolled — see migration 0039's
  // comment on why enrollment is optional/gradual.
  if (emp.face_descriptor) {
    if (!faceDescriptor) {
      recordFailure(ip);
      fail('faceRequired', 'Look at the camera to confirm it’s you.');
    }
    validateDescriptor(faceDescriptor);
    var distance = nearestDistance(normalizeDescriptorSet(emp.face_descriptor), faceDescriptor);
    if (distance > FACE_MATCH_THRESHOLD) {
      recordFailure(ip);
      fail('faceMismatch', 'That face doesn’t match this PIN.');
    }
  }
  recordSuccess(ip);

  var resolved = attendanceService.resolveOccurredAt(occurredAt);
  var source = occurredAt ? 'kiosk_offline' : 'kiosk';

  // One rule, both ways round: a tap closes whatever shift is open, and
  // starts one if none is. Nothing else is consulted — not the time of day,
  // not how long the shift has run, not what the employee's shift template
  // says.
  //
  // Keyed on the open shift rather than on today's date, because a night
  // shift's two taps fall on two different dates: a guard starting 18:00 on
  // Tuesday taps out at 06:00 on Wednesday, and looking for "Wednesday's
  // row" found nothing to close and opened a second shift instead. Three
  // nights produced four rows, the middle ones recording the rest period
  // between shifts as the shift itself.
  //
  // An earlier version of this tried to be clever: a tap that looked more
  // like the start of a shift than the end of one left the old shift open
  // and started a new one, so that a single missed tap-out could not invert
  // a guard's record from then on. That is not the behaviour the business
  // wants. A shift that is not clocked out keeps running until somebody
  // clocks it out, whenever that is, and the next tap starts the next shift
  // — so an employee who forgot yesterday taps twice on arrival, once to
  // close yesterday and once to start today. The kiosk names the action it
  // just took on screen, which makes that recoverable by the person
  // standing at it; a heuristic they cannot see is not.
  var at = resolved.date + 'T' + resolved.time + ':00';
  var open = await attendanceService.findOpenShift(emp.id, at);

  var action, rec;
  if (open) {
    rec = await attendanceService.clockOutEmployee(emp.id, occurredAt, location);
    action = 'out';
  } else {
    // Nothing open. If today's shift is already finished, this is a second
    // shift in one day rather than a mistake — but the row is keyed on
    // (employee, date), so it cannot be recorded and saying so is better
    // than failing obscurely.
    var todays = await pool.query(
      'SELECT clock_out FROM attendance WHERE employee_id = $1 AND date = $2', [emp.id, resolved.date]);
    if (todays.rows[0] && todays.rows[0].clock_out) {
      fail('conflict', 'You have already clocked in and out today.');
    }
    rec = await attendanceService.clockInEmployee(emp.id, source, occurredAt, location);
    action = 'in';
  }

  var time = (action === 'in' ? rec.clock_in : rec.clock_out).slice(0, 5);
  return { action: action, employeeName: emp.first_name + ' ' + emp.last_name, time: time, status: rec.status, minutesLate: rec.minutesLate || 0 };
}

module.exports = {
  setPin: setPin, clearPin: clearPin, getPin: getPin, clock: clock, identify: identify, deviceConfig: deviceConfig,
  enrollFace: enrollFace, clearFace: clearFace, getFaceStatus: getFaceStatus,
  createFaceEnrollLink: createFaceEnrollLink, getFaceEnrollTarget: getFaceEnrollTarget, enrollFaceViaLink: enrollFaceViaLink,
  verifyFaceEnrollPin: verifyFaceEnrollPin, sendFaceEnrollLinkViaWhatsApp: sendFaceEnrollLinkViaWhatsApp
};
