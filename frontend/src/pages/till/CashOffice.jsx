import { useCallback, useEffect, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { shrinkPhoto, tillPhotoUrl } from './photoShrink';
import { PETTY, pettyOf } from './cashShared';
import './fourteenth.css';

// The cash office (backend restaurantCashOffice, migration 0195). On the
// till's More menu: cash put in the safe from one's own drawer (a manager
// watching: signed in, or their PIN), and petty cash spent from it — what
// for, who to, a photo of the receipt. In the back office: the safe (what
// it should hold, taken to the bank with the slip, counted) and the petty
// cash by what it was for.

function when(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

// A photo taken with the camera (or picked), shown small.
export function PhotoPick({ value, onChange, label, hint }) {
  const input = useRef(null);
  const [error, setError] = useState(null);
  async function pick(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setError(null);
    try { onChange(await shrinkPhoto(f)); } catch { setError(tr('That file is not a photo.')); }
  }
  return (
    <div className={'cof-photo' + (value ? ' is-on' : '')}>
      <input ref={input} type="file" accept="image/*" capture="environment" onChange={pick} hidden />
      {value ? <img src={value} alt="" /> : <span className="cof-photo-art" aria-hidden="true">📷</span>}
      <span className="cof-photo-text"><strong>{value ? tr('Photo taken') : label}</strong><small>{error || hint}</small></span>
      <button type="button" className="pos-link" onClick={() => input.current && input.current.click()}>{value ? tr('Take again') : tr('Take a photo')}</button>
      {value && <button type="button" className="pos-link is-bad" onClick={() => onChange(null)} aria-label={tr('Take it off')}>✕</button>}
    </div>
  );
}

// A photo the till's API keeps (a receipt, a slip), opened big on a tap.
export function TillPhoto({ path, token, label }) {
  const [url, setUrl] = useState(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let live = true, made = null;
    tillPhotoUrl(path, token).then((u) => { made = u; if (live) setUrl(u); else if (u) URL.revokeObjectURL(u); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path, token]);
  if (!url) return <span className="cof-thumb is-empty" aria-hidden="true">📄</span>;
  return (
    <>
      <button type="button" className="cof-thumb" onClick={() => setBig(true)} aria-label={label}><img src={url} alt="" /></button>
      {big && <div className="cof-zoom" role="dialog" aria-label={label} onClick={() => setBig(false)}><img src={url} alt="" /></div>}
    </>
  );
}

function Head({ art, title, sub, tone }) {
  return (
    <div className="cof-head">
      <span className={'cof-head-art is-' + tone} aria-hidden="true">{art}</span>
      <div><h2 id="cof-title">{title}</h2><p>{sub}</p></div>
    </div>
  );
}

// What the drawer holds after: its bar, what stays and what goes.
function DrawerSplit({ expected, out }) {
  const left = round2(expected - out);
  const share = expected > 0 ? Math.max(0, Math.min(1, out / expected)) : 0;
  return (
    <div className={'cof-split' + (left < 0 ? ' is-over' : '')} style={{ '--share': share }}>
      <i aria-hidden="true" />
      <span><small>{tr('Left in the drawer')}</small><b>{money(Math.max(0, left))}</b></span>
      <span><small>{tr('Taken out')}</small><b>{money(out)}</b></span>
    </div>
  );
}

// More → Cash into the safe.
export function SafeDropDialog({ token, drawer, isManager, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const n = round2(Number(amount) || 0);
  const keep = [200, 300, 500].filter((k) => drawer.expected > k + 50);
  async function go(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/cash-office/drop', token, { amount: n, note, managerPin: pin || undefined });
      onDone(r.drawer, tr('{amount} in the safe. It should hold {safe} now.', { amount: money(n), safe: money(r.safe.balance) }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog cof" role="dialog" aria-modal="true" aria-labelledby="cof-title" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <Head art="🔐" tone="safe" title={tr('Cash into the safe')} sub={tr('Your drawer should hold {amount}. Count what goes in, with a manager watching.', { amount: money(drawer.expected) })} />
        <label className="cof-amount"><span>{tr('How much goes in the safe')}</span>
          <input className="input" type="number" min="0" step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus /></label>
        {keep.length > 0 && (
          <div className="cof-chips">{keep.map((k) => <button key={k} type="button" onClick={() => setAmount(String(round2(drawer.expected - k)))}>{tr('All but {amount}', { amount: money(k) })}</button>)}</div>
        )}
        <DrawerSplit expected={drawer.expected} out={n} />
        <input className="input" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('A note (optional), e.g. the evening drop')} aria-label={tr('Note')} />
        {!isManager && (
          <label className="cof-pin"><span>🔑 {tr('Manager\'s PIN')}</span>
            <input className="input" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary cof-go" disabled={busy || !(n > 0) || n > drawer.expected || (!isManager && pin.length < 4)}>🔐 {tr('Put {amount} in the safe', { amount: money(n) })}</button>
        </div>
      </form>
    </div>
  );
}

// More → Petty cash.
export function PettyCashDialog({ token, drawer, isManager, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [paidTo, setPaidTo] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(null);
  const [pin, setPin] = useState('');
  const [needPin, setNeedPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const n = round2(Number(amount) || 0);
  async function go(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/cash-office/petty', token, { amount: n, category, paidTo, note, photo: photo || undefined, managerPin: pin || undefined });
      onDone(r.drawer, tr('Petty cash: {amount} to {who}.', { amount: money(n), who: paidTo }));
    } catch (err) {
      if (err.code === 'forbidden' && !isManager) setNeedPin(true);
      setError(err.message);
    } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog cof" role="dialog" aria-modal="true" aria-labelledby="cof-title" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <Head art="🧾" tone="petty" title={tr('Petty cash')} sub={tr('Money spent from your drawer: what for, who to, and a photo of the receipt.')} />
        <label className="cof-amount"><span>{tr('How much')}</span>
          <input className="input" type="number" min="0" step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus /></label>
        <div className="cof-cats" role="radiogroup" aria-label={tr('What for')}>
          {PETTY.map(([k, icon]) => (
            <button key={k} type="button" role="radio" aria-checked={category === k} className={category === k ? 'is-on' : ''} onClick={() => setCategory(k)}>
              <span aria-hidden="true">{icon}</span>{pettyOf(k).label}
            </button>
          ))}
        </div>
        <input className="input" maxLength={80} value={paidTo} onChange={(e) => setPaidTo(e.target.value)} placeholder={tr('Paid to, e.g. the gas man, Makola market')} aria-label={tr('Paid to')} />
        <input className="input" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('What it bought (optional), e.g. 2 crates of tomatoes')} aria-label={tr('Note')} />
        <PhotoPick value={photo} onChange={setPhoto} label={tr('A photo of the receipt')} hint={tr('So the office can match it: the receipt, or what was bought.')} />
        <DrawerSplit expected={drawer.expected} out={n} />
        {!isManager && (
          <label className={'cof-pin' + (needPin ? ' is-needed' : '')}><span>🔑 {tr('Manager\'s PIN')}<small>{tr('Needed over the petty cash limit')}</small></span>
            <input className="input" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary cof-go is-petty" disabled={busy || !(n > 0) || n > drawer.expected || !category || paidTo.trim().length < 2}>🧾 {tr('Pay out {amount}', { amount: money(n) })}</button>
        </div>
      </form>
    </div>
  );
}

const MOVE = { drop: ['🔐', 'is-drop'], deposit: ['🏦', 'is-deposit'], count: ['🧮', 'is-count'] };

// The back office: the safe and the petty cash.
export function CashOfficeTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [flash, setFlash] = useState(null);
  const [bank, setBank] = useState({ amount: '', bank: '', reference: '', photo: null, note: '' });
  const [count, setCount] = useState('');
  const [limits, setLimits] = useState(null);
  const call = useCallback((body) => posFetch('POST', '/pos/settings/cash-office', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'view' }).then((d) => { setData(d); setLimits({ pettyLimit: d.settings.pettyLimit, safeLimit: d.settings.safeLimit, banks: d.settings.banks.join(', ') }); }).catch(onFail); }, [call, onFail]);
  async function run(body, done, key) {
    setBusy(key || body.action); setFlash(null);
    try { const d = await call(body); setData(d); if (done) done(d); } catch (e) { onFail(e); } finally { setBusy(null); }
  }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const s = data.safe;
  const counted = count === '' ? null : round2(Number(count));
  const max = Math.max(1, ...data.petty.byCategory.map((c) => c.amount));
  return (
    <section className="ts-sec cof-tab">
      {flash && <div className="ts-flash" role="status">{flash}</div>}
      <div className="cof-hero">
        <div className={'cof-safe' + (s.over ? ' is-over' : '')}>
          <span className="cof-safe-art" aria-hidden="true">🔐</span>
          <div>
            <small>{tr('The safe should hold')}</small>
            <strong>{money(s.balance)}</strong>
            <span>{s.lastCount ? tr('Counted by {name}, {when}', { name: s.lastCount.by, when: when(s.lastCount.at) }) : tr('Not counted yet: count it to start.')}</span>
            {s.over && <em>⚠️ {tr('Over {amount}: take some to the bank.', { amount: money(data.settings.safeLimit) })}</em>}
          </div>
        </div>
        <div className="cof-petty-card">
          <small>{tr('Petty cash, the last 30 days')}</small>
          <strong>{money(data.petty.total)}</strong>
          <span>{data.petty.noReceipt ? '📄 ' + (data.petty.noReceipt === 1 ? tr('1 without a receipt') : tr('{n} without a receipt', { n: data.petty.noReceipt })) : tr('Every one with a receipt')}</span>
        </div>
      </div>

      <div className="cof-forms">
        <form className="cof-form" onSubmit={(e) => { e.preventDefault(); run({ action: 'deposit', amount: Number(bank.amount), bank: bank.bank, reference: bank.reference, photo: bank.photo || undefined, note: bank.note }, () => { setFlash('🏦 ' + tr('{amount} taken to {bank}.', { amount: money(Number(bank.amount)), bank: bank.bank })); setBank({ amount: '', bank: bank.bank, reference: '', photo: null, note: '' }); }); }}>
          <h3>🏦 {tr('Take to the bank')}</h3>
          <div className="cof-two">
            <label><span>{tr('Amount')}</span><input className="input" type="number" min="0" step="any" inputMode="decimal" value={bank.amount} onChange={(e) => setBank({ ...bank, amount: e.target.value })} placeholder={String(s.balance)} /></label>
            <label><span>{tr('Bank')}</span><input className="input" list="cof-banks" maxLength={60} value={bank.bank} onChange={(e) => setBank({ ...bank, bank: e.target.value })} placeholder={tr('e.g. GCB, Ecobank')} />
              <datalist id="cof-banks">{data.settings.banks.map((b) => <option key={b} value={b} />)}</datalist></label>
          </div>
          <input className="input" maxLength={60} value={bank.reference} onChange={(e) => setBank({ ...bank, reference: e.target.value })} placeholder={tr('The slip\'s number')} aria-label={tr('The slip\'s number')} />
          <PhotoPick value={bank.photo} onChange={(p) => setBank({ ...bank, photo: p })} label={tr('A photo of the bank slip')} hint={tr('Stamped by the bank, if it is.')} />
          <button type="submit" className="btn btn-primary" disabled={busy === 'deposit' || !(Number(bank.amount) > 0) || bank.bank.trim().length < 2}>{tr('Taken to the bank')}</button>
        </form>
        <form className="cof-form" onSubmit={(e) => { e.preventDefault(); run({ action: 'count', amount: counted }, () => { setFlash('🧮 ' + tr('The safe counted: {amount}.', { amount: money(counted) })); setCount(''); }); }}>
          <h3>🧮 {tr('Count the safe')}</h3>
          <label><span>{tr('What it holds')}</span><input className="input cof-count-in" type="number" min="0" step="any" inputMode="decimal" value={count} onChange={(e) => setCount(e.target.value)} placeholder="0.00" /></label>
          {counted !== null && (
            <p className={'cof-diff' + (counted === s.balance ? ' is-right' : counted < s.balance ? ' is-short' : ' is-over')}>
              {counted === s.balance ? '✅ ' + tr('Right') : counted < s.balance ? '⚠️ ' + tr('{amount} short', { amount: money(round2(s.balance - counted)) }) : '➕ ' + tr('{amount} over', { amount: money(round2(counted - s.balance)) })}
            </p>
          )}
          <button type="submit" className="btn btn-secondary" disabled={busy === 'count' || counted === null}>{tr('Save the count')}</button>
        </form>
      </div>

      <h3 className="cof-h">{tr('The safe, the last 30 days')}</h3>
      {!data.moves.length ? <p className="dk-muted">{tr('Nothing yet: cash goes in from the till (More → Cash into the safe).')}</p> : (
        <ul className="cof-moves">
          {data.moves.map((m, i) => (
            <li key={m.id} className={MOVE[m.kind][1]} style={{ '--i': Math.min(i, 12) }}>
              <span className="cof-move-ico" aria-hidden="true">{MOVE[m.kind][0]}</span>
              <span className="cof-move-main">
                <strong>{m.kind === 'drop' ? tr('Into the safe') : m.kind === 'deposit' ? tr('To {bank}', { bank: m.bank }) + (m.reference ? ' · ' + m.reference : '') : tr('Counted')}</strong>
                <small>{when(m.at)} · {m.by}{m.witness && m.witness !== m.by ? ' · ' + tr('{name} watching', { name: m.witness }) : ''}{m.note ? ' · “' + m.note + '”' : ''}</small>
              </span>
              {m.hasPhoto && <TillPhoto path={'/pos/cash-office/photo/safe/' + m.id} token={token} label={tr('The bank slip')} />}
              <b>{m.kind === 'count' ? money(m.amount) : (m.kind === 'drop' ? '+' : '−') + money(m.amount)}
                {m.kind === 'count' && m.difference !== 0 && m.difference !== null && <em className={m.difference < 0 ? 'is-short' : 'is-over'}>{m.difference < 0 ? tr('{amount} short', { amount: money(-m.difference) }) : tr('{amount} over', { amount: money(m.difference) })}</em>}</b>
            </li>
          ))}
        </ul>
      )}

      <h3 className="cof-h">{tr('Petty cash, the last 30 days')}</h3>
      {data.petty.byCategory.length > 0 && (
        <div className="cof-bars">
          {data.petty.byCategory.map((c) => { const p = pettyOf(c.category); return (
            <div key={c.category} className="cof-bar" style={{ '--w': c.amount / max }}><span>{p.icon} {p.label}</span><i aria-hidden="true" /><b>{money(c.amount)}</b></div>
          ); })}
        </div>
      )}
      {!data.petty.list.length ? <p className="dk-muted">{tr('No petty cash spent yet.')}</p> : (
        <ul className="cof-petty">
          {data.petty.list.map((p) => { const c = pettyOf(p.category); return (
            <li key={p.id} className={p.hasPhoto ? '' : 'is-noreceipt'}>
              <span className="cof-move-ico" aria-hidden="true">{c.icon}</span>
              <span className="cof-move-main"><strong>{p.paidTo}{p.note ? ' · ' + p.note : ''}</strong><small>{c.label} · {when(p.at)} · {p.by}{p.approvedBy && p.approvedBy !== p.by ? ' · ' + tr('agreed by {name}', { name: p.approvedBy }) : ''}</small></span>
              {p.hasPhoto ? <TillPhoto path={'/pos/cash-office/photo/drawer/' + p.id} token={token} label={tr('The receipt')} /> : <em className="cof-noreceipt">{tr('No receipt')}</em>}
              <b>{money(p.amount)}</b>
            </li>
          ); })}
        </ul>
      )}

      {limits && (
        <form className="cof-form cof-limits" onSubmit={(e) => { e.preventDefault(); run({ action: 'settings', pettyLimit: Number(limits.pettyLimit), safeLimit: Number(limits.safeLimit), banks: limits.banks.split(',').map((b) => b.trim()).filter(Boolean) }, () => setFlash(tr('Saved.')), 'settings'); }}>
          <h3>⚙️ {tr('Limits')}</h3>
          <div className="cof-two">
            <label><span>{tr('Petty cash without a manager, up to')}</span><input className="input" type="number" min="0" step="any" value={limits.pettyLimit} onChange={(e) => setLimits({ ...limits, pettyLimit: e.target.value })} /></label>
            <label><span>{tr('Warn when the safe holds over')}</span><input className="input" type="number" min="0" step="any" value={limits.safeLimit} onChange={(e) => setLimits({ ...limits, safeLimit: e.target.value })} /></label>
          </div>
          <label><span>{tr('Banks you use (with commas)')}</span><input className="input" maxLength={300} value={limits.banks} onChange={(e) => setLimits({ ...limits, banks: e.target.value })} placeholder={tr('e.g. GCB, Ecobank')} /></label>
          <button type="submit" className="btn btn-secondary" disabled={busy === 'settings'}>{tr('Save')}</button>
        </form>
      )}
    </section>
  );
}
