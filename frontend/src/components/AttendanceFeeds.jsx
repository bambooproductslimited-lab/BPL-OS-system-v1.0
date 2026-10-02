import { useCallback, useEffect, useState } from 'react';
import { api, API_URL } from '../api/client';
import { Empty, Section, Status, fmtDate } from './DashKit';
import RowMenu from './RowMenu';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './AttendanceFeeds.css';

// Attendance feeds (backend attendanceFeeds.service.js): one company's
// clock-ins and attendance, for an outside system such as a restaurant's
// own staff schedule tracker. Each feed can
//   send — every change is posted to their address as it happens, signed
//          with the feed's secret, and tried again while their site is down;
//   be read — their system asks with the feed's read-only key.
// The secret and the key are shown once, when made, to hand to their
// developer; afterwards only the key's first letters are shown.

function fmtWhen(ts) { return ts ? new Date(ts).toLocaleString(activeIntlLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
function hostOf(url) { try { return new URL(url).hostname; } catch { return url; } }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }

function stateOf(f) {
  if (!f.active) return { tone: 'muted', key: 'paused', text: tr('Paused') };
  if (f.pushUrl && f.failingSince) return { tone: 'bad', key: 'failing', text: tr('Their site is not answering') };
  if (f.pushUrl) return { tone: 'good', key: 'live', text: tr('Sending live') };
  return { tone: 'info', key: 'read', text: tr('Read with a key') };
}

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* select it by hand */ }
  }
  return (
    <div className="af-copy">
      <span className="af-copy-label">{label}</span>
      <code className="af-copy-value">{value}</code>
      <button type="button" className="btn btn-secondary af-btn" onClick={copy}>{copied ? tr('Copied') : tr('Copy')}</button>
    </div>
  );
}

// What their developer needs, as sections; shown in the dialog and saved as a file.
function guideSections(feed) {
  const read = API_URL.replace(/\/$/, '') + '/feeds/attendance';
  return [
    { title: tr('What this is'), text: tr('Bamboo OS sends the clock-ins and attendance of {company} staff to your system. Times are Ghana time (GMT, the same as UTC). GPS locations, photos, notes and pay are never sent.', { company: feed.company }) },
    { title: tr('1. Receiving (Bamboo OS posts to you)'), text: tr('Each change is sent as a POST with a JSON body to the address you gave, within about half a minute. Answer with any 2xx status and a short reply such as {"received":true} to accept it, only after the records are saved (not a web page: Bamboo OS shows the reply on its log). Anything else, or no answer within 10 seconds, and it is sent again later (30 seconds, then longer, up to every hour) until you accept it; nothing is skipped and the order is kept. Use each event\'s id to ignore one you already have.'),
      code: 'POST ' + (feed.pushUrl || 'https://your-site/your-path') + '\nContent-Type: application/json\nUser-Agent: BambooOS-AttendanceFeed/1\nX-Bamboo-Feed: ' + feed.id + '\nX-Bamboo-Delivery: <a new id for each post>\nX-Bamboo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>\n\n' + JSON.stringify({
        feed: { id: feed.id, name: feed.name }, sentAt: '2026-10-02T08:01:21Z',
        events: [{ id: 'evt_10234', type: 'attendance.recorded', occurredAt: '2026-10-02T08:01:20Z', attendance: {
          id: '5b1c…', date: '2026-10-02', shift: 1, clockIn: '08:01', clockOut: '17:05', clockOutDate: '2026-10-02',
          clockInAt: '2026-10-02T08:01:00Z', clockOutAt: '2026-10-02T17:05:00Z', hoursWorked: 9.07, status: 'late',
          autoClockedOut: false, source: 'kiosk', editedByHR: false,
          employee: { id: '9f2e…', code: 'SBR-004', name: 'Ama Mensah', department: 'Bar', position: 'Bartender' } } }]
      }, null, 2) },
    { title: tr('Kinds of event'), text: tr('attendance.recorded: a clock-in, a clock-out or a change by HR; it always carries the whole record as it is now, so save it over what you have with the same attendance id. attendance.removed: HR deleted the record; delete yours. feed.test: sent by the Send a test button; just answer 2xx. status is present, late, absent or half_day; shift is 1 or 2 (a second shift the same day); clockOut is empty while they are still at work; autoClockedOut means nobody clocked out and the OS closed the shift at its limit.') },
    { title: tr('2. Checking the signature'), text: tr('Every post is signed with the feed\'s signing secret (it starts with bfs_). Work out HMAC-SHA256 of "<t>.<the raw body>" with the secret and compare it with v1; refuse the post if they differ or if t is more than 5 minutes old. Use the body exactly as received, before parsing it.'),
      code: '// PHP\n$body = file_get_contents(\'php://input\');\nparse_str(str_replace(\',\', \'&\', $_SERVER[\'HTTP_X_BAMBOO_SIGNATURE\'] ?? \'\'), $sig);\n$want = hash_hmac(\'sha256\', ($sig[\'t\'] ?? \'\') . \'.\' . $body, getenv(\'BAMBOO_FEED_SECRET\'));\nif (!hash_equals($want, $sig[\'v1\'] ?? \'\') || abs(time() - (int)($sig[\'t\'] ?? 0)) > 300) { http_response_code(401); exit; }\n$data = json_decode($body, true);\nforeach ($data[\'events\'] as $e) { /* save $e[\'attendance\'] by its id */ }\nhttp_response_code(200);\n\n// Node (Express): use express.raw({ type: \'application/json\' }) on this route\nconst [t, v1] = req.get(\'X-Bamboo-Signature\').split(\',\').map((p) => p.split(\'=\')[1]);\nconst want = crypto.createHmac(\'sha256\', process.env.BAMBOO_FEED_SECRET).update(t + \'.\' + req.body).digest(\'hex\');\nconst ok = want.length === v1.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(v1)) && Math.abs(Date.now() / 1000 - t) < 300;' },
    { title: tr('3. Reading (you ask Bamboo OS)'), text: tr('With the read key (it starts with bfk_), from your server, never from a web page. Ask for changes every few minutes: start with after=0, then send back the next value you were given; more=true means ask again straight away. Changes are kept 35 days; if gap=true, fetch those days with records. A day range is at most 93 days.'),
      code: 'GET ' + read + '/changes?after=0&limit=100\nGET ' + read + '/records?from=2026-10-01&to=2026-10-31\nGET ' + read + '/staff\nAuthorization: Bearer bfk_…\n\n→ { "events": [ …same as above… ], "next": "10234", "more": false, "gap": false }' },
    { title: tr('Keeping the secret and key safe'), text: tr('Keep both on your server only (e.g. in its settings), never in a web page or in code shared with others. If one is ever seen by someone it shouldn\'t be, ask for a new one: the old one stops working at once.') }
  ];
}

function guideMarkdown(feed) {
  return '# ' + tr('Bamboo OS attendance feed: {name}', { name: feed.name }) + '\n\n' + guideSections(feed).map((s) => '## ' + s.title + '\n\n' + s.text + (s.code ? '\n\n```\n' + s.code + '\n```' : '')).join('\n\n') + '\n';
}

export default function AttendanceFeeds({ onToast, onSummary }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // {} for a new one, or the feed
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState(null); // { feed, secret?, key? }
  const [resendFor, setResendFor] = useState(null);
  const [range, setRange] = useState({ from: daysAgo(7), to: todayISO() });
  const [guideFor, setGuideFor] = useState(null);
  const [busy, setBusy] = useState(null);
  const [lastTest, setLastTest] = useState({});

  const load = useCallback(async () => {
    try {
      const d = await api.get('/attendance-feeds');
      setData(d);
      if (onSummary) onSummary(d.feeds);
    } catch (err) {
      setError(err.message);
    }
  }, [onSummary]);
  useEffect(() => { load(); }, [load]);

  function openNew() {
    const first = data.companies.find((c) => /star bar/i.test(c.name)) || data.companies[0];
    setForm({ name: '', companyId: first ? first.id : '', departmentIds: [], pushUrl: '', readKey: true });
    setFormError(null);
    setEditing({});
  }
  function openEdit(f) {
    setForm({ name: f.name, companyId: f.companyId, departmentIds: f.departmentIds, pushUrl: f.pushUrl || '', readKey: !!f.readKey });
    setFormError(null);
    setEditing(f);
  }
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      if (editing.id) {
        await api.put('/attendance-feeds/' + editing.id, { name: form.name, departmentIds: form.departmentIds, pushUrl: form.pushUrl });
        if (form.readKey && !editing.readKey) {
          const k = await api.post('/attendance-feeds/' + editing.id + '/read-key', {});
          setReveal({ feed: { ...editing, name: form.name, pushUrl: form.pushUrl }, key: k.readKeyValue });
        } else if (!form.readKey && editing.readKey) {
          await api.del('/attendance-feeds/' + editing.id + '/read-key');
        }
        onToast(tr('Saved "{name}".', { name: form.name }));
      } else {
        const created = await api.post('/attendance-feeds', form);
        setReveal({ feed: created, secret: created.signingSecret, key: created.readKeyValue, isNew: true });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function act(f, what) {
    setBusy(f.id + what);
    setError(null);
    try {
      if (what === 'test') {
        const r = await api.post('/attendance-feeds/' + f.id + '/test', {});
        setLastTest({ ...lastTest, [f.id]: r });
        onToast(r.ok ? tr('Their site answered {code} in {ms} ms.', { code: r.statusCode, ms: r.ms }) : tr('The test did not get through: {why}', { why: r.error }));
      } else if (what === 'pause' || what === 'resume') {
        await api.put('/attendance-feeds/' + f.id, { active: what === 'resume' });
        onToast(what === 'resume' ? tr('"{name}" resumed. What changed while it was paused is sent now.', { name: f.name }) : tr('"{name}" paused. Nothing is sent or read until you resume it.', { name: f.name }));
      } else if (what === 'secret') {
        if (!window.confirm(tr('Make a new signing secret for "{name}"? The old one stops working at once, so their system must be given the new one.', { name: f.name }))) return;
        const r = await api.post('/attendance-feeds/' + f.id + '/secret', {});
        setReveal({ feed: f, secret: r.signingSecret });
      } else if (what === 'key') {
        if (f.readKey && !window.confirm(tr('Make a new read key for "{name}"? The old one stops working at once.', { name: f.name }))) return;
        const r = await api.post('/attendance-feeds/' + f.id + '/read-key', {});
        setReveal({ feed: f, key: r.readKeyValue });
      } else if (what === 'delete') {
        if (!window.confirm(tr('Delete "{name}"? Nothing more is sent to them, and their read key stops working.', { name: f.name }))) return;
        await api.del('/attendance-feeds/' + f.id);
        onToast(tr('"{name}" deleted.', { name: f.name }));
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }
  async function doResend(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const r = await api.post('/attendance-feeds/' + resendFor.id + '/resend', range);
      if (r.ok) {
        onToast(r.sent ? tr('Sent {n} attendance record(s) again.', { n: r.sent }) : tr('There is no attendance on those days.'));
        setResendFor(null);
      } else {
        setFormError(tr('Stopped after {n} of {total}: {why}', { n: r.sent, total: r.records, why: r.error }));
      }
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }
  function download(f) {
    const blob = new Blob([guideMarkdown(f)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bamboo-attendance-feed-' + f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  if (!data) return error ? <Section id="in-feeds" title={tr('Attendance feeds')}><p className="in-error">{error}</p></Section> : null;
  const company = form && data.companies.find((c) => c.id === form.companyId);

  return (
    <Section id="in-feeds" title={tr('Attendance feeds')}
      sub={tr('Send one company\'s clock-ins and attendance to another system, like a restaurant\'s own staff schedule tracker. It is sent to their address as it happens, or their system reads it with a key — or both. GPS locations, photos, notes and pay are never sent.')}
      action={<button type="button" className="btn btn-primary" onClick={openNew}>{tr('+ New attendance feed')}</button>}>
      {error && <p className="in-error">{error}</p>}
      {!data.feeds.length ? (
        <Empty icon="people">
          <p>{tr('No feeds yet. Make one for each outside system that should get clock-ins: choose the company, then give their address, a read key, or both.')}</p>
          <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Set up the first feed')}</button>
        </Empty>
      ) : (
        <div className="af-list">
          {data.feeds.map((f) => {
            const st = stateOf(f);
            const deps = f.departmentIds.length
              ? (data.companies.find((c) => c.id === f.companyId)?.departments || []).filter((d) => f.departmentIds.includes(d.id)).map((d) => d.name).join(', ')
              : tr('the whole company');
            const t = lastTest[f.id];
            const lastOk = f.deliveries.find((d) => d.ok && d.kind !== 'test');
            return (
              <article key={f.id} className={'af-card is-' + st.key}>
                <header className="af-head">
                  <span className="af-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /><path d="M19.5 4.5 22 2M22 2h-3M22 2v3" /></svg>
                  </span>
                  <span className="af-title">
                    <strong>{f.name}</strong>
                    <span className="dk-muted tl-small">{tr('{company} · {who} · {n} staff', { company: f.company, who: deps, n: f.staff })}</span>
                  </span>
                  <Status tone={st.tone}>{st.text}</Status>
                  <RowMenu actions={[
                    { label: tr('Edit'), onClick: () => openEdit(f) },
                    { label: f.active ? tr('Pause') : tr('Resume'), onClick: () => act(f, f.active ? 'pause' : 'resume') },
                    { label: tr('Guide for their developer'), onClick: () => setGuideFor(f) },
                    { label: tr('New signing secret'), onClick: () => act(f, 'secret'), hidden: !f.pushUrl },
                    { label: f.readKey ? tr('New read key') : tr('Let them read with a key'), onClick: () => act(f, 'key') },
                    { label: tr('Delete'), onClick: () => act(f, 'delete'), danger: true }
                  ]} />
                </header>

                <div className="af-lanes">
                  <section className={'af-lane' + (f.pushUrl ? '' : ' is-off')}>
                    <span className="af-lane-h">{tr('Sending to their site')}</span>
                    {f.pushUrl ? <>
                      <code className="af-url" title={f.pushUrl}>{hostOf(f.pushUrl)}</code>
                      <span className="af-figs">
                        <span><strong>{f.sentLast24h}</strong><small>{tr('sent in 24 h')}</small></span>
                        <span><strong>{f.resentLast24h || 0}</strong><small>{tr('sent again in 24 h')}</small></span>
                        <span className={f.pending ? 'is-wait' : ''}><strong>{f.pending}</strong><small>{tr('waiting')}</small></span>
                      </span>
                      {!f.failingSince && lastOk && lastOk.page && (
                        <p className="af-warn is-amber">{tr('Their site said OK, but with a whole web page instead of a short reply. That is usually its homepage answering, not the code that receives the clock-ins, so the records may not be saved. Ask their developer to check the address and the receiving code (see the reply under Recent sends).')}</p>
                      )}
                      {f.failingSince
                        ? <p className="af-warn">{tr('Not answering since {when}: {why} Trying again {next}.', { when: fmtWhen(f.failingSince), why: f.lastError, next: fmtWhen(f.nextAttemptAt) })}</p>
                        : <span className="dk-muted tl-small">{f.lastSuccessAt ? tr('Last sent {when}', { when: fmtWhen(f.lastSuccessAt) }) : tr('Nothing to send yet: new clock-ins go as they happen.')}</span>}
                      {t && <span className={'tl-small ' + (t.ok && !t.page ? 'af-ok' : t.ok ? 'af-amber' : 'af-bad')}>{t.ok ? tr('Test answered {code} in {ms} ms', { code: t.statusCode, ms: t.ms }) : tr('Test failed: {why}', { why: t.error })}</span>}
                      {t && t.answer && <span className="af-reply" title={t.answer}><small>{t.page ? tr('Their reply (a web page):') : tr('Their reply:')}</small> <code>{t.answer}</code></span>}
                      <span className="af-actions">
                        <button type="button" className="btn btn-secondary af-btn" disabled={!!busy || !f.active} onClick={() => act(f, 'test')}>{busy === f.id + 'test' ? tr('Sending…') : tr('Send a test')}</button>
                        <button type="button" className="btn btn-secondary af-btn" disabled={!f.active} onClick={() => { setRange({ from: daysAgo(7), to: todayISO() }); setFormError(null); setResendFor(f); }}>{tr('Send days again')}</button>
                      </span>
                    </> : <span className="dk-muted tl-small">{tr('Off: no address given. Edit the feed to add one.')}</span>}
                  </section>
                  <section className={'af-lane' + (f.readKey ? '' : ' is-off')}>
                    <span className="af-lane-h">{tr('Their system reads')}</span>
                    {f.readKey ? <>
                      <code className="af-url">{f.readKey.hint}…</code>
                      <span className="af-figs">
                        <span><strong>{f.readKey.reads.toLocaleString()}</strong><small>{tr('times read')}</small></span>
                      </span>
                      <span className="dk-muted tl-small">{f.readKey.lastReadAt ? tr('Last read {when}', { when: fmtWhen(f.readKey.lastReadAt) }) : tr('Not read yet.')}</span>
                    </> : <span className="dk-muted tl-small">{tr('Off: no read key. Use the menu to make one.')}</span>}
                  </section>
                </div>

                {f.deliveries.length > 0 && (
                  <details className="af-log">
                    <summary>{tr('Recent sends ({n})', { n: f.deliveries.length })}</summary>
                    <ul>
                      {f.deliveries.map((d) => (
                        <li key={d.id} className={d.ok ? 'is-ok' : 'is-bad'}>
                          <i aria-hidden="true" />
                          <span>{fmtWhen(d.at)}</span>
                          <span>{d.kind === 'test' ? tr('test') : d.kind === 'resend' ? tr('{n} sent again', { n: d.events }) : tr('{n} change(s)', { n: d.events })}</span>
                          <span className="dk-muted">{d.ok ? tr('accepted {code}', { code: d.statusCode }) : d.error}</span>
                          <span className="dk-muted">{d.ms != null ? d.ms + ' ms' : ''}</span>
                          {d.answer && (
                            <span className="af-reply" title={d.answer}>
                              {d.page && <Status tone="warn">{tr('web page')}</Status>}
                              <code>{d.answer}</code>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <p className="dk-muted tl-small af-foot">{tr('Set up {date}. Starts with clock-ins from then on; use Send days again for earlier days.', { date: fmtDate(f.createdAt) })}</p>
              </article>
            );
          })}
        </div>
      )}

      {editing && form && (
        <div className="dialog-backdrop" onClick={() => setEditing(null)}>
          <form className="dialog af-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{editing.id ? tr('Edit attendance feed') : tr('New attendance feed')}</h2>
            <div className="field">
              <label htmlFor="af-name">{tr('Name')}</label>
              <input id="af-name" className="input" value={form.name} maxLength={80} placeholder={tr('e.g. Star Bar schedule tracker')} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="af-company">{tr('Whose staff')}</label>
              <select id="af-company" className="input" value={form.companyId} disabled={!!editing.id} onChange={(e) => setForm({ ...form, companyId: e.target.value, departmentIds: [] })}>
                {data.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {company && company.departments.length > 1 && (
                <div className="af-deps" role="group" aria-label={tr('Departments')}>
                  <button type="button" className={'ppl-chip' + (!form.departmentIds.length ? ' is-on' : '')} onClick={() => setForm({ ...form, departmentIds: [] })}>{tr('Everyone')}</button>
                  {company.departments.map((d) => {
                    const on = form.departmentIds.includes(d.id);
                    return <button key={d.id} type="button" className={'ppl-chip' + (on ? ' is-on' : '')} aria-pressed={on}
                      onClick={() => setForm({ ...form, departmentIds: on ? form.departmentIds.filter((x) => x !== d.id) : [...form.departmentIds, d.id] })}>{d.name}</button>;
                  })}
                </div>
              )}
              <small className="dk-muted">{form.departmentIds.length ? tr('Only these departments.') : tr('Everyone in the company, now and later.')}</small>
            </div>
            <div className="field">
              <label htmlFor="af-url">{tr('Their address (optional)')}</label>
              <input id="af-url" className="input" type="url" inputMode="url" value={form.pushUrl} placeholder="https://publicfigah.com/api/bamboo-attendance" onChange={(e) => setForm({ ...form, pushUrl: e.target.value })} />
              <small className="dk-muted">{tr('Where their system receives the clock-ins. Their developer gives you this; it must start with https://. Leave it empty if their system will only read with a key.')}</small>
            </div>
            <label className="af-check">
              <input type="checkbox" checked={form.readKey} onChange={(e) => setForm({ ...form, readKey: e.target.checked })} />
              <span><strong>{tr('Let their system read with a key')}</strong><small className="dk-muted">{tr('Also useful for catching up: their system can ask for any days again.')}</small></span>
            </label>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? tr('Saving…') : editing.id ? tr('Save') : tr('Set it up')}</button>
            </div>
          </form>
        </div>
      )}

      {reveal && (
        <div className="dialog-backdrop">
          <div className="dialog af-dialog af-reveal" role="dialog" aria-modal="true">
            <h2>{reveal.isNew ? tr('"{name}" is set up', { name: reveal.feed.name }) : tr('Copy it now')}</h2>
            <p className="af-once">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
              <span>{tr('This is the only time these are shown. Give them to their developer privately (not in a group chat); they go in their system\'s settings. If one is lost, make a new one from the feed\'s menu.')}</span>
            </p>
            {reveal.secret && <CopyField label={tr('Signing secret — to check that each post came from Bamboo OS')} value={reveal.secret} />}
            {reveal.key && <CopyField label={tr('Read key — for their system to read the feed')} value={reveal.key} />}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setGuideFor(reveal.feed)}>{tr('Guide for their developer')}</button>
              <button type="button" className="btn btn-primary" onClick={() => setReveal(null)}>{tr('I have copied them')}</button>
            </div>
          </div>
        </div>
      )}

      {resendFor && (
        <div className="dialog-backdrop" onClick={() => setResendFor(null)}>
          <form className="dialog af-dialog" onClick={(e) => e.stopPropagation()} onSubmit={doResend}>
            <h2>{tr('Send days again')}</h2>
            <p className="dialog-body">{tr('Sends every attendance record on these days to {host} again, as it is now, marked as sent again. Use it for the days before the feed was set up, or if their system lost something. At most 93 days at a time.', { host: hostOf(resendFor.pushUrl) })}</p>
            <div className="af-range">
              <div className="field"><label htmlFor="af-from">{tr('From')}</label><input id="af-from" className="input" type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} required /></div>
              <div className="field"><label htmlFor="af-to">{tr('To')}</label><input id="af-to" className="input" type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} required /></div>
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setResendFor(null)}>{tr('Cancel')}</button>
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? tr('Sending…') : tr('Send them')}</button>
            </div>
          </form>
        </div>
      )}

      {guideFor && (
        <div className="dialog-backdrop" onClick={() => setGuideFor(null)}>
          <div className="dialog af-dialog af-guide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Guide for their developer')}</h2>
            <p className="dialog-body">{tr('Everything their developer needs to connect "{name}", without the secret and key (you give those separately). Save it as a file and send it to them.', { name: guideFor.name })}</p>
            <div className="af-guide-body">
              {guideSections(guideFor).map((s) => (
                <section key={s.title}>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  {s.code && <pre><code>{s.code}</code></pre>}
                </section>
              ))}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setGuideFor(null)}>{tr('Close')}</button>
              <button type="button" className="btn btn-primary" onClick={() => download(guideFor)}>{tr('Save the guide as a file')}</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
