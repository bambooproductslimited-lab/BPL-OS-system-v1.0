import { useEffect, useMemo, useState } from 'react';
import { posFetch } from '../lib/posApi';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { Icon } from '../components/DashKit';
import './TillSettings.css';

// The till's settings, opened by a manager (backend:
// restaurantTillAccess.service.js): each person's role, what each role may
// do, the ways of paying the till offers, the receipt's own lines, signing
// out after a while unused, a waiter for every table, and the kitchen
// screen's amber and red. The server checks every rule; this only sets them.

const ROLE_LABEL = {
  manager: () => tr('Manager'), cashier: () => tr('Cashier'), waiter: () => tr('Waiter'), kitchen: () => tr('Kitchen'), none: () => tr('No access')
};
const ROLE_HINT = {
  manager: () => tr('Everything, and these settings.'),
  cashier: () => tr('Sells and runs a cash drawer.'),
  waiter: () => tr('Keeps tables open for the cashier to charge.'),
  kitchen: () => tr('The kitchen screen only.'),
  none: () => tr('Cannot sign in to the till or the kitchen screen.')
};
const PERMISSION = {
  till: [() => tr('Use the till'), () => tr('Sign in to the till at all.')],
  charge: [() => tr('Take payments'), () => tr('Charge sales and open tables, with their own cash drawer.')],
  keepOpen: [() => tr('Keep tables open'), () => tr('Start and add to open tables for the cashier to charge.')],
  removeTable: [() => tr('Remove open tables'), () => tr('Delete an open table nobody has paid for.')],
  refund: [() => tr('Refund sales'), () => tr('Start a refund; a manager still approves it.')],
  approveRefunds: [() => tr('Approve refunds'), () => tr('Type their PIN to approve a refund.')],
  vipTopUp: [() => tr('Take VIP money'), () => tr('Put money down on a VIP guest\'s balance.')],
  iou: [() => tr('Sell on IOU'), () => tr('Let a named guest owe a sale.')],
  iouPaid: [() => tr('Take IOU payments'), () => tr('Mark what a guest owed as paid.')],
  favorites: [() => tr('Change favourites'), () => tr('Star and unstar dishes for everyone.')],
  kds: [() => tr('Use the kitchen screen'), () => tr('Sign in to the kitchen screen.')]
};
const TILL_PERMS = ['charge', 'keepOpen', 'removeTable', 'refund', 'approveRefunds', 'vipTopUp', 'iou', 'iouPaid', 'favorites'];
const METHOD = {
  cash: ['cash', () => tr('Cash'), () => tr('Into the cashier\'s drawer.')],
  mobile_money: ['phone', () => tr('Mobile Money'), () => tr('Sent to the restaurant\'s number.')],
  vip: ['spark', () => tr('VIP'), () => tr('From money a VIP guest put down.')],
  iou: ['owed', () => tr('IOU'), () => tr('A named guest pays later.')],
  other: ['info', () => tr('Other'), () => tr('Paid some other way, outside the drawer.')]
};
const TABS = [['people', () => tr('People'), 'people'], ['roles', () => tr('What each role can do'), 'key'], ['payments', () => tr('Payments'), 'cash'], ['receipts', () => tr('Receipts'), 'receipt'], ['till', () => tr('Till and kitchen'), 'clock']];

function clone(o) { return JSON.parse(JSON.stringify(o)); }

export default function TillSettings({ token, companyName, logoUrl, onClose, onSaved, onAuth }) {
  const [step, setStep] = useState('opening'); // opening | pin | edit
  const [pin, setPin] = useState('');
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [roles, setRoles] = useState({}); // employee id -> role or null, changed here
  const [tab, setTab] = useState('people');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);

  function fail(err) { if (err.status === 401) onAuth(); else setError(err.message); }
  function take(d) { setData(d); setDraft(clone(d.settings)); setRoles({}); setStep('edit'); }
  async function open(managerPin) {
    setBusy(true); setError(null);
    try { take(await posFetch('POST', '/pos/settings/open', token, managerPin ? { managerPin } : {})); }
    catch (err) {
      if (err.status === 403 && !managerPin) setStep('pin');
      else { setPin(''); fail(err); if (step === 'opening') setStep('pin'); }
    } finally { setBusy(false); }
  }
  useEffect(() => { open(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => !!data && (Object.keys(roles).length > 0 || JSON.stringify(draft) !== JSON.stringify(data.settings)), [data, draft, roles]);
  function set(path, value) {
    const next = clone(draft);
    let o = next;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = value;
    setDraft(next); setFlash(null);
  }
  function setPerm(role, perm, on) {
    const next = clone(draft);
    const r = next.roles[role];
    r[perm] = on;
    if (perm === 'till' && !on) TILL_PERMS.forEach((k) => { r[k] = false; });
    if (perm !== 'till' && perm !== 'kds' && on) r.till = true;
    if (perm === 'iou' && on) r.charge = true;
    if (perm === 'charge' && !on) r.iou = false;
    setDraft(next); setFlash(null);
  }
  function roleOf(p) { return Object.prototype.hasOwnProperty.call(roles, p.id) ? roles[p.id] : p.role; }
  function setRole(p, role) {
    const next = { ...roles };
    if (role === p.role) delete next[p.id]; else next[p.id] = role;
    setRoles(next); setFlash(null);
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      const d = await posFetch('PUT', '/pos/settings', token, {
        managerPin: pin || undefined, settings: draft,
        staff: Object.keys(roles).map((id) => ({ employeeId: id, role: roles[id] }))
      });
      take(d); setFlash(tr('Saved. The till follows the new settings straight away.')); onSaved();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }
  function close() {
    if (dirty && !window.confirm(tr('Close without saving your changes?'))) return;
    onClose();
  }

  const staff = data ? data.staff.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.position.toLowerCase().includes(q.trim().toLowerCase())) : [];
  const counts = useMemo(() => {
    const c = { manager: 0, cashier: 0, waiter: 0, kitchen: 0, none: 0 };
    if (data && draft) data.staff.forEach((p) => { const r = roleOf(p) || draft.defaultRole; c[r] = (c[r] || 0) + 1; });
    return c;
  }, [data, draft, roles]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="dialog-backdrop" onClick={() => !busy && close()}>
      <div className="dialog pos-panel ts" onClick={(e) => e.stopPropagation()}>
        {step !== 'edit' ? (
          <form className="ts-lock" onSubmit={(e) => { e.preventDefault(); if (pin.length === 4) open(pin); }}>
            <span className="ts-lock-ico" aria-hidden="true"><Icon name="key" /></span>
            <h2>{tr('Till settings')}</h2>
            <p className="dk-muted">{step === 'opening' ? tr('Opening…') : tr('A manager opens the settings: who can do what on the till, payments, receipts and more. Type a manager\'s PIN.')}</p>
            {step === 'pin' && (
              <input className="input ts-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={4} autoFocus value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" aria-label={tr('Manager PIN')} />
            )}
            {error && <div className="error-banner">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
              {step === 'pin' && <button type="submit" className="btn btn-primary" disabled={busy || pin.length !== 4}>{busy ? tr('Checking…') : tr('Open settings')}</button>}
            </div>
          </form>
        ) : (
          <>
            <header className="ts-head">
              <span className="ts-head-ico" aria-hidden="true"><Icon name="key" /></span>
              <div>
                <h2>{tr('Till settings')}</h2>
                <p className="dk-muted">{tr('{place} · opened by {name}', { place: companyName, name: data.managerName })}</p>
              </div>
            </header>
            <nav className="ts-tabs" role="tablist" aria-label={tr('Till settings')}>
              {TABS.map(([k, label, icon]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}><Icon name={icon} />{label()}</button>
              ))}
            </nav>

            {tab === 'people' && (
              <section className="ts-sec">
                <div className="ts-roles-sum">
                  {data.choices.roles.map((r) => <span key={r} className={'ts-role-chip is-' + r}><b>{counts[r] || 0}</b>{ROLE_LABEL[r]()}</span>)}
                </div>
                <label className="ts-default">
                  <span><strong>{tr('Everyone not given a role')}</strong><small>{tr('Staff of this restaurant you have not set below have this role.')}</small></span>
                  <select className="input" value={draft.defaultRole} onChange={(e) => set(['defaultRole'], e.target.value)}>
                    {['cashier', 'waiter', 'kitchen', 'none'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]()}</option>)}
                  </select>
                </label>
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find someone…')} aria-label={tr('Find someone…')} />
                <ul className="ts-people">
                  {staff.map((p) => {
                    const r = roleOf(p);
                    const shown = r || draft.defaultRole;
                    return (
                      <li key={p.id} className={Object.prototype.hasOwnProperty.call(roles, p.id) ? 'is-changed' : ''}>
                        <span className={'ts-avatar is-' + shown} aria-hidden="true">{p.name.replace(/^zq\s+/i, '').slice(0, 1).toUpperCase()}</span>
                        <span className="ts-person">
                          <strong>{p.name}</strong>
                          <small>{[p.position, !p.hasPin ? tr('No PIN yet: cannot sign in') : null, !r ? tr('Default: {role}', { role: ROLE_LABEL[draft.defaultRole]() }) : null].filter(Boolean).join(' · ')}</small>
                        </span>
                        <select className={'input ts-role-select is-' + shown} value={r || ''} onChange={(e) => setRole(p, e.target.value || null)} aria-label={tr('Role for {name}', { name: p.name })}>
                          <option value="">{tr('Default ({role})', { role: ROLE_LABEL[draft.defaultRole]() })}</option>
                          {data.choices.roles.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]()}</option>)}
                        </select>
                      </li>
                    );
                  })}
                  {!staff.length && <li className="dk-empty"><Icon name="info" /><p>{tr('Nobody matches "{search}".', { search: q })}</p></li>}
                </ul>
                <p className="ts-note"><Icon name="info" />{tr('Anyone whose OS account can manage restaurants can always open these settings with their PIN.')}</p>
              </section>
            )}

            {tab === 'roles' && (
              <section className="ts-sec">
                <div className="ts-matrix-wrap">
                  <table className="ts-matrix">
                    <thead>
                      <tr>
                        <th scope="col"><span className="dk-muted">{tr('Can…')}</span></th>
                        {['manager', 'cashier', 'waiter', 'kitchen'].map((r) => <th key={r} scope="col"><span className={'ts-role-chip is-' + r}>{ROLE_LABEL[r]()}</span></th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {data.choices.permissions.map((perm) => (
                        <tr key={perm}>
                          <th scope="row"><strong>{PERMISSION[perm][0]()}</strong><small>{PERMISSION[perm][1]()}</small></th>
                          <td data-role={ROLE_LABEL.manager()} className="is-manager"><span className="ts-tick is-on is-locked" title={tr('Managers can do everything.')}>✓</span></td>
                          {['cashier', 'waiter', 'kitchen'].map((r) => (
                            <td key={r} data-role={ROLE_LABEL[r]()} className={'is-' + r}>
                              <button type="button" role="switch" aria-checked={!!draft.roles[r][perm]} aria-label={PERMISSION[perm][0]() + ' · ' + ROLE_LABEL[r]()}
                                className={'ts-tick' + (draft.roles[r][perm] ? ' is-on' : '')} onClick={() => setPerm(r, perm, !draft.roles[r][perm])}>{draft.roles[r][perm] ? '✓' : ''}</button>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="ts-role-hints">
                  {['manager', 'cashier', 'waiter', 'kitchen', 'none'].map((r) => <li key={r}><span className={'ts-role-chip is-' + r}>{ROLE_LABEL[r]()}</span>{ROLE_HINT[r]()}</li>)}
                </ul>
              </section>
            )}

            {tab === 'payments' && (
              <section className="ts-sec">
                <p className="dk-muted">{tr('The ways of paying the till offers. Past sales keep how they were paid.')}</p>
                <div className="ts-methods">
                  {data.choices.paymentMethods.map((m) => {
                    const on = draft.paymentMethods.includes(m);
                    const last = on && draft.paymentMethods.length === 1;
                    return (
                      <button key={m} type="button" role="switch" aria-checked={on} disabled={last} data-m={m} className={'ts-method' + (on ? ' is-on' : '')}
                        onClick={() => set(['paymentMethods'], on ? draft.paymentMethods.filter((x) => x !== m) : data.choices.paymentMethods.filter((x) => x === m || draft.paymentMethods.includes(x)))}>
                        <span className="ts-method-ico"><Icon name={METHOD[m][0]} /></span>
                        <span className="ts-method-text"><strong>{METHOD[m][1]()}</strong><small>{last ? tr('Keep at least one way of paying.') : METHOD[m][2]()}</small></span>
                        <span className={'ts-switch' + (on ? ' is-on' : '')} aria-hidden="true"><i /></span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {tab === 'receipts' && (
              <section className="ts-sec ts-receipt-sec">
                <div className="ts-receipt-form">
                  <div className="field">
                    <label htmlFor="ts-extra">{tr('Line under the restaurant\'s name')}</label>
                    <input id="ts-extra" className="input" maxLength={200} value={draft.receipt.extra} onChange={(e) => set(['receipt', 'extra'], e.target.value)} placeholder={tr('e.g. address, phone, Mobile Money number')} />
                  </div>
                  <div className="field">
                    <label htmlFor="ts-footer">{tr('Message at the bottom')}</label>
                    <input id="ts-footer" className="input" maxLength={120} value={draft.receipt.footer} onChange={(e) => set(['receipt', 'footer'], e.target.value)} placeholder={tr('e.g. Thank you!')} />
                  </div>
                  <button type="button" role="switch" aria-checked={draft.receipt.showLogo} className="ts-toggle-row" onClick={() => set(['receipt', 'showLogo'], !draft.receipt.showLogo)}>
                    <span><strong>{tr('Show the logo')}</strong><small>{tr('At the top of printed receipts.')}</small></span>
                    <span className={'ts-switch' + (draft.receipt.showLogo ? ' is-on' : '')} aria-hidden="true"><i /></span>
                  </button>
                </div>
                <div className="ts-receipt-preview" aria-label={tr('Preview')}>
                  {draft.receipt.showLogo && logoUrl && <img src={logoUrl} alt="" />}
                  <strong>{companyName}</strong>
                  {draft.receipt.extra && <small>{draft.receipt.extra}</small>}
                  <span className="ts-rule" />
                  <span className="ts-line"><span>2 × {tr('Dish')}</span><span>{money(90)}</span></span>
                  <span className="ts-line"><span>1 × {tr('Drink')}</span><span>{money(15)}</span></span>
                  <span className="ts-rule" />
                  <span className="ts-line is-total"><span>{tr('Total')}</span><span>{money(105)}</span></span>
                  {draft.receipt.footer && <em>{draft.receipt.footer}</em>}
                </div>
              </section>
            )}

            {tab === 'till' && (
              <section className="ts-sec">
                <div className="field">
                  <label htmlFor="ts-idle">{tr('Sign out when the till is not used for')}</label>
                  <div className="ts-chips" id="ts-idle" role="radiogroup">
                    {data.choices.idleMinutes.map((m) => (
                      <button key={m} type="button" role="radio" aria-checked={draft.idleMinutes === m} className={draft.idleMinutes === m ? 'is-on' : ''} onClick={() => set(['idleMinutes'], m)}>
                        {m === 0 ? tr('Never') : tr('{n} min', { n: m })}
                      </button>
                    ))}
                  </div>
                  <small className="dk-muted">{tr('So nobody sells under someone else\'s name on a till left signed in.')}</small>
                </div>
                <button type="button" role="switch" aria-checked={draft.requireWaiter} className="ts-toggle-row" onClick={() => set(['requireWaiter'], !draft.requireWaiter)}>
                  <span><strong>{tr('Every table needs its waiter')}</strong><small>{tr('An order at a table cannot be kept open or charged without picking the waiter.')}</small></span>
                  <span className={'ts-switch' + (draft.requireWaiter ? ' is-on' : '')} aria-hidden="true"><i /></span>
                </button>
                <div className="ts-kitchen">
                  <strong>{tr('Kitchen screen')}</strong>
                  <small className="dk-muted">{tr('How long a ticket cooks before it turns amber, then red.')}</small>
                  <div className="ts-kitchen-row">
                    <label className="ts-time is-warn">
                      <span>{tr('Amber after')}</span>
                      <input className="input" type="number" min="1" max="120" value={draft.kitchen.warnAfter} onChange={(e) => set(['kitchen', 'warnAfter'], Number(e.target.value))} />
                      <small>{tr('min')}</small>
                    </label>
                    <label className="ts-time is-late">
                      <span>{tr('Red after')}</span>
                      <input className="input" type="number" min="2" max="240" value={draft.kitchen.lateAfter} onChange={(e) => set(['kitchen', 'lateAfter'], Number(e.target.value))} />
                      <small>{tr('min')}</small>
                    </label>
                  </div>
                </div>
              </section>
            )}

            {flash && <div className="ts-flash" role="status"><Icon name="check" />{flash}</div>}
            {error && <div className="error-banner">{error}</div>}
            <div className="dialog-actions ts-actions">
              {dirty && <span className="ts-dirty">{tr('Unsaved changes')}</span>}
              <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>{tr('Close')}</button>
              <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? tr('Saving…') : tr('Save changes')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
