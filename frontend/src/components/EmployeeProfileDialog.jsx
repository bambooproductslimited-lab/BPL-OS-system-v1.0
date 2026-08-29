import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { isPdf, toPreviewUrl } from '../lib/previewUrl';
import './EmployeeProfileDialog.css';

const ID_SLOT_LABELS = { id_front: 'ID — front', id_back: 'ID — back', passport: 'Passport' };
const EMPLOYMENT_TYPE_LABELS = { permanent: 'Permanent', contract: 'Contract', casual: 'Casual', day_rate: 'By day' };

// Full-detail read-only preview for one employee — profile fields, recent
// attendance, leave history, and open tasks — via the existing
// GET /api/employees/:id/profile endpoint (backend/src/services/
// employees.service.js's profile()), which was built early on but never
// had a frontend consumer until now. Visibility/access matches whatever
// the Employee directory itself already enforces (employee.read, scoped
// by visibleEmployee() — same department unless employee.read.all).

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso.length > 10 ? iso : iso + 'T00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '—';
  return t.slice(0, 5);
}
function fmtMoney(n) { return 'GHS ' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function tagClass(status) {
  if (['approved', 'present', 'active', 'completed'].includes(status)) return 'tag-neutral';
  if (['pending', 'late', 'in_progress', 'under_review', 'waiting', 'not_started'].includes(status)) return 'tag-outline';
  if (['rejected', 'absent', 'terminated', 'cancelled'].includes(status)) return 'tag-accent';
  return 'tag-neutral';
}

export default function EmployeeProfileDialog({ employeeId, onClose }) {
  const { can } = useAuth();
  const canViewIdDocs = can('employee.write');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [idSlots, setIdSlots] = useState(null);
  const [kioskPin, setKioskPin] = useState(null); // null = not fetched yet, { hasPin, pin }
  const [kioskPinLoading, setKioskPinLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/employees/' + employeeId + '/profile')
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [employeeId]);

  useEffect(() => {
    if (!canViewIdDocs) return;
    let cancelled = false;
    setIdSlots(null);
    api.get('/employees/' + employeeId + '/id-documents')
      .then(async (slots) => {
        const withUrls = await Promise.all(slots.map(async (s) => {
          if (!s.fileName) return s;
          try {
            const { url } = await api.get('/employees/' + employeeId + '/id-documents/' + s.kind + '/download');
            return { ...s, url: url };
          } catch {
            return s;
          }
        }));
        if (!cancelled) setIdSlots(withUrls);
      })
      .catch(() => { if (!cancelled) setIdSlots([]); });
    return () => { cancelled = true; };
  }, [employeeId, canViewIdDocs]);

  useEffect(() => { setKioskPin(null); }, [employeeId]);

  // Fetched only on click, not on dialog open — so a PIN isn't decrypted
  // and pulled over the wire just from someone glancing at a profile.
  // Every successful reveal is audit-logged server-side (kiosk.service.js).
  async function revealKioskPin() {
    setKioskPinLoading(true);
    try {
      setKioskPin(await api.get('/employees/' + employeeId + '/kiosk-pin'));
    } catch {
      setKioskPin({ hasPin: true, pin: null, error: true });
    } finally {
      setKioskPinLoading(false);
    }
  }

  const e = data && data.employee;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog employee-profile-dialog" onClick={(ev) => ev.stopPropagation()}>
        {loading && <div className="eyebrow">Loading…</div>}
        {error && <div className="error-banner">{error}</div>}

        {e && (
          <>
            <div className="employee-profile-head">
              <div>
                <h2 className="employee-profile-name">{e.firstName} {e.lastName}</h2>
                <div className="employee-profile-sub">{e.code} · {e.positionTitle || '—'}</div>
              </div>
              <span className={'tag ' + tagClass(e.status)}>{e.status}</span>
            </div>

            <div className="employee-profile-grid">
              <div><div className="employee-profile-label">Group</div><div>{data.departmentName}</div></div>
              <div><div className="employee-profile-label">Reports to</div><div>{data.managerName}</div></div>
              <div><div className="employee-profile-label">Work email</div><div>{e.email}</div></div>
              <div><div className="employee-profile-label">Phone</div><div>{e.phone || '—'}</div></div>
              <div><div className="employee-profile-label">Employment type</div><div>{EMPLOYMENT_TYPE_LABELS[e.employmentType] || e.employmentType}</div></div>
              <div><div className="employee-profile-label">Hire date</div><div>{fmtDate(e.hireDate)}</div></div>
              <div><div className="employee-profile-label">Location</div><div>{e.location || '—'}</div></div>
              <div><div className="employee-profile-label">Shift</div><div>{e.shift || '—'}</div></div>
              {e.payCycle !== undefined && (
                <>
                  <div><div className="employee-profile-label">Pay cycle</div><div style={{ textTransform: 'capitalize' }}>{e.payCycle}</div></div>
                  <div><div className="employee-profile-label">Daily rate</div><div>{fmtMoney(e.dailyRate)}</div></div>
                </>
              )}
              {canViewIdDocs && (
                <div>
                  <div className="employee-profile-label">Kiosk PIN</div>
                  <div>
                    {kioskPin === null && (
                      <button type="button" className="btn btn-secondary" style={{ fontSize: 12 }} disabled={kioskPinLoading} onClick={revealKioskPin}>
                        {kioskPinLoading ? 'Loading…' : 'Show'}
                      </button>
                    )}
                    {kioskPin && kioskPin.error && <span>Couldn't load — try again.</span>}
                    {kioskPin && !kioskPin.error && !kioskPin.hasPin && <span>Not set</span>}
                    {kioskPin && !kioskPin.error && kioskPin.hasPin && kioskPin.pin && <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{kioskPin.pin}</span>}
                    {kioskPin && !kioskPin.error && kioskPin.hasPin && !kioskPin.pin && <span>Set before this feature existed — reset it via "Kiosk PIN" to make it viewable.</span>}
                  </div>
                </div>
              )}
            </div>

            {canViewIdDocs && (
              <div className="employee-profile-section">
                <div className="employee-profile-section-title">ID &amp; passport</div>
                {idSlots === null ? (
                  <div className="eyebrow">Loading…</div>
                ) : (
                  <div className="employee-profile-iddocs">
                    {idSlots.map((s) => (
                      <div className="employee-profile-iddoc" key={s.kind}>
                        <div className="employee-profile-label">{ID_SLOT_LABELS[s.kind]}</div>
                        {s.fileName && s.url ? (
                          isPdf(s.fileName) ? (
                            <a href={toPreviewUrl(s.url, s.fileName)} target="_blank" rel="noopener noreferrer" className="employee-profile-iddoc-pdf">View PDF — {s.fileName}</a>
                          ) : (
                            <a href={s.url} target="_blank" rel="noopener noreferrer">
                              <img src={s.url} alt={ID_SLOT_LABELS[s.kind]} className="employee-profile-iddoc-img" />
                            </a>
                          )
                        ) : (
                          <div className="employee-profile-iddoc-empty">Not uploaded</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="employee-profile-section">
              <div className="employee-profile-section-title">Recent attendance</div>
              {data.attendance.length ? (
                <table className="table employee-profile-table">
                  <thead><tr><th>Date</th><th>Status</th><th>Clock in</th><th>Clock out</th></tr></thead>
                  <tbody>
                    {data.attendance.map((a) => (
                      <tr key={a.id}>
                        <td>{fmtDate(a.date)}</td>
                        <td><span className={'tag ' + tagClass(a.status)}>{a.status}</span></td>
                        <td>{fmtTime(a.clock_in)}</td>
                        <td>{fmtTime(a.clock_out)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="table-empty">No attendance records yet.</p>}
            </div>

            <div className="employee-profile-section">
              <div className="employee-profile-section-title">Leave</div>
              {data.leave.length ? (
                <table className="table employee-profile-table">
                  <thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.leave.map((l) => (
                      <tr key={l.id}>
                        <td>{l.typeName}</td>
                        <td>{fmtDate(l.startDate)} – {fmtDate(l.endDate)}</td>
                        <td>{l.days}</td>
                        <td><span className={'tag ' + tagClass(l.status)}>{l.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="table-empty">No leave requests yet.</p>}
            </div>

            <div className="employee-profile-section">
              <div className="employee-profile-section-title">Open tasks</div>
              {data.tasks.length ? (
                <table className="table employee-profile-table">
                  <thead><tr><th>Task</th><th>Status</th><th>Due</th></tr></thead>
                  <tbody>
                    {data.tasks.map((t) => (
                      <tr key={t.id}>
                        <td>{t.title}</td>
                        <td><span className={'tag ' + tagClass(t.status)}>{t.status.replace('_', ' ')}</span></td>
                        <td>{fmtDate(t.dueDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="table-empty">No tasks assigned.</p>}
            </div>
          </>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
