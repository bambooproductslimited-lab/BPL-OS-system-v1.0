import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './AnnouncementsPage.css';

// Announcements. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): the key numbers (what is new to you, what asks
// you to confirm, what was published this month and — for publishers — how
// much of it has been read), what stands out, then the noticeboard: pinned
// first, a category colour on each, "New" on what you had not seen, a
// "Got it" button where the publisher asked people to confirm, and for
// publishers "read by 12 of 20" with who has not read it yet
// (announcements.service.js, migration 0082). Everything shown is marked
// read a moment after the page opens.

const CATEGORIES = [
  { key: 'general', label: msg('General') },
  { key: 'policy', label: msg('Policy') },
  { key: 'event', label: msg('Event') },
  { key: 'safety', label: msg('Safety') },
  { key: 'celebration', label: msg('Celebration') }
];
const catLabel = (key) => tr((CATEGORIES.find((c) => c.key === key) || CATEGORIES[0]).label);
const EMPTY_FORM = { title: '', body: '', category: 'general', audience: 'all', pinned: false, requiresAck: false, expiresOn: '' };
const LONG_BODY = 320;

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return tr('just now');
  if (mins < 60) return tr('{n} min ago', { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return tr('{n} h ago', { n: hrs });
  const days = Math.round(hrs / 24);
  if (days === 1) return tr('Yesterday');
  if (days < 7) return tr('{n} days ago', { n: days });
  return fmtDate(String(iso).slice(0, 10));
}
function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function audienceText(a) {
  if (a.audienceScope === 'company') return tr('{company} staff', { company: a.companyName || tr('One company') });
  if (a.audienceScope === 'department') return a.departmentName || tr('One department');
  return tr('All staff');
}

export default function AnnouncementsPage() {
  const { can } = useAuth();
  const canPublish = can('announcement.publish');

  const [items, setItems] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [newIds, setNewIds] = useState(() => new Set()); // unread when the page opened

  const [chip, setChip] = useState('current');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({});

  const [dialog, setDialog] = useState(null); // { mode: 'new' | 'edit', id }
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [readers, setReaders] = useState(null); // { a, list, tab }
  const [deleteTarget, setDeleteTarget] = useState(null);
  const markedRef = useRef(false);

  const load = useCallback(async (first) => {
    setError(null);
    try {
      const [rows, depts] = await Promise.all([api.get('/announcements'), api.get('/departments')]);
      setItems(rows);
      setDepartments(depts);
      if (first) setNewIds(new Set(rows.filter((a) => !a.read).map((a) => a.id)));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(true); }, [load]);

  // Mark what is on the noticeboard as read a moment after it is shown. The
  // "New" labels stay for this visit (newIds) so the reader can still spot
  // them.
  useEffect(() => {
    if (loading || markedRef.current) return undefined;
    const ids = items.filter((a) => !a.read && !a.expired).map((a) => a.id);
    markedRef.current = true;
    if (!ids.length) return undefined;
    const t = setTimeout(() => {
      api.post('/announcements/read', { ids }).then(() => setItems((list) => list.map((a) => (ids.includes(a.id) ? { ...a, read: true } : a)))).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [loading, items]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode }); });
    return Array.from(seen.values()).sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));
  }, [departments]);

  // ── actions ──────────────────────────────────────────────────────────
  function openNew() { setForm(EMPTY_FORM); setFormError(null); setDialog({ mode: 'new' }); }
  function openEdit(a) {
    setForm({
      title: a.title, body: a.body, category: a.category, pinned: a.pinned, requiresAck: a.requiresAck, expiresOn: a.expiresOn || '',
      audience: a.audienceScope === 'company' ? 'company:' + a.companyId : a.audienceScope === 'department' ? 'department:' + a.departmentId : 'all'
    });
    setFormError(null);
    setDialog({ mode: 'edit', id: a.id });
  }
  function payload() {
    const [scope, id] = form.audience.split(':');
    return {
      title: form.title, body: form.body, category: form.category, pinned: form.pinned, requiresAck: form.requiresAck, expiresOn: form.expiresOn || null,
      audience: scope, companyId: scope === 'company' ? id : undefined, departmentId: scope === 'department' ? id : undefined
    };
  }
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      if (dialog.mode === 'new') {
        const a = await api.post('/announcements', payload());
        setToast(a.audienceCount ? tr('Published. {n} people were notified.', { n: a.audienceCount }) : tr('Announcement published.'));
      } else {
        await api.patch('/announcements/' + dialog.id, payload());
        setToast(tr('Announcement updated.'));
      }
      setDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function togglePin(a) {
    try { await api.post('/announcements/' + a.id + '/pin', { pinned: !a.pinned }); await load(); } catch (err) { setError(err.message); }
  }
  async function confirmDelete() {
    try { await api.del('/announcements/' + deleteTarget.id); setDeleteTarget(null); setToast(tr('Announcement deleted.')); await load(); } catch (err) { setError(err.message); }
  }
  async function acknowledge(a) {
    try {
      await api.post('/announcements/' + a.id + '/acknowledge');
      setItems((list) => list.map((x) => (x.id === a.id ? { ...x, read: true, acknowledged: true } : x)));
      setToast(tr('Thanks, noted that you have read it.'));
    } catch (err) { setError(err.message); }
  }
  async function openReaders(a) {
    try { setReaders({ a, list: await api.get('/announcements/' + a.id + '/readers'), tab: 'unread' }); } catch (err) { setError(err.message); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const current = items.filter((a) => !a.expired);
  const isNew = (a) => newIds.has(a.id) || !a.read;
  const fresh = current.filter(isNew);
  const toConfirm = current.filter((a) => a.requiresAck && !a.acknowledged && !a.mine);
  const monthStart = isoDay(new Date()).slice(0, 7);
  const thisMonth = items.filter((a) => String(a.publishedAt).slice(0, 7) === monthStart);
  const pinned = current.filter((a) => a.pinned);
  const tracked = canPublish ? current.filter((a) => a.audienceCount > 0 && (Date.now() - new Date(a.publishedAt).getTime()) < 30 * 86400000) : [];
  const readRate = tracked.length ? Math.round((tracked.reduce((n, a) => n + a.readCount, 0) / tracked.reduce((n, a) => n + a.audienceCount, 0)) * 100) : null;

  const chipTest = {
    current: (a) => !a.expired,
    new: (a) => !a.expired && isNew(a),
    confirm: (a) => !a.expired && a.requiresAck && !a.acknowledged && !a.mine,
    pinned: (a) => !a.expired && a.pinned,
    mine: (a) => a.mine,
    ended: (a) => a.expired
  };
  function showOnly(key) { setChip(chip === key ? 'current' : key); jump('an-list'); }
  const visible = items
    .filter(chipTest[chip] || chipTest.current)
    .filter((a) => !category || a.category === category)
    .filter((a) => matchesQuery(search, a.title, a.body, a.publisherName, audienceText(a)));

  const stats = [
    { icon: 'spark', value: String(fresh.length), label: tr('new for you'), note: fresh.length ? tr('since you last looked') : tr('you are up to date'), tone: fresh.length ? 'good' : '', onClick: () => showOnly('new') },
    { icon: 'check', value: String(toConfirm.length), label: tr('to confirm'), note: tr('asks you to say you have read it'), tone: toConfirm.length ? 'alert' : '', onClick: () => showOnly('confirm') },
    { icon: 'calendar', value: String(thisMonth.length), label: tr('published this month'), note: tr('{n} pinned to the top', { n: pinned.length }), onClick: () => { setChip('current'); jump('an-list'); } },
    canPublish
      ? { icon: 'people', value: readRate === null ? '—' : readRate + '%', label: tr('read by their audience'), note: tr('announcements from the last 30 days'), tone: readRate !== null && readRate < 60 ? 'alert' : '', onClick: () => showOnly('mine') }
      : { icon: 'doc', value: String(current.length), label: tr('on the noticeboard'), note: tr('{n} ended', { n: items.length - current.length }) }
  ];

  const insights = [];
  toConfirm.slice(0, 2).forEach((a) => insights.push({ tone: 'warn', icon: 'check', text: tr('"{title}" asks you to confirm you have read it.', { title: a.title }), action: { label: tr('Show it'), run: () => showOnly('confirm') } }));
  if (canPublish) {
    const slow = current
      .filter((a) => a.audienceCount >= 3 && (Date.now() - new Date(a.publishedAt).getTime()) > 86400000 && a.readCount / a.audienceCount < 0.6)
      .sort((a, b) => a.readCount / a.audienceCount - b.readCount / b.audienceCount)[0];
    if (slow) insights.push({ tone: 'warn', icon: 'people', text: tr('Only {r} of {n} people have read "{title}" so far.', { r: slow.readCount, n: slow.audienceCount, title: slow.title }), action: { label: tr('See who'), run: () => openReaders(slow) } });
    const unconfirmed = current.filter((a) => a.requiresAck && a.audienceCount > a.ackCount).sort((a, b) => (b.audienceCount - b.ackCount) - (a.audienceCount - a.ackCount))[0];
    if (unconfirmed) insights.push({ tone: 'info', icon: 'check', text: tr('{n} people have not confirmed "{title}" yet.', { n: unconfirmed.audienceCount - unconfirmed.ackCount, title: unconfirmed.title }), action: { label: tr('See who'), run: () => openReaders(unconfirmed) } });
  }
  const today = isoDay(new Date());
  const ending = current.filter((a) => a.expiresOn && a.expiresOn >= today && Math.round((new Date(a.expiresOn + 'T00:00') - new Date(today + 'T00:00')) / 86400000) <= 3);
  if (ending.length) insights.push({ tone: 'info', icon: 'calendar', text: ending.length === 1 ? tr('"{title}" stops showing after {date}.', { title: ending[0].title, date: fmtDate(ending[0].expiresOn) }) : tr('{n} announcements stop showing in the next 3 days.', { n: ending.length }) });
  if (!fresh.length && !toConfirm.length && current.length) insights.push({ tone: 'good', icon: 'check', text: tr('You are up to date: nothing new since you last looked.') });

  const chips = [
    ['current', tr('On the board'), current.length],
    ['new', tr('New'), fresh.length],
    ['confirm', tr('To confirm'), toConfirm.length],
    ['pinned', tr('Pinned'), pinned.length],
    canPublish && ['mine', tr('Published by me'), items.filter((a) => a.mine).length],
    ['ended', tr('Ended'), items.length - current.length]
  ].filter(Boolean).filter(([k, , n]) => n > 0 || k === 'current' || k === chip);

  const readerRows = readers ? readers.list.filter((r) => (readers.tab === 'unread' ? !r.readAt : readers.tab === 'read' ? !!r.readAt : !!r.acknowledgedAt)) : [];

  return (
    <div className="dk an">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Announcements')}
        sub={canPublish
          ? tr('News and notices for staff. Everyone in the audience gets a notification; you can see who has read each one and, if you ask, who has confirmed it. Press a number to show only those.')
          : tr('News and notices for staff. New ones are marked; if an announcement asks you to confirm you have read it, press "Got it".')}
        actions={canPublish && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Publish announcement')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="an-list" title={tr('Noticeboard')} sub={tr('Pinned first, then the newest.')}>
        <div className="an-tools">
          <div className="an-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search announcements…')} /></div>
          <select className="input an-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
            <option value="">{tr('All categories')}</option>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{tr(c.label)}</option>)}
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, n]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{n}</span>
            </button>
          ))}
        </div>

        {visible.length ? (
          <div className="an-feed">
            {visible.map((a) => {
              const long = a.body.length > LONG_BODY;
              const open = expanded[a.id] || !long;
              return (
                <article key={a.id} className={'an-card is-' + a.category + (isNew(a) && !a.expired ? ' is-new' : '') + (a.expired ? ' is-ended' : '')}>
                  <div className="an-card-top">
                    <span className={'an-cat is-' + a.category}>{catLabel(a.category)}</span>
                    {a.pinned && (
                      <span className="an-pin">
                        <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6" /></svg>
                        {tr('Pinned')}
                      </span>
                    )}
                    {isNew(a) && !a.expired && <span className="an-new">{tr('New')}</span>}
                    {a.expired && <Status tone="muted">{tr('Ended {date}', { date: fmtDate(a.expiresOn) })}</Status>}
                    {canPublish && (
                      <span className="an-menu">
                        <RowMenu actions={[
                          { label: a.pinned ? tr('Unpin') : tr('Pin to the top'), onClick: () => togglePin(a) },
                          { label: tr('Edit'), onClick: () => openEdit(a) },
                          { label: tr('See who has read it'), onClick: () => openReaders(a) },
                          { label: tr('Delete'), onClick: () => setDeleteTarget(a), danger: true }
                        ]} />
                      </span>
                    )}
                  </div>
                  <h3 className="an-title">{a.title}</h3>
                  <div className="an-meta">
                    <Photo id={a.publishedBy} name={a.publisherName} photo={a.publisherPhoto} size={26} />
                    <span><strong>{a.publisherName}</strong> · {ago(a.publishedAt)}{a.updatedAt ? ' · ' + tr('edited') : ''}</span>
                    <span className="an-aud">{tr('For: {who}', { who: audienceText(a) })}</span>
                  </div>
                  <p className={'an-body' + (open ? '' : ' is-clamped')}>{a.body}</p>
                  {long && <button type="button" className="dk-link an-more" onClick={() => setExpanded({ ...expanded, [a.id]: !expanded[a.id] })}>{open ? tr('Show less') : tr('Read more')}</button>}
                  {(a.requiresAck || (canPublish && a.audienceCount !== undefined) || a.expiresOn) && (
                    <div className="an-foot">
                      {a.requiresAck && !a.mine && (a.acknowledged
                        ? <Status tone="good">{tr('You confirmed you have read this')}</Status>
                        : <button type="button" className="btn btn-primary an-btn" onClick={() => acknowledge(a)}>{tr('Got it, I have read this')}</button>)}
                      {canPublish && a.audienceCount !== undefined && (
                        <button type="button" className="an-reads" onClick={() => openReaders(a)}>
                          <span className="an-reads-bar" aria-hidden="true"><span style={{ width: (a.audienceCount ? Math.round((a.readCount / a.audienceCount) * 100) : 0) + '%' }} /></span>
                          <span>{a.audienceCount ? tr('Read by {r} of {n}', { r: a.readCount, n: a.audienceCount }) + (a.requiresAck ? ' · ' + tr('{c} confirmed', { c: a.ackCount }) : '') : tr('Nobody is in this audience yet')}</span>
                        </button>
                      )}
                      {a.expiresOn && !a.expired && <span className="dk-muted an-small">{tr('Shows until {date}', { date: fmtDate(a.expiresOn) })}</span>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="dk-empty an-empty">
            <p>{items.length ? tr('Nothing matches. Try another search or filter.') : tr('Nothing published yet')}</p>
            {(search || category || chip !== 'current') && items.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setCategory(''); setChip('current'); }}>{tr('Show all')}</button>}
            {canPublish && !items.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Publish announcement')}</button>}
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('New'), tr('Published since you last opened this page. Everything shown is marked as read after a moment.')],
        [tr('To confirm'), tr('The publisher asked everyone to say they have read it (for a policy or a safety notice, say). Press "Got it".')],
        [tr('Audience'), tr('Who it is for: all staff, one company\'s staff or one department. Only they see it and get a notification.')],
        [tr('Pinned'), tr('Kept at the top of the noticeboard until unpinned.')],
        [tr('Ended'), tr('Past its "show until" date. It is kept, but no longer shown on the board.')]
      ]} />

      {dialog && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog an-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{dialog.mode === 'new' ? tr('Publish announcement') : tr('Edit announcement')}</h2>
            <div className="field">
              <label htmlFor="ann-title">{tr('Title')}</label>
              <input id="ann-title" className="input" value={form.title} maxLength={120} onChange={(e) => setForm({ ...form, title: e.target.value })} required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="ann-body">{tr('Message')}</label>
              <textarea id="ann-body" className="input an-textarea" value={form.body} maxLength={2000} onChange={(e) => setForm({ ...form, body: e.target.value })} required />
              <span className="dk-muted an-small an-count">{form.body.length}/2000</span>
            </div>
            <div className="field">
              <span className="an-label">{tr('Category')}</span>
              <div className="an-cats" role="radiogroup" aria-label={tr('Category')}>
                {CATEGORIES.map((c) => (
                  <button key={c.key} type="button" role="radio" aria-checked={form.category === c.key} className={'an-cat is-' + c.key + (form.category === c.key ? ' is-on' : '')} onClick={() => setForm({ ...form, category: c.key })}>{tr(c.label)}</button>
                ))}
              </div>
            </div>
            <div className="an-form-grid">
              <div className="field">
                <label htmlFor="ann-audience">{tr('Audience')}</label>
                <select id="ann-audience" className="input" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
                  <option value="all">{tr('All staff')}</option>
                  {companies.length > 1 && (
                    <optgroup label={tr('One company')}>
                      {companies.map((c) => <option key={c.id} value={'company:' + c.id}>{tr('{company} staff', { company: c.name })}</option>)}
                    </optgroup>
                  )}
                  {companies.map((c) => (
                    <optgroup key={c.id} label={tr('Departments at {company}', { company: c.name })}>
                      {departments.filter((d) => d.companyId === c.id).map((d) => <option key={d.id} value={'department:' + d.id}>{tr('{name} only', { name: d.name })}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ann-until">{tr('Show until (optional)')}</label>
                <input id="ann-until" className="input" type="date" value={form.expiresOn} min={isoDay(new Date())} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
              </div>
            </div>
            <label className="an-check">
              <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
              <span><strong>{tr('Pin to the top')}</strong><span className="dk-muted">{tr('Stays above the others until unpinned.')}</span></span>
            </label>
            <label className="an-check">
              <input type="checkbox" checked={form.requiresAck} onChange={(e) => setForm({ ...form, requiresAck: e.target.checked })} />
              <span><strong>{tr('Ask people to confirm they have read it')}</strong><span className="dk-muted">{tr('They get a "Got it" button, and you can see who has not confirmed.')}</span></span>
            </label>
            {dialog.mode === 'new' && <p className="dk-muted an-small">{tr('Everyone in the audience gets a notification when you publish.')}</p>}
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : dialog.mode === 'new' ? tr('Publish') : tr('Save changes')}</button>
            </div>
          </form>
        </div>
      )}

      {readers && (
        <div className="dialog-backdrop" onClick={() => setReaders(null)}>
          <div className="dialog an-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{readers.a.title}</h2>
            <p className="dk-muted an-small">{tr('For: {who}', { who: audienceText(readers.a) })} · {tr('published {when}', { when: ago(readers.a.publishedAt) })}</p>
            <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
              {[
                ['unread', tr('Not read yet'), readers.list.filter((r) => !r.readAt).length],
                ['read', tr('Read'), readers.list.filter((r) => r.readAt).length],
                readers.a.requiresAck && ['acked', tr('Confirmed'), readers.list.filter((r) => r.acknowledgedAt).length]
              ].filter(Boolean).map(([key, label, n]) => (
                <button key={key} type="button" role="radio" aria-checked={readers.tab === key} className={'ppl-chip' + (readers.tab === key ? ' is-on' : '')} onClick={() => setReaders({ ...readers, tab: key })}>
                  {label} <span className="ppl-chip-n">{n}</span>
                </button>
              ))}
            </div>
            {readerRows.length ? (
              <ul className="an-readers">
                {readerRows.map((r) => (
                  <li key={r.id}>
                    <Photo id={r.id} name={r.name} photo={r.photo} size={30} />
                    <span className="an-reader-text"><strong>{r.name}</strong><span className="dk-muted">{r.department}</span></span>
                    <span className="dk-muted an-small">
                      {r.acknowledgedAt ? tr('confirmed {when}', { when: ago(r.acknowledgedAt) }) : r.readAt ? tr('read {when}', { when: ago(r.readAt) }) : tr('not yet')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="dk-muted an-small">{readers.tab === 'unread' ? tr('Everyone has read it.') : tr('Nobody yet.')}</p>}
            <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={() => setReaders(null)}>{tr('Close')}</button></div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete announcement')}</h2>
            <p className="dialog-body">{tr('Delete')} <strong>{deleteTarget.title}</strong>{tr('? This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" onClick={confirmDelete}>{tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
