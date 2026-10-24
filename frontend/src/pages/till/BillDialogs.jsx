import { useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { msg, tr } from '../../lib/i18n.jsx';
import { lineBody } from './tillShared';
import { modsPrice, modsWords, r2, serviceWords } from './tillBill';
import './sixth.css';

// The bill's dialogs on the till (RestaurantPosPage.jsx; backend
// restaurantTillCheck): a dish's add-ons, picked when it is added or
// changed later; a discount on a dish or the whole bill, a dish on the
// house, the service charge taken off — each allowed by the person's role,
// or a manager's PIN typed here (POST /pos/approve) for that one thing.

const HOWS = [
  ['add', msg('Add')], ['no', msg('No')], ['extra', msg('Extra')], ['side', msg('On the side')]
];

function ruleText(g) {
  if (g.minPick && g.maxPick && g.minPick === g.maxPick) return g.minPick === 1 ? tr('Pick 1') : tr('Pick {n}', { n: g.minPick });
  if (g.minPick && g.maxPick) return tr('Pick {a} to {b}', { a: g.minPick, b: g.maxPick });
  if (g.minPick) return tr('Pick at least {n}', { n: g.minPick });
  if (g.maxPick) return g.maxPick === 1 ? tr('Up to 1') : tr('Up to {n}', { n: g.maxPick });
  return tr('Optional');
}

// A dish's add-ons: its groups (item.addOns), each choice tapped to add it,
// or — after picking No, Extra or On the side above — to ask for it that
// way. base: the dish's price (or its size's); picked: what a line has
// already, when it is changed.
// A combo's parts (backend restaurantTillCheck comboGroups) are groups
// too, their choices other dishes: picked as they are (no No or Extra), one
// sold out greyed.
export function AddOnsDialog({ item, variation, base, picked, qty: qty0, editing, onSave, onClose }) {
  const groups = item.addOns || [];
  const comboOnly = groups.length > 0 && groups.every((g) => g.combo);
  const [mods, setMods] = useState(() => (picked || []).map((m) => ({ ...m })));
  const [how, setHow] = useState('add');
  const [qty, setQty] = useState(qty0 || 1);
  const [hint, setHint] = useState(null);
  const count = (g) => mods.filter((m) => m.groupId === g.id && (m.how || 'add') === 'add').length;
  function tap(g, o) {
    setHint(null);
    const way = g.combo ? 'add' : how;
    const key = (m) => m.id === o.id && (m.how || 'add') === way;
    if (mods.some(key)) { setMods(mods.filter((m) => !key(m))); return; }
    if (o.soldOut) { setHint(tr('{name} is sold out.', { name: o.name })); return; }
    const pick = { id: o.id, groupId: g.id, group: g.name, name: o.name, how: way, price: way === 'no' ? 0 : o.price, ...(g.combo ? { menuItemId: o.menuItemId, variationId: o.variationId || null, combo: true } : {}) };
    // One way at a time for a choice: "No rice" takes rice off, and so on.
    const rest = mods.filter((m) => m.id !== o.id);
    if (way === 'add') {
      if (g.maxPick === 1) { setMods(rest.filter((m) => !(m.groupId === g.id && (m.how || 'add') === 'add')).concat([pick])); return; }
      if (g.maxPick && rest.filter((m) => m.groupId === g.id && (m.how || 'add') === 'add').length >= g.maxPick) { setHint(tr('{group}: up to {n}. Take one off first.', { group: g.name, n: g.maxPick })); return; }
    }
    setMods(rest.concat([pick]));
  }
  const missing = groups.filter((g) => count(g) < (g.minPick || 0));
  const unit = r2(base + modsPrice(mods));
  // In the menu's order, the way the server keeps them.
  const ordered = useMemo(() => {
    const order = [];
    groups.forEach((g) => g.options.forEach((o) => order.push(o.id)));
    return mods.slice().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [mods, groups]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog tl-dialog tl-addons" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (!missing.length) onSave(ordered, qty); }}>
        <div className="tl-addons-head">
          <span className={'tl-dialog-ico ' + (item.combo ? 'is-combo' : 'is-addons')} aria-hidden="true">{item.combo ? '🍱' : '✚'}</span>
          <div>
            <h2>{item.name}{variation ? ' — ' + variation.name : ''}</h2>
            <p className="dk-muted">{comboOnly ? tr('Pick one of each part of the combo. Each dish picked goes to the kitchen with it.') : tr('Pick its add-ons. Tap No, Extra or On the side first to ask for one that way.')}</p>
          </div>
        </div>
        {!comboOnly && (
          <div className="tl-addons-how" role="radiogroup" aria-label={tr('How')}>
            {HOWS.map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={how === k} className={'is-' + k + (how === k ? ' is-on' : '')} onClick={() => setHow(k)}>{tr(label)}</button>
            ))}
          </div>
        )}
        <div className="tl-addons-groups">
          {groups.map((g, gi) => {
            const n = count(g);
            const short = n < (g.minPick || 0);
            return (
              <section key={g.id} className={'tl-addons-group' + (short ? ' is-short' : '') + (g.combo ? ' is-combo' : '')} style={{ '--gi': gi }}>
                <header><strong>{g.combo && <span className="tl-combo-n" aria-hidden="true">{gi + 1}</span>}{g.name}</strong><span className={'tl-addons-rule' + (short ? ' is-needed' : n ? ' is-done' : '')}>{short ? ruleText(g) : n ? '✓ ' + ruleText(g) : ruleText(g)}</span></header>
                <div className="tl-addons-opts">
                  {g.options.map((o) => {
                    const mine = mods.filter((m) => m.id === o.id);
                    const on = mine.some((m) => (m.how || 'add') === 'add');
                    return (
                      <button key={o.id} type="button" className={'tl-addon' + (on ? ' is-on' : '') + (o.soldOut && !on ? ' is-out' : '') + (mine.length ? ' has-' + mine.map((m) => m.how || 'add').join(' has-') : '')}
                        aria-pressed={mine.some((m) => (m.how || 'add') === (g.combo ? 'add' : how))} aria-disabled={o.soldOut && !on ? 'true' : undefined} onClick={() => tap(g, o)}>
                        <span className="tl-addon-name">{o.name}</span>
                        <span className="tl-addon-price">{o.soldOut && !on ? tr('Sold out') : o.price > 0 ? '+' + money(o.price) : g.combo ? tr('included') : tr('free')}</span>
                        {mine.filter((m) => m.how && m.how !== 'add').map((m) => <b key={m.how} className={'tl-addon-how is-' + m.how}>{m.how === 'no' ? tr('No') : m.how === 'extra' ? tr('Extra') : tr('Side')}</b>)}
                        {on && <i className="tl-addon-tick" aria-hidden="true">✓</i>}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        {ordered.length > 0 && <p className="tl-addons-said">{modsWords(ordered, tr)}</p>}
        {hint && <div className="error-banner">{hint}</div>}
        {missing.length > 0 && <p className="tl-addons-missing">{tr('Still to pick: {groups}', { groups: missing.map((g) => g.name).join(', ') })}</p>}
        <div className="tl-addons-foot">
          {!editing && (
            <div className="pos-stepper tl-addons-qty">
              <button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label={tr('Decrease')}>−</button>
              <span>{qty}</span>
              <button type="button" onClick={() => setQty(qty + 1)} aria-label={tr('Increase')}>+</button>
            </div>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary tl-addons-go" disabled={missing.length > 0}>
            {editing ? tr('Save · {amount} each', { amount: money(unit) }) : tr('Add · {amount}', { amount: money(r2(unit * qty)) })}
          </button>
        </div>
      </form>
    </div>
  );
}

// A manager's PIN, for one thing the person signed in may not do alone.
export function ManagerPin({ busy, error, onPin }) {
  const [pin, setPin] = useState('');
  return (
    <div className="tl-mgr">
      <span className="tl-mgr-ico" aria-hidden="true">🔑</span>
      <div className="tl-mgr-main">
        <strong>{tr('A manager approves it')}</strong>
        <small>{tr('Your role cannot do this alone: a manager types their PIN.')}</small>
      </div>
      <input className="input tl-mgr-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        placeholder="••••" aria-label={tr('Manager\'s PIN')} autoFocus />
      <button type="button" className="btn btn-primary" disabled={busy || pin.length < 4} onClick={() => onPin(pin)}>{busy ? tr('Checking…') : tr('Approve')}</button>
      {error && <div className="error-banner tl-mgr-error">{error}</div>}
    </div>
  );
}

const COMP_REASONS = [msg('A complaint'), msg('Took too long'), msg('Staff meal'), msg('The manager\'s guest'), msg('Birthday'), msg('Wrong dish made')];

// A discount on one dish (line) or the whole bill (no line), or the dish on
// the house; and, for the bill, the service charge on or off.
// current: { discountSpec, comp } of the line, or { discount, serviceOff }
// of the bill. can: the till role's (discount, comp). onApply(patch).
export function DiscountDialog({ token, line, current, settings, can, serviceOn, onApply, onClose }) {
  const bill = !line;
  const presets = (settings && settings.discounts) || [];
  const now = current || {};
  const nowDisc = bill ? now.discount : now.discountSpec;
  const [tab, setTab] = useState(!bill && now.comp ? 'comp' : 'discount');
  const [preset, setPreset] = useState(nowDisc && nowDisc.presetId ? nowDisc.presetId : null);
  const [kind, setKind] = useState(nowDisc && !nowDisc.presetId ? nowDisc.kind : 'percent');
  const [value, setValue] = useState(nowDisc && !nowDisc.presetId ? String(nowDisc.value) : '');
  const [name, setName] = useState(nowDisc && !nowDisc.presetId && nowDisc.name ? nowDisc.name : '');
  const [reason, setReason] = useState(now.comp ? now.comp.reason : '');
  const [ask, setAsk] = useState(null); // what waits for a manager's PIN
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const chosen = preset ? presets.find((p) => p.id === preset) : null;
  const custom = !preset && Number(value) > 0 ? { kind, value: r2(value), name: name.trim() || (kind === 'percent' ? tr('{n}% off', { n: r2(value) }) : tr('Discount')) } : null;
  const spec = chosen ? { presetId: chosen.id, kind: chosen.kind, value: chosen.value, name: chosen.name } : custom;
  const tooBig = spec && spec.kind === 'percent' && spec.value > 100;
  const gross = line ? r2(line.price * line.qty) : null;
  const off = spec && line ? Math.min(gross, spec.kind === 'percent' ? r2(gross * spec.value / 100) : spec.value) : null;

  async function approve(pin) {
    setBusy(true); setError(null);
    try {
      const body = { managerPin: pin, what: ask.what };
      if (ask.what === 'discount') body.discount = ask.spec;
      if (ask.what === 'comp') body.line = lineBody(line);
      const r = await posFetch('POST', '/pos/approve', token, body);
      const done = ask.done;
      setAsk(null);
      done(r.approval, r.by);
    } catch (e) { setError(e.message || tr('No answer from the server: approvals need the internet.')); } finally { setBusy(false); }
  }
  // Allowed by the role, ready-made for anyone, or after a manager's PIN.
  function withOk(what, specToAsk, open, done) {
    const mayAlone = open || (what === 'comp' ? can.comp : can.discount);
    if (mayAlone) { done(null, null); return; }
    setError(null);
    setAsk({ what, spec: specToAsk, done });
  }
  function applyDiscount() {
    if (!spec || tooBig) return;
    withOk('discount', spec, !!(chosen && chosen.open), (approval, by) => {
      const s = { ...spec, ...(approval ? { approval, by } : {}) };
      onApply(bill ? { discount: s } : { discountSpec: s, comp: null });
    });
  }
  function applyComp() {
    const why = reason.trim();
    if (why.length < 2) return;
    withOk('comp', null, false, (approval, by) => onApply({ comp: { reason: why, ...(approval ? { approval, by } : {}) }, discountSpec: null }));
  }
  function serviceOff() {
    withOk('service', null, false, (approval, by) => onApply({ serviceOff: approval ? { approval, by } : {} }));
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog tl-dialog tl-off" role="dialog" aria-modal="true" aria-labelledby="tl-off-title" onClick={(e) => e.stopPropagation()}>
        <span className="tl-dialog-ico is-off" aria-hidden="true">%</span>
        <h2 id="tl-off-title">{bill ? tr('Discount the bill') : tr('{dish}: a discount', { dish: line.name })}</h2>
        {!bill && <p className="dk-muted">{line.qty} × {money(line.price)} = {money(gross)}</p>}
        {!bill && (
          <div className="dk-segment tl-off-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'discount'} className={tab === 'discount' ? 'is-on' : ''} onClick={() => { setTab('discount'); setAsk(null); }}>{tr('Discount')}</button>
            <button type="button" role="tab" aria-selected={tab === 'comp'} className={tab === 'comp' ? 'is-on' : ''} onClick={() => { setTab('comp'); setAsk(null); }}>{tr('On the house')}</button>
          </div>
        )}
        {tab === 'discount' ? (
          <>
            {presets.length > 0 && (
              <div className="tl-off-presets">
                {presets.map((p) => (
                  <button key={p.id} type="button" className={'tl-off-preset' + (preset === p.id ? ' is-on' : '')} aria-pressed={preset === p.id} onClick={() => { setPreset(preset === p.id ? null : p.id); setAsk(null); }}>
                    <strong>{p.kind === 'percent' ? p.value + '%' : money(p.value)}</strong><span>{p.name}</span>
                    {p.open && <small>{tr('anyone')}</small>}
                  </button>
                ))}
              </div>
            )}
            <div className="tl-off-custom">
              <div className="dk-segment" role="radiogroup" aria-label={tr('Kind of discount')}>
                <button type="button" role="radio" aria-checked={kind === 'percent'} className={kind === 'percent' ? 'is-on' : ''} onClick={() => { setKind('percent'); setPreset(null); }}>%</button>
                <button type="button" role="radio" aria-checked={kind === 'amount'} className={kind === 'amount' ? 'is-on' : ''} onClick={() => { setKind('amount'); setPreset(null); }}>GHS</button>
              </div>
              <input className="input" type="number" min="0" step="0.01" value={value} onChange={(e) => { setValue(e.target.value); setPreset(null); setAsk(null); }}
                placeholder={kind === 'percent' ? tr('e.g. 10') : tr('e.g. 5.00')} aria-label={tr('How much off')} />
              <input className="input" maxLength={60} value={name} onChange={(e) => { setName(e.target.value); setPreset(null); }} placeholder={tr('Why (shows on the receipt)')} aria-label={tr('Name of the discount')} />
            </div>
            {spec && !tooBig && line && <p className="tl-off-sum">{tr('{amount} off: {dish} comes to {net}', { amount: money(off), dish: line.name, net: money(r2(gross - off)) })}</p>}
            {tooBig && <div className="error-banner">{tr('A discount is at most 100%.')}</div>}
          </>
        ) : (
          <>
            <p className="dk-muted">{tr('The dish costs the customer nothing. Say why: the manager sees it in the reports.')}</p>
            <div className="tl-chips">
              {COMP_REASONS.map((r) => <button key={r} type="button" className={'tl-chip' + (reason === tr(r) ? ' is-on' : '')} onClick={() => setReason(tr(r))}>{tr(r)}</button>)}
            </div>
            <input className="input" maxLength={120} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('Or write why')} aria-label={tr('Why it is on the house')} />
          </>
        )}
        {bill && serviceOn && (
          <div className={'tl-off-service' + (now.serviceOff ? ' is-off' : '')}>
            <span>{now.serviceOff ? tr('The service charge is off this bill.') : tr('{name} is on this bill.', { name: serviceWords(settings.serviceCharge.name, tr) })}</span>
            {now.serviceOff
              ? <button type="button" className="btn btn-secondary" onClick={() => onApply({ serviceOff: null })}>{tr('Put it back')}</button>
              : <button type="button" className="btn btn-secondary" onClick={serviceOff}>{tr('Take it off')}</button>}
          </div>
        )}
        {ask && <ManagerPin busy={busy} error={error} onPin={approve} />}
        {!ask && error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          {(bill ? now.discount : now.discountSpec || now.comp) && <button type="button" className="btn btn-secondary" onClick={() => onApply(bill ? { discount: null } : { discountSpec: null, comp: null })}>{tr('Remove the discount')}</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          {tab === 'discount'
            ? <button type="button" className="btn btn-primary" disabled={!spec || tooBig || !!ask} onClick={applyDiscount}>{tr('Give the discount')}</button>
            : <button type="button" className="btn btn-primary" disabled={reason.trim().length < 2 || !!ask} onClick={applyComp}>{tr('On the house')}</button>}
        </div>
      </div>
    </div>
  );
}
