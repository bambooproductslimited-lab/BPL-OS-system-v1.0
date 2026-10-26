import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import { PhotoPick, TillPhoto } from './CashOffice';
import './fifteenth.css';

// The fifteenth batch on the till (migration 0196):
//  - More → Something broken? Anyone on the till says which piece of
//    equipment, whether it still works, what is wrong, with a photo; the
//    office is told (restaurantEquipment report).
//  - Back office → Reports → Bills: what the restaurant owes its suppliers,
//    a bill entered with its photo (bills.service tillTab). Purchase orders
//    received and not paid at the door land here by themselves.
//  - Back office → Setup → Equipment: every fridge, cooker and generator,
//    problems open (planned, fixed with what it cost, taken off the list),
//    services due, equipment added (restaurantEquipment tab).

const URGENCY = {
  stopped: ['🛑', msg('It stopped working'), msg('Out of use until it is fixed')],
  unsafe: ['⚠️', msg('It is not safe'), msg('Nobody should use it')],
  working: ['🔧', msg('It still works, but…'), msg('It can wait a little')]
};
const EQUIP_ICON = { 'Fridge and freezer': '🧊', Cooking: '🔥', 'Coffee and drinks': '☕', 'Power and gas': '⚡', 'Air and water': '💨', Furniture: '🪑', Electronics: '📺', Other: '⚙️' };
const EQUIP_LABEL = {
  'Fridge and freezer': msg('Fridge and freezer'), Cooking: msg('Cooking'), 'Coffee and drinks': msg('Coffee and drinks'), 'Power and gas': msg('Power and gas'),
  'Air and water': msg('Air and water'), Furniture: msg('Furniture'), Electronics: msg('Electronics'), Other: msg('Other')
};
const BILL_CAT = {
  stock: ['📦', msg('Stock and food')], utilities: ['💡', msg('Power, water, gas')], rent: ['🏠', msg('Rent')], services: ['🧰', msg('Services')],
  equipment: ['🛠️', msg('Equipment and repairs')], transport: ['🚚', msg('Transport')], staff: ['👥', msg('Staff costs')], other: ['🧾', msg('Other')]
};
function equipLabel(c) { return EQUIP_LABEL[c] ? tr(EQUIP_LABEL[c]) : c; }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function dayText(day) { return day ? new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—'; }
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return tr('{n} min ago', { n: Math.max(1, m) });
  if (m < 1440) return tr('{n} h ago', { n: Math.round(m / 60) });
  return new Date(iso).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' });
}
function dueWords(b) {
  if (b.status === 'paid') return tr('Paid');
  if (b.status === 'cancelled') return tr('Cancelled');
  if (b.daysLeft < 0) return b.daysLeft === -1 ? tr('1 day late') : tr('{n} days late', { n: -b.daysLeft });
  if (b.daysLeft === 0) return tr('Due today');
  return b.daysLeft === 1 ? tr('Due tomorrow') : tr('Due in {n} days', { n: b.daysLeft });
}

// More → Something broken?
export function BrokenDialog({ token, onClose, onDone }) {
  const [list, setList] = useState(null);
  const [assetId, setAssetId] = useState('');
  const [urgency, setUrgency] = useState('');
  const [what, setWhat] = useState('');
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { posFetch('GET', '/pos/equipment', token).then((d) => setList(d.equipment)).catch((e) => setError(e.message)); }, [token]);
  const picked = list && list.find((e) => e.id === assetId);
  async function go(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/equipment/report', token, { assetId, urgency, what, photo: photo || undefined });
      onDone(tr('{name}: reported. The office was told.', { name: r.name }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog cof brk" role="dialog" aria-modal="true" aria-labelledby="brk-title" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <div className="cof-head">
          <span className="cof-head-art is-broken" aria-hidden="true">🛠️</span>
          <div><h2 id="brk-title">{tr('Something broken?')}</h2><p>{tr('Say which one and what is wrong. The office is told at once.')}</p></div>
        </div>
        {!list ? <p className="dk-muted">{error || tr('Loading…')}</p> : !list.length ? (
          <p className="brk-none">{tr('No equipment is listed for this restaurant yet. A manager adds it in the back office: Setup → Equipment.')}</p>
        ) : (
          <>
            <div className="brk-grid" role="radiogroup" aria-label={tr('Which one?')}>
              {list.map((e) => (
                <button key={e.id} type="button" role="radio" aria-checked={assetId === e.id} className={'brk-eq' + (assetId === e.id ? ' is-on' : '') + (e.status === 'in_repair' ? ' is-repair' : '')} onClick={() => setAssetId(e.id)}>
                  <em aria-hidden="true">{EQUIP_ICON[e.category] || '⚙️'}</em>
                  <b>{e.name}</b>
                  <small>{e.location || equipLabel(e.category)}</small>
                  {e.open > 0 && <i>{tr('Reported')}</i>}
                </button>
              ))}
            </div>
            {picked && (
              <div className="brk-urgency" role="radiogroup" aria-label={tr('Does it still work?')}>
                {Object.keys(URGENCY).map((u) => (
                  <button key={u} type="button" role="radio" aria-checked={urgency === u} className={'brk-u is-' + u + (urgency === u ? ' is-on' : '')} onClick={() => setUrgency(u)}>
                    <em aria-hidden="true">{URGENCY[u][0]}</em><b>{tr(URGENCY[u][1])}</b><small>{tr(URGENCY[u][2])}</small>
                  </button>
                ))}
              </div>
            )}
            {picked && urgency && (
              <>
                <textarea className="input" rows={2} maxLength={300} value={what} onChange={(e) => setWhat(e.target.value)} placeholder={tr('What is wrong? e.g. not cooling, 12° inside')} aria-label={tr('What is wrong?')} autoFocus />
                <PhotoPick value={photo} onChange={setPhoto} label={tr('A photo of the problem')} hint={tr('It helps the technician bring the right part.')} />
              </>
            )}
          </>
        )}
        {error && list && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !picked || !urgency || what.trim().length < 3}>📨 {tr('Tell the office')}</button>
        </div>
      </form>
    </div>
  );
}

// Back office → Reports → Bills.
export function TillBillsTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const call = useCallback((body) => posFetch('POST', '/pos/settings/bills', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'list' }).then(setData).catch(onFail); }, [call, onFail]);
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const s = data.summary;
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await call({ action: 'save', bill: { ...adding, amount: Number(adding.amount) } });
      setData(d); setAdding(null);
      setFlash(d.done.status === 'to_approve' ? '✍️ ' + tr('{ref} entered. Over {amount}, it waits for the office to approve it.', { ref: d.done.ref, amount: money(data.approveOver) }) : '🧾 ' + tr('{ref} entered.', { ref: d.done.ref }));
    } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  const open = data.bills.filter((b) => b.status === 'to_approve' || b.status === 'approved');
  const done = data.bills.filter((b) => b.status !== 'to_approve' && b.status !== 'approved');
  const row = (b) => (
    <div key={b.id} className={'tbl-row is-' + b.state}>
      <em aria-hidden="true">{(BILL_CAT[b.category] || BILL_CAT.other)[0]}</em>
      <span className="tbl-who"><b>{b.supplierName}</b><small>{b.ref}{b.reference ? ' · ' + b.reference : ''}{b.purchaseOrder ? ' · ' + b.purchaseOrder.ref : ''}</small></span>
      <span className="tbl-when"><i className={'tbl-pill is-' + b.state}>{dueWords(b)}</i>{b.status === 'to_approve' && <i className="tbl-pill is-approve">✍️ {tr('To approve')}</i>}</span>
      <span className="tbl-amt"><b>{money(b.status === 'approved' || b.status === 'to_approve' ? b.balance : b.amount)}</b>{b.paid > 0 && b.balance > 0 && <small>{tr('of {amount}', { amount: money(b.amount) })}</small>}</span>
      {b.files.length > 0 && <TillPhoto path={'/pos/bills/' + b.id + '/files/0'} token={token} label={b.ref} />}
    </div>
  );
  return (
    <section className="ts-sec tbl">
      {flash && <div className="ts-flash" role="status">{flash}</div>}
      <div className="tbl-cards">
        <div className="tbl-card is-bad"><small>⏰ {tr('Overdue')}</small><b>{money(s.overdue.amount)}</b><span>{s.overdue.n === 1 ? tr('1 bill') : tr('{n} bills', { n: s.overdue.n })}</span></div>
        <div className="tbl-card is-warn"><small>📅 {tr('Due this week')}</small><b>{money(s.week.amount)}</b><span>{s.week.n === 1 ? tr('1 bill') : tr('{n} bills', { n: s.week.n })}</span></div>
        <div className="tbl-card is-calm"><small>🗓️ {tr('Later')}</small><b>{money(s.later.amount)}</b><span>{s.later.n === 1 ? tr('1 bill') : tr('{n} bills', { n: s.later.n })}</span></div>
        <div className="tbl-card is-good"><small>✅ {tr('Paid this month')}</small><b>{money(s.paidThisMonth)}</b><span>{tr('by the office')}</span></div>
      </div>
      <p className="tbl-hint">💡 {tr('The office pays the bills. Enter one here when it arrives, with a photo; orders received and not paid at the door are here already.')}</p>
      {adding ? (
        <form className="cof-form tbl-form" onSubmit={save}>
          <h3>🧾 {tr('A bill that came in')}</h3>
          <div className="tbl-two">
            <label><span>{tr('Supplier')}</span>
              <input className="input" list="tbl-suppliers" required minLength={2} maxLength={120} value={adding.supplierName} onChange={(e) => setAdding({ ...adding, supplierName: e.target.value })} />
              <datalist id="tbl-suppliers">{data.suppliers.map((x) => <option key={x.id} value={x.name} />)}</datalist></label>
            <label><span>{tr('Amount')}</span><input className="input" type="number" min="0.01" step="0.01" inputMode="decimal" required value={adding.amount} onChange={(e) => setAdding({ ...adding, amount: e.target.value })} /></label>
          </div>
          <div className="cof-cats" role="radiogroup" aria-label={tr('What for')}>
            {data.categories.map((c) => <button key={c} type="button" role="radio" aria-checked={adding.category === c} className={adding.category === c ? 'is-on' : ''} onClick={() => setAdding({ ...adding, category: c })}><span aria-hidden="true">{BILL_CAT[c][0]}</span>{tr(BILL_CAT[c][1])}</button>)}
          </div>
          <div className="tbl-two">
            <label><span>{tr('Their invoice number')}</span><input className="input" maxLength={60} value={adding.reference} onChange={(e) => setAdding({ ...adding, reference: e.target.value })} /></label>
            <label><span>{tr('Due')}</span><input className="input" type="date" required min={adding.billDate} value={adding.dueDate} onChange={(e) => setAdding({ ...adding, dueDate: e.target.value })} /></label>
          </div>
          <PhotoPick value={adding.photo} onChange={(p) => setAdding({ ...adding, photo: p })} label={tr('A photo of the bill')} hint={tr('So the office can check it before paying.')} />
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setAdding(null)}>{tr('Cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Send to the office')}</button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn btn-primary tbl-add" onClick={() => { setFlash(null); setAdding({ supplierName: '', amount: '', category: 'stock', reference: '', billDate: data.today, dueDate: addDays(data.today, data.dueDays), photo: null }); }}>＋ {tr('A bill came in')}</button>
      )}
      <h3 className="tbl-h">{tr('To pay')} <small>{open.length}</small></h3>
      {open.length ? <div className="tbl-list">{open.map(row)}</div> : <p className="dk-muted">🌴 {tr('Nothing to pay.')}</p>}
      {done.length > 0 && (<><h3 className="tbl-h">{tr('Lately')}</h3><div className="tbl-list is-done">{done.slice(0, 20).map(row)}</div></>)}
    </section>
  );
}

const BLANK_EQ = { name: '', category: 'Fridge and freezer', location: '', serialNo: '', purchaseDate: '', purchasePrice: '', warrantyUntil: '', serviceIntervalDays: '90', nextServiceDate: '', notes: '', status: 'in_use' };

// Back office → Setup → Equipment.
export function EquipmentTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [fixing, setFixing] = useState(null);
  const [planning, setPlanning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const call = useCallback((body) => posFetch('POST', '/pos/settings/equipment', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'list' }).then(setData).catch(onFail); }, [call, onFail]);
  async function run(body, text) {
    setBusy(true); setFlash(null);
    try { setData(await call(body)); setFlash(text); setEditing(null); setFixing(null); setPlanning(null); } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const sm = data.summary;
  const live = data.equipment.filter((e) => e.status !== 'retired');
  const problems = [];
  live.forEach((e) => e.open.forEach((m) => problems.push({ ...m, eq: e })));
  problems.sort((a, b) => (a.status === 'reported' ? 0 : 1) - (b.status === 'reported' ? 0 : 1) || ['stopped', 'unsafe', 'working', ''].indexOf(a.urgency) - ['stopped', 'unsafe', 'working', ''].indexOf(b.urgency));
  return (
    <section className="ts-sec eqt">
      {flash && <div className="ts-flash" role="status">{flash}</div>}
      <div className="tbl-cards">
        <div className={'tbl-card ' + (sm.problems ? 'is-bad' : 'is-good')}><small>🚨 {tr('Problems reported')}</small><b>{sm.problems}</b><span>{sm.stopped ? tr('{n} out of use', { n: sm.stopped }) : tr('Everything working')}</span></div>
        <div className="tbl-card is-calm"><small>🗓️ {tr('Visits planned')}</small><b>{sm.planned}</b><span>{tr('repairs and services')}</span></div>
        <div className={'tbl-card ' + (sm.serviceLate ? 'is-bad' : sm.serviceDue ? 'is-warn' : 'is-good')}><small>🛠️ {tr('Services due')}</small><b>{sm.serviceDue + sm.serviceLate}</b><span>{sm.serviceLate ? tr('{n} late', { n: sm.serviceLate }) : tr('in the next 7 days')}</span></div>
        <div className="tbl-card is-violet"><small>💸 {tr('Spent on repairs')}</small><b>{money(sm.spent90)}</b><span>{tr('the last 90 days')}</span></div>
      </div>

      {problems.length > 0 && (
        <div className="eqt-problems">
          <h3 className="tbl-h">{tr('To look at')} <small>{problems.length}</small></h3>
          {problems.map((m) => {
            const u = URGENCY[m.urgency];
            return (
              <article key={m.id} className={'eqt-problem is-' + (m.urgency || 'plan')}>
                <div className="eqt-p-top">
                  <span className="eqt-p-icon" aria-hidden="true">{u ? u[0] : '🗓️'}</span>
                  <div>
                    <b>{m.eq.name}</b>
                    <p>{m.what}</p>
                    <small>{m.reportedAt ? (m.reportedBy ? tr('{name}, {when}', { name: m.reportedBy, when: ago(m.reportedAt) }) : ago(m.reportedAt)) : tr('Service')}{m.status === 'scheduled' ? ' · 🗓️ ' + dayText(m.date) + (m.technician ? ' · ' + m.technician : '') : ''}</small>
                  </div>
                  {m.photos > 0 && <TillPhoto path={'/pos/equipment/photo/' + m.id + '/0'} token={token} label={m.eq.name} />}
                </div>
                {fixing && fixing.id === m.id ? (
                  <form className="eqt-fix" onSubmit={(e) => { e.preventDefault(); run({ action: 'fix', id: m.id, done: { ...fixing, cost: Number(fixing.cost) || 0 } }, '✅ ' + tr('{name}: done.', { name: m.eq.name })); }}>
                    <div className="tbl-two">
                      <label><span>{tr('Who did it')}</span><input className="input" required maxLength={60} value={fixing.technician} onChange={(e) => setFixing({ ...fixing, technician: e.target.value })} /></label>
                      <label><span>{tr('What it cost')}</span><input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={fixing.cost} onChange={(e) => setFixing({ ...fixing, cost: e.target.value })} /></label>
                    </div>
                    <input className="input" maxLength={300} value={fixing.partsReplaced} onChange={(e) => setFixing({ ...fixing, partsReplaced: e.target.value })} placeholder={tr('Parts replaced (optional)')} aria-label={tr('Parts replaced')} />
                    <input className="input" maxLength={500} value={fixing.notes} onChange={(e) => setFixing({ ...fixing, notes: e.target.value })} placeholder={tr('What was done (optional)')} aria-label={tr('What was done')} />
                    <PhotoPick value={fixing.photo} onChange={(p) => setFixing({ ...fixing, photo: p })} label={tr('A photo of the job or the invoice')} hint={tr('Optional')} />
                    <div className="dialog-actions">
                      <button type="button" className="btn btn-secondary" onClick={() => setFixing(null)}>{tr('Back')}</button>
                      <button type="submit" className="btn btn-primary" disabled={busy}>✅ {m.reportedAt ? tr('Fixed') : tr('Serviced')}</button>
                    </div>
                  </form>
                ) : planning && planning.id === m.id ? (
                  <form className="eqt-fix" onSubmit={(e) => { e.preventDefault(); run({ action: 'plan', id: m.id, date: planning.date, technician: planning.technician }, '🗓️ ' + tr('Visit planned for {date}.', { date: dayText(planning.date) })); }}>
                    <div className="tbl-two">
                      <label><span>{tr('Day')}</span><input className="input" type="date" required min={data.today} value={planning.date} onChange={(e) => setPlanning({ ...planning, date: e.target.value })} /></label>
                      <label><span>{tr('Technician')}</span><input className="input" maxLength={60} value={planning.technician} onChange={(e) => setPlanning({ ...planning, technician: e.target.value })} /></label>
                    </div>
                    <div className="dialog-actions">
                      <button type="button" className="btn btn-secondary" onClick={() => setPlanning(null)}>{tr('Back')}</button>
                      <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Plan it')}</button>
                    </div>
                  </form>
                ) : (
                  <div className="eqt-p-actions">
                    <button type="button" className="btn btn-primary" onClick={() => setFixing({ id: m.id, technician: m.technician || '', cost: '', partsReplaced: '', notes: '', photo: null })}>✅ {m.reportedAt ? tr('Fixed') : tr('Serviced')}</button>
                    {m.status === 'reported' && <button type="button" className="btn btn-secondary" onClick={() => setPlanning({ id: m.id, date: data.today, technician: '' })}>🗓️ {tr('Plan a visit')}</button>}
                    <button type="button" className="pos-link" disabled={busy} onClick={() => run({ action: 'dismiss', id: m.id }, tr('Taken off the list.'))}>{m.reportedAt ? tr('Not a problem') : tr('Will not happen')}</button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <div className="eqt-head">
        <h3 className="tbl-h">{tr('Equipment')} <small>{live.length}</small></h3>
        <button type="button" className="btn btn-secondary" onClick={() => setEditing({ ...BLANK_EQ })}>＋ {tr('Add equipment')}</button>
      </div>
      {editing && (
        <form className="cof-form eqt-edit" onSubmit={(e) => { e.preventDefault(); run({ action: 'save', equipment: editing }, editing.id ? tr('{name} saved.', { name: editing.name }) : '✨ ' + tr('{name} added.', { name: editing.name })); }}>
          <h3>{editing.id ? tr('Change {name}', { name: editing.name }) : tr('New equipment')}</h3>
          <div className="cof-cats" role="radiogroup" aria-label={tr('Kind')}>
            {data.categories.map((c) => <button key={c} type="button" role="radio" aria-checked={editing.category === c} className={editing.category === c ? 'is-on' : ''} onClick={() => setEditing({ ...editing, category: c })}><span aria-hidden="true">{EQUIP_ICON[c] || '⚙️'}</span>{equipLabel(c)}</button>)}
          </div>
          <div className="tbl-two">
            <label><span>{tr('What it is')}</span><input className="input" required minLength={2} maxLength={120} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder={tr('e.g. Walk-in fridge')} /></label>
            <label><span>{tr('Where it is')}</span><input className="input" maxLength={120} value={editing.location} onChange={(e) => setEditing({ ...editing, location: e.target.value })} placeholder={tr('e.g. Kitchen, bar')} /></label>
            <label><span>{tr('Serviced every (days)')}</span><input className="input" type="number" min="1" max="3650" value={editing.serviceIntervalDays} onChange={(e) => setEditing({ ...editing, serviceIntervalDays: e.target.value })} /></label>
            <label><span>{tr('Next service')}</span><input className="input" type="date" value={editing.nextServiceDate} onChange={(e) => setEditing({ ...editing, nextServiceDate: e.target.value })} /></label>
            <label><span>{tr('Warranty until')}</span><input className="input" type="date" value={editing.warrantyUntil} onChange={(e) => setEditing({ ...editing, warrantyUntil: e.target.value })} /></label>
            <label><span>{tr('Serial number')}</span><input className="input" maxLength={80} value={editing.serialNo} onChange={(e) => setEditing({ ...editing, serialNo: e.target.value })} /></label>
          </div>
          <div className="dialog-actions">
            {editing.id && editing.status !== 'retired' && <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => run({ action: 'save', equipment: { ...editing, status: 'retired' } }, tr('{name} retired.', { name: editing.name }))}>{tr('Retire it')}</button>}
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button>
          </div>
        </form>
      )}
      {!live.length && !editing && <p className="dk-muted">{tr('Nothing yet. Add the fridges, cookers, the generator: the team can then report a problem from the till.')}</p>}
      <div className="eqt-grid">
        {live.map((e) => {
          const late = e.serviceIn !== null && e.serviceIn < 0, soon = e.serviceIn !== null && e.serviceIn >= 0 && e.serviceIn <= 7;
          return (
            <article key={e.id} className={'eqt-card' + (e.status === 'in_repair' ? ' is-repair' : '')}>
              <span className="eqt-icon" aria-hidden="true">{EQUIP_ICON[e.category] || '⚙️'}</span>
              <div className="eqt-body">
                <b>{e.name}</b>
                <small>{e.assetNo}{e.location ? ' · ' + e.location : ''}</small>
                <div className="eqt-tags">
                  {e.status === 'in_repair' ? <i className="is-bad">🛑 {tr('Out of use')}</i> : e.open.some((m) => m.status === 'reported') ? <i className="is-warn">🔧 {tr('Problem reported')}</i> : <i className="is-good">✓ {tr('Working')}</i>}
                  {e.nextServiceDate && <i className={late ? 'is-bad' : soon ? 'is-warn' : ''}>🛠️ {late ? tr('Service {n} days late', { n: -e.serviceIn }) : e.serviceIn === 0 ? tr('Service today') : tr('Service {date}', { date: dayText(e.nextServiceDate) })}</i>}
                  {e.underWarranty && <i>🛡️ {tr('Under warranty')}</i>}
                </div>
                {e.last && <small className="eqt-last">{tr('Last: {what}, {date}', { what: e.last.what, date: dayText(e.last.date) })}{e.last.cost ? ' · ' + money(e.last.cost) : ''}</small>}
              </div>
              <div className="eqt-acts">
                <button type="button" className="pos-link" onClick={() => setEditing({ ...BLANK_EQ, ...e, serviceIntervalDays: e.serviceIntervalDays ? String(e.serviceIntervalDays) : '', nextServiceDate: e.nextServiceDate || '', warrantyUntil: e.warrantyUntil || '', purchaseDate: e.purchaseDate || '' })}>{tr('Edit')}</button>
                {!e.open.length && <button type="button" className="pos-link" disabled={busy} onClick={() => run({ action: 'plan', assetId: e.id, date: e.nextServiceDate && e.nextServiceDate >= data.today ? e.nextServiceDate : data.today, what: tr('Routine service') }, '🗓️ ' + tr('Service planned for {name}.', { name: e.name }))}>{tr('Plan a service')}</button>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
