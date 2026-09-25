import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import { msg, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';

// Poki's tenant register. Deliberately separate from Bamboo Products'
// client list: a tenant carries things a sales customer doesn't (ID
// document, next of kin, employer). Underneath, a tenant extends a customer
// row scoped to Poki, which is what lets rent invoices work unchanged.
// Same "explains itself" layout as the dashboards (components/DashKit.jsx):
// the key numbers (tenants in residence, owing, prospects, missing ID), what
// stands out (who is behind and by how long, tenancies ending, prospects
// never booked, missing ID or next of kin), and the tenants as cards or a
// list — each with what they owe, a call or WhatsApp button, and a window
// with their details, every booking and what they have paid
// (poki.service.js listTenants).

const STATUSES = [{ key: 'prospect', label: msg('Prospect') }, { key: 'active', label: msg('Active') }, { key: 'former', label: msg('Former') }, { key: 'blacklisted', label: msg('Blacklisted') }];
const EMPTY = {
  name: '', tenantType: 'individual', contactPerson: '', email: '', phone: '', address: '',
  idType: 'Ghana Card', idNumber: '', occupation: '', employer: '',
  emergencyContactName: '', emergencyContactPhone: '', nextOfKinName: '', nextOfKinPhone: '',
  status: 'active', notes: ''
};

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(String(iso).slice(0, 10) + 'T00:00') - t) / 86400000);
}
function statusLabel(s) { return tr((STATUSES.find((x) => x.key === s) || STATUSES[1]).label); }
function inResidence(t) { return t.activeBookings > 0; }
function owes(t) { return t.owed && t.owed.length > 0; }
function missingId(t) { return t.status !== 'former' && !t.idNumber; }
function missingKin(t) { return t.status !== 'former' && t.tenantType === 'individual' && !t.nextOfKinPhone && !t.emergencyContactPhone; }
function Avatar({ t, size = 44 }) {
  return <span className="pk-avatar" style={{ width: size, height: size, background: avatarColor(t.name), fontSize: Math.round(size * 0.36) }} aria-hidden="true">{initials(t.name)}</span>;
}

export default function PokiTenantsPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');
  const navigate = useNavigate();

  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('current');
  const [view, setView] = useState(() => readPref('bos.pokiTenantsView', 'cards'));

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [bookings, setBookings] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTenants(await api.get('/poki/tenants'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    setBookings(null);
    if (!detail) return;
    api.get('/poki/bookings?tenantId=' + detail).then(setBookings).catch(() => setBookings([]));
  }, [detail]);

  function openDialog(t) {
    setDialogError(null);
    setEditId(t ? t.id : null);
    const f = { ...EMPTY };
    if (t) Object.keys(EMPTY).forEach((k) => { f[k] = t[k] === null || t[k] === undefined ? '' : t[k]; });
    setForm(f);
    setDetail(null);
    setOpen(true);
  }
  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.patch('/poki/tenants/' + editId, form);
      else await api.post('/poki/tenants', form);
      setToast(editId ? tr('Tenant updated.') : tr('Tenant added.'));
      setOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function setStatus(t, status) {
    try { await api.patch('/poki/tenants/' + t.id, { status }); setToast(tr('{name} is now {status}.', { name: t.name, status: statusLabel(status).toLowerCase() })); await load(); } catch (err) { setError(err.message); }
  }
  async function remove(t) {
    if (!window.confirm(tr('Delete {name}? This cannot be undone.', { name: t.name }))) return;
    try {
      await api.del('/poki/tenants/' + t.id);
      setToast(tr('Tenant deleted.'));
      setDetail(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const current = tenants.filter((t) => t.status !== 'former' && t.status !== 'blacklisted');
  const living = tenants.filter(inResidence);
  const owing = tenants.filter(owes);
  const behind = tenants.filter((t) => t.overdue && t.overdue.length).sort((x, y) => y.daysOverdue - x.daysOverdue);
  const prospects = tenants.filter((t) => t.status === 'prospect' || (t.status === 'active' && !t.bookings && !t.nextStart));
  const staleProspects = prospects.filter((t) => !t.nextStart && t.createdAt && -daysUntil(t.createdAt) >= 14);
  const noId = tenants.filter(missingId);
  const noKin = living.filter(missingKin);
  const ending = living.filter((t) => t.currentEnd && daysUntil(t.currentEnd) <= 30).sort((x, y) => String(x.currentEnd).localeCompare(String(y.currentEnd)));
  const owedTotals = {};
  owing.forEach((t) => t.owed.forEach((o) => { owedTotals[o.currency] = (owedTotals[o.currency] || 0) + o.amount; }));
  const owedText = Object.entries(owedTotals).map(([c, a]) => money(a, c)).join(' · ');

  function showOnly(key) { setChip(chip === key ? 'current' : key); jump('pk-tenants'); }
  const stats = [
    { icon: 'people', value: String(living.length), label: tr('in residence'), note: tr('{n} tenants on the register', { n: tenants.length }), onClick: () => showOnly('living') },
    { icon: 'owed', value: String(owing.length), label: tr('owing rent'), note: owedText || tr('nobody owes anything'), tone: behind.length ? 'bad' : owing.length ? 'alert' : 'good', onClick: () => showOnly('owing') },
    { icon: 'spark', value: String(prospects.length), label: tr('not yet booked'), note: tr('prospects and new tenants'), onClick: () => showOnly('prospects') },
    { icon: 'doc', value: String(noId.length), label: tr('with no ID on file'), note: noKin.length ? tr('{n} in residence with no one to call', { n: noKin.length }) : tr('everyone reachable'), tone: noId.length ? 'alert' : '', onClick: () => showOnly('noid') }
  ];

  const insights = [];
  if (behind.length) insights.push({ tone: 'bad', icon: 'owed', text: behind.length === 1 ? tr('{name} is {days} days behind and owes {amount}.', { name: behind[0].name, days: behind[0].daysOverdue, amount: moneyBreakdown(behind[0].overdue) }) : tr('{n} tenants are behind; {name} the longest, {days} days.', { n: behind.length, name: behind[0].name, days: behind[0].daysOverdue }), action: { label: behind.length === 1 ? tr('Open') : tr('Show them'), run: () => (behind.length === 1 ? setDetail(behind[0].id) : showOnly('behind')) } });
  if (ending.length) insights.push({ tone: 'warn', icon: 'calendar', text: ending.length === 1 ? tr('{name}\'s booking ends {date}. Ask whether they are renewing.', { name: ending[0].name, date: fmtDate(ending[0].currentEnd) }) : tr('{n} tenants\' bookings end in the next 30 days.', { n: ending.length }), action: { label: tr('Show them'), run: () => showOnly('ending') } });
  if (staleProspects.length) insights.push({ tone: 'info', icon: 'spark', text: staleProspects.length === 1 ? tr('{name} was added {date} but has never been booked.', { name: staleProspects[0].name, date: fmtDate(staleProspects[0].createdAt) }) : tr('{n} prospects were added over two weeks ago and never booked.', { n: staleProspects.length }), action: canManage ? { label: tr('Make a letting offer'), run: () => navigate('/pokiestimates') } : { label: tr('Show them'), run: () => showOnly('prospects') } });
  if (noKin.length) insights.push({ tone: 'info', icon: 'phone', text: noKin.length === 1 ? tr('{name} lives in a unit but has no next of kin or emergency contact on file.', { name: noKin[0].name }) : tr('{n} tenants in residence have no next of kin or emergency contact on file.', { n: noKin.length }), action: canManage && noKin.length === 1 ? { label: tr('Add it'), run: () => openDialog(noKin[0]) } : { label: tr('Show them'), run: () => showOnly('nokin') } });
  if (noId.length) insights.push({ tone: 'info', icon: 'doc', text: noId.length === 1 ? tr('{name} has no ID number on file.', { name: noId[0].name }) : tr('{n} tenants have no ID number on file.', { n: noId.length }), action: { label: tr('Show them'), run: () => showOnly('noid') } });
  if (!insights.length && tenants.length) insights.push({ tone: 'good', icon: 'check', text: tr('Everyone is paid up and every tenant has their details on file.') });

  const chipTest = {
    current: (t) => t.status !== 'former' && t.status !== 'blacklisted', living: inResidence, owing: owes, behind: (t) => behind.includes(t),
    ending: (t) => ending.includes(t), prospects: (t) => prospects.includes(t), noid: missingId, nokin: (t) => noKin.includes(t),
    former: (t) => t.status === 'former', blacklisted: (t) => t.status === 'blacklisted', all: () => true
  };
  const visible = tenants.filter(chipTest[chip] || chipTest.current)
    .filter((t) => matchesQuery(search, t.name, t.email, t.phone, t.unitLabels, t.idNumber, t.contactPerson, t.employer));
  const chips = [
    ['current', tr('Current'), current.length], ['living', tr('In residence'), living.length], ['owing', tr('Owing'), owing.length],
    ['behind', tr('Overdue'), behind.length], ['ending', tr('Ending soon'), ending.length], ['prospects', tr('Not yet booked'), prospects.length],
    ['noid', tr('No ID'), noId.length], ['nokin', tr('No one to call'), noKin.length],
    ['former', tr('Former'), tenants.filter(chipTest.former).length], ['blacklisted', tr('Blacklisted'), tenants.filter(chipTest.blacklisted).length]
  ].filter(([k, , c]) => c > 0 || k === 'current' || k === chip);

  function stateOf(t) {
    if (t.status === 'blacklisted') return { tone: 'bad', text: tr('Blacklisted') };
    if (t.status === 'former') return { tone: 'muted', text: tr('Former') };
    if (inResidence(t)) {
      const d = daysUntil(t.currentEnd);
      return { tone: d !== null && d <= 30 ? 'warn' : 'good', text: t.unitLabels ? tr('In {units} until {date}', { units: t.unitLabels, date: fmtDate(t.currentEnd) }) : tr('In residence') };
    }
    if (t.nextStart) return { tone: 'info', text: tr('Moves in {date}', { date: fmtDate(t.nextStart) }) };
    return { tone: 'muted', text: t.bookings ? tr('Between bookings') : tr('Not yet booked') };
  }
  function actionsFor(t) {
    return [
      { label: tr('Open'), onClick: () => setDetail(t.id) },
      canManage && { label: tr('Edit'), onClick: () => openDialog(t) },
      canManage && !inResidence(t) && t.status !== 'blacklisted' && { label: tr('Book a unit'), onClick: () => navigate('/pokibookings?tenant=' + t.id) },
      canManage && t.status !== 'former' && !inResidence(t) && { label: tr('Mark as former'), onClick: () => setStatus(t, 'former') },
      canManage && t.status === 'former' && { label: tr('Mark as active'), onClick: () => setStatus(t, 'active') },
      canManage && !t.bookings && { label: tr('Delete'), onClick: () => remove(t), danger: true }
    ].filter(Boolean);
  }

  const cur = detail ? tenants.find((t) => t.id === detail) : null;

  return (
    <div className="dk tl pk">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Poki Rentals')}
        title={tr('Tenants')}
        sub={tr('The people and companies renting from Poki: where each one lives, what they owe, and how to reach them — and who to call if something happens. Press a number to show only those.')}
        actions={canManage && <button type="button" className="btn btn-primary" onClick={() => openDialog(null)}>{tr('Add tenant')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="pk-tenants" title={tr('Tenants')} sub={tr('Press a tenant for their details, their bookings and what they have paid.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.pokiTenantsView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search tenants…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{tenants.length ? tr('Try a different search or status filter.') : tr('Add the people and companies renting from Poki. You can then put them on a booking against a unit.')}</p>
            {canManage && !tenants.length && <button type="button" className="btn btn-primary" onClick={() => openDialog(null)}>{tr('Add tenant')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((t) => {
              const st = stateOf(t);
              return (
                <article key={t.id} className={'tl-card' + (t.overdue && t.overdue.length ? ' st-late' : '') + (t.status === 'former' ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(t.id)}>
                    <Avatar t={t} />
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{codeLabel(t.tenantType)}{t.occupation ? ' · ' + t.occupation : ''}</span>
                      <span className="tl-name">{t.name}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu actions={actionsFor(t)} /></span>
                  <div className="tl-tags">
                    <Status tone={st.tone}>{st.text}</Status>
                    {t.overdue && t.overdue.length > 0 && <Status tone="bad">{tr('{days} days behind', { days: t.daysOverdue })}</Status>}
                  </div>
                  <div className="tl-foot">
                    <span className="tl-small">{owes(t) ? <><strong className="pk-owe">{moneyBreakdown(t.owed)}</strong> <span className="dk-muted">{tr('owed')}</span></> : <span className="dk-muted">{t.bookings ? tr('Paid up') : t.phone || t.email || tr('no phone')}</span>}</span>
                    <ContactButtons name={t.name} phone={t.phone} email={t.email} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Tenant')}</th><th>{tr('Where')}</th><th className="is-num">{tr('Owed')}</th><th>{tr('Contact')}</th><th /></tr></thead>
              <tbody>
                {visible.map((t) => {
                  const st = stateOf(t);
                  return (
                    <tr key={t.id}>
                      <td><button type="button" className="tl-row-open" onClick={() => setDetail(t.id)}><Avatar t={t} size={32} /><span><span className="tl-name">{t.name}</span><span className="dk-muted tl-small">{codeLabel(t.tenantType)}</span></span></button></td>
                      <td><Status tone={st.tone}>{st.text}</Status></td>
                      <td className="is-num">{owes(t) ? <span className={t.overdue.length ? 'pk-owe' : ''}>{moneyBreakdown(t.owed)}</span> : '—'}</td>
                      <td><ContactButtons name={t.name} phone={t.phone} email={t.email} /></td>
                      <td className="tl-menu-cell"><RowMenu actions={actionsFor(t)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('In residence'), tr('A booking of theirs is running now.')],
        [tr('Owing'), tr('Invoices of theirs not fully paid. Overdue, or behind, means past the due date.')],
        [tr('Prospect'), tr('Someone interested who has not taken a unit yet.')],
        [tr('Former'), tr('Used to rent from Poki. Their history is kept.')],
        [tr('Blacklisted'), tr('Not to be let to again.')]
      ]} />

      {/* ── one tenant ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Avatar t={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{codeLabel(cur.tenantType)}{cur.since ? ' · ' + tr('with Poki since {date}', { date: fmtDate(cur.since) }) : ''}</span>
                <h2>{cur.name}</h2>
                <div className="tl-tags"><Status tone={stateOf(cur).tone}>{stateOf(cur).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <div className="tl-holder is-inline">
              <div className="tl-holder-head">
                <span className="tl-holder-name"><strong>{cur.phone || tr('no phone')}</strong><span className="dk-muted tl-small">{[cur.email, cur.contactPerson && tr('contact: {name}', { name: cur.contactPerson })].filter(Boolean).join(' · ') || tr('no email')}</span></span>
                <ContactButtons name={cur.name} phone={cur.phone} email={cur.email} />
              </div>
            </div>
            <dl className="tl-facts">
              <div><dt>{tr('Owes')}</dt><dd className={cur.overdue && cur.overdue.length ? 'pk-owe' : ''}>{owes(cur) ? moneyBreakdown(cur.owed) : tr('nothing')}{cur.overdue && cur.overdue.length ? ' · ' + tr('{days} days behind', { days: cur.daysOverdue }) : ''}</dd></div>
              <div><dt>{tr('Paid in all')}</dt><dd>{cur.paid && cur.paid.length ? moneyBreakdown(cur.paid) : '—'}</dd></div>
              <div><dt>{tr('Deposit held')}</dt><dd>{cur.depositHeld ? money(cur.depositHeld) : '—'}</dd></div>
              <div><dt>{tr('ID')}</dt><dd>{cur.idNumber ? cur.idType + ' · ' + cur.idNumber : <span className="pk-owe">{tr('not on file')}</span>}</dd></div>
              {cur.tenantType === 'individual' && <div><dt>{tr('Work')}</dt><dd>{[cur.occupation, cur.employer].filter(Boolean).join(' · ') || '—'}</dd></div>}
              {cur.tenantType === 'individual' && <div><dt>{tr('Next of kin')}</dt><dd>{cur.nextOfKinName ? cur.nextOfKinName + (cur.nextOfKinPhone ? ' · ' + cur.nextOfKinPhone : '') : '—'}</dd></div>}
              <div><dt>{tr('Emergency contact')}</dt><dd>{cur.emergencyContactName ? cur.emergencyContactName + (cur.emergencyContactPhone ? ' · ' + cur.emergencyContactPhone : '') : '—'}</dd></div>
              {cur.address && <div><dt>{tr('Address')}</dt><dd>{cur.address}</dd></div>}
            </dl>
            {cur.notes && <p className="tl-notes">{cur.notes}</p>}
            <h3 className="tl-h3">{tr('Bookings')}</h3>
            {bookings === null ? <p className="dk-muted tl-small">{tr('Loading…')}</p> : bookings.length ? (
              <ul className="pk-list">
                {bookings.map((b) => (
                  <li key={b.id}>
                    <span className="pk-list-main"><strong>{b.unitCode} · {b.propertyName}</strong><span className="dk-muted tl-small">{b.bookingNo} · {fmtDate(b.startDate)} – {fmtDate(b.endDate)} · {b.durationLabel}</span></span>
                    <span className="pk-list-side">
                      <strong>{money(b.rentTotal, b.currency)}</strong>
                      {b.balanceTotal > 0 ? <Status tone="warn">{tr('{amount} still to pay', { amount: money(b.balanceTotal, b.currency) })}</Status> : <Status tone={b.status === 'active' ? 'good' : 'muted'}>{codeLabel(b.status)}</Status>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="dk-muted tl-small">{tr('Never booked.')}</p>}
            <div className="dialog-actions tl-actions">
              {canManage && !cur.bookings && <button type="button" className="btn btn-secondary" onClick={() => remove(cur)}>{tr('Delete')}</button>}
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => openDialog(cur)}>{tr('Edit')}</button>}
              {owes(cur) && <Link className="btn btn-secondary" to="/pokibilling">{tr('Record a payment')}</Link>}
              {canManage && !inResidence(cur) && cur.status !== 'blacklisted' ? <Link className="btn btn-primary" to={'/pokibookings?tenant=' + cur.id}>{tr('Book a unit')}</Link> : <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── add / edit ── */}
      {open && (
        <div className="dialog-backdrop" onClick={() => !saving && setOpen(false)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2>{editId ? tr('Edit tenant') : tr('Add tenant')}</h2>
            <div className="tl-seg" role="radiogroup" aria-label={tr('Type')}>
              {[['individual', tr('Individual')], ['company', tr('Company')]].map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={form.tenantType === k} className={'tl-seg-btn' + (form.tenantType === k ? ' is-on' : '')} onClick={() => setForm({ ...form, tenantType: k })}>{label}</button>)}
            </div>
            <div className="tl-form">
              <div className="field tl-span">
                <label htmlFor="pt-name">{tr('Name')}</label>
                <input id="pt-name" className="input" maxLength={160} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              {form.tenantType === 'company' && (
                <div className="field tl-span">
                  <label htmlFor="pt-contact">{tr('Contact person')}</label>
                  <input id="pt-contact" className="input" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} />
                </div>
              )}
              <div className="field">
                <label htmlFor="pt-phone">{tr('Phone')}</label>
                <input id="pt-phone" className="input" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="024 000 0000" />
              </div>
              <div className="field">
                <label htmlFor="pt-email">{tr('Email')}</label>
                <input id="pt-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="field tl-span">
                <label htmlFor="pt-address">{tr('Address')}</label>
                <input id="pt-address" className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pt-idtype">{tr('ID type')}</label>
                <input id="pt-idtype" className="input" list="pt-idtypes" value={form.idType} onChange={(e) => setForm({ ...form, idType: e.target.value })} placeholder={tr('Ghana Card / TIN / Passport')} />
                <datalist id="pt-idtypes"><option value="Ghana Card" /><option value="Passport" /><option value="TIN" /><option value="Driver's licence" /></datalist>
              </div>
              <div className="field">
                <label htmlFor="pt-idnum">{tr('ID number')}</label>
                <input id="pt-idnum" className="input" value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} />
              </div>
              {form.tenantType === 'individual' && (
                <>
                  <div className="field">
                    <label htmlFor="pt-occ">{tr('Occupation')}</label>
                    <input id="pt-occ" className="input" value={form.occupation} onChange={(e) => setForm({ ...form, occupation: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="pt-emp">{tr('Employer')}</label>
                    <input id="pt-emp" className="input" value={form.employer} onChange={(e) => setForm({ ...form, employer: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="pt-nok">{tr('Next of kin')}</label>
                    <input id="pt-nok" className="input" value={form.nextOfKinName} onChange={(e) => setForm({ ...form, nextOfKinName: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="pt-nokp">{tr('Next of kin phone')}</label>
                    <input id="pt-nokp" className="input" type="tel" value={form.nextOfKinPhone} onChange={(e) => setForm({ ...form, nextOfKinPhone: e.target.value })} />
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="pt-emg">{tr('Emergency contact')}</label>
                <input id="pt-emg" className="input" value={form.emergencyContactName} onChange={(e) => setForm({ ...form, emergencyContactName: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pt-emgp">{tr('Emergency phone')}</label>
                <input id="pt-emgp" className="input" type="tel" value={form.emergencyContactPhone} onChange={(e) => setForm({ ...form, emergencyContactPhone: e.target.value })} />
              </div>
              <div className="field tl-span">
                <span className="tl-label">{tr('Status')}</span>
                <div className="tl-seg" role="radiogroup" aria-label={tr('Status')}>
                  {STATUSES.map((s) => <button key={s.key} type="button" role="radio" aria-checked={form.status === s.key} className={'tl-seg-btn' + (s.key === 'blacklisted' ? ' is-poor' : '') + (form.status === s.key ? ' is-on' : '')} onClick={() => setForm({ ...form, status: s.key })}>{tr(s.label)}</button>)}
                </div>
              </div>
              <div className="field tl-span">
                <label htmlFor="pt-notes">{tr('Notes (optional)')}</label>
                <textarea id="pt-notes" className="input tl-textarea" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
