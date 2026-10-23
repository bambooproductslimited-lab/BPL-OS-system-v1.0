import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './growth.css';

// Texts and emails to the restaurant's guests (back office → Guests →
// Campaigns; backend restaurantCampaigns): a message to an audience, sent
// now or at a set time, with who it reaches and who is left out (and why)
// before it goes; how many came back in the 14 days after; and the
// automatic ones — "we miss you", "happy birthday", "thank you for coming"
// — with the limits that keep messages welcome (saved with the settings).

const AUDIENCES = [
  ['all', msg('Everyone'), null],
  ['regulars', msg('Regulars'), ['visits', msg('at least {n} visits in 90 days'), 3]],
  ['lapsed', msg('Not back lately'), ['days', msg('not back for {n} days'), 30]],
  ['new', msg('New guests'), ['days', msg('first came in the last {n} days'), 30]],
  ['loyalty', msg('Loyalty members'), ['points', msg('with at least {n} points'), 1]],
  ['birthday', msg('Birthdays this month'), null],
  ['spenders', msg('Big spenders'), ['amount', msg('spent at least GHS {n} in 90 days'), 500]]
];
const CHANNELS = [['sms', msg('Text'), '💬'], ['email', msg('Email'), '✉️'], ['both', msg('Text, else email'), '✨']];
const WHY = {
  'said no': msg('said no to messages'), 'not agreed': msg('not asked yet (only those who agreed)'), 'messaged lately': msg('messaged lately'),
  'no phone': msg('no phone number'), 'no email': msg('no email'), 'no phone or email': msg('no phone or email')
};
const STATUS = { draft: msg('Draft'), scheduled: msg('Set for later'), sending: msg('Going out'), sent: msg('Sent'), cancelled: msg('Cancelled'), auto: msg('Automatic') };
const AUTO = [['lapsed', '👋', msg('We miss you'), msg('Once, to a guest who has not come back for a while.')],
  ['birthday', '🎂', msg('Happy birthday'), msg('On their birthday, to guests whose birthday the till knows.')],
  ['welcome', '🙏', msg('Thank you for coming'), msg('The day after a guest\'s first visit.')]];
const BLANK = { name: '', channel: 'sms', subject: '', message: '', audience: { kind: 'all' } };

function audienceWords(a) {
  const x = AUDIENCES.find((y) => y[0] === (a && a.kind)) || AUDIENCES[0];
  return tr(x[1]) + (x[2] && a[x[2][0]] != null ? ' · ' + tr(x[2][1], { n: a[x[2][0]] }) : '');
}
function when(d) { return d ? new Date(d).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }

function Toggle({ on, title, note, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} className="ts-toggle-row" onClick={() => onChange(!on)}>
      <span><strong>{title}</strong>{note && <small>{note}</small>}</span>
      <span className={'ts-switch' + (on ? ' is-on' : '')} aria-hidden="true"><i /></span>
    </button>
  );
}

function Composer({ token, pin, companyName, onDone, onFail, onCancel }) {
  const [c, setC] = useState(BLANK);
  const [pv, setPv] = useState(null);
  const [later, setLater] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setC((x) => ({ ...x, ...patch }));
  const aud = AUDIENCES.find((a) => a[0] === c.audience.kind);
  // What it would reach, a moment after each change.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      posFetch('POST', '/pos/settings/campaigns', token, { managerPin: pin || undefined, action: 'preview', campaign: { ...c, name: c.name || 'Preview', message: c.message.length >= 10 ? c.message : 'Preview message.' } })
        .then((r) => { if (live) setPv(r); }).catch(() => {});
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [c, token, pin]);
  async function go(action) {
    setBusy(true);
    try {
      const body = { managerPin: pin || undefined, action, campaign: c };
      if (action === 'send' && later) body.sendAt = new Date(later).toISOString();
      onDone(await posFetch('POST', '/pos/settings/campaigns', token, body), action === 'send' ? (later ? tr('Set for {when}.', { when: when(later) }) : tr('Going out now.')) : tr('Saved as a draft.'));
    } catch (e) { onFail(e); } finally { setBusy(false); }
  }
  const ok = c.name.trim().length >= 2 && c.message.trim().length >= 10;
  const sampleText = pv ? pv.sample.text : c.message;
  return (
    <div className="cm-compose">
      <div className="cm-form">
        <label className="field"><span>{tr('Name (for you)')}</span><input className="input" maxLength={60} value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder={tr('e.g. Weekend jollof special')} /></label>
        <div className="field"><span>{tr('To whom')}</span>
          <div className="ts-chips cm-aud" role="radiogroup" aria-label={tr('To whom')}>
            {AUDIENCES.map(([k, label, p]) => (
              <button key={k} type="button" role="radio" aria-checked={c.audience.kind === k} className={c.audience.kind === k ? 'is-on' : ''}
                onClick={() => set({ audience: p ? { kind: k, [p[0]]: c.audience.kind === k ? c.audience[p[0]] : p[2] } : { kind: k } })}>{tr(label)}</button>
            ))}
          </div>
          {aud && aud[2] && (
            <label className="cm-param">
              <input className="input ts-bill-num" type="number" min="1" value={c.audience[aud[2][0]] ?? ''} onChange={(e) => set({ audience: { ...c.audience, [aud[2][0]]: Number(e.target.value) } })} />
              <span>{tr(aud[2][1], { n: c.audience[aud[2][0]] ?? '' })}</span>
            </label>
          )}
        </div>
        <div className="field"><span>{tr('By')}</span>
          <div className="dk-segment" role="radiogroup" aria-label={tr('By')}>
            {CHANNELS.map(([k, label, ico]) => <button key={k} type="button" role="radio" aria-checked={c.channel === k} className={c.channel === k ? 'is-on' : ''} onClick={() => set({ channel: k })}>{ico} {tr(label)}</button>)}
          </div>
        </div>
        {c.channel !== 'sms' && <label className="field"><span>{tr('Email subject')}</span><input className="input" maxLength={120} value={c.subject} onChange={(e) => set({ subject: e.target.value })} placeholder={companyName} /></label>}
        <label className="field"><span>{tr('Message')}</span>
          <textarea className="input cm-msg" rows={4} maxLength={480} value={c.message} onChange={(e) => set({ message: e.target.value })} placeholder={tr('e.g. Hi {name}, our new jollof is here this weekend. See you soon!')} />
        </label>
        <div className="cm-tokens">
          {['{name}', '{restaurant}', '{points}'].map((t) => <button key={t} type="button" className="ts-chip" onClick={() => set({ message: (c.message + ' ' + t).trim() })}>{t}</button>)}
          <small className="dk-muted">{tr('{name} is the guest\'s first name. A link to stop the messages is added at the end.')}</small>
        </div>
      </div>
      <aside className="cm-side">
        <div className="cm-phone" aria-label={tr('How it looks')}>
          <span className="cm-phone-notch" aria-hidden="true" />
          <span className="cm-phone-from">{companyName}</span>
          <p className="cm-bubble">{sampleText || <em>{tr('Your message shows here.')}</em>}{pv && c.channel !== 'email' && <span className="cm-stop">{tr('Stop')}: …/u/•••</span>}</p>
        </div>
        {pv && (
          <div className="cm-reach">
            <strong className="cm-reach-n">{pv.reach}</strong>
            <span>{tr('guests reached, of {n} in this audience', { n: pv.matching })}</span>
            <div className="cm-reach-split">
              {pv.bySms > 0 && <span>💬 {tr('{n} by text', { n: pv.bySms })}{pv.sample.segments > 1 ? ' · ' + tr('{n} texts each', { n: pv.sample.segments }) : ''}</span>}
              {pv.byEmail > 0 && <span>✉️ {tr('{n} by email', { n: pv.byEmail })}</span>}
            </div>
            {Object.keys(pv.left).length > 0 && (
              <ul className="cm-left is-plain">{Object.keys(pv.left).map((k) => <li key={k}>{tr('{n} left out: {why}', { n: pv.left[k], why: WHY[k] ? tr(WHY[k]) : k })}</li>)}</ul>
            )}
            {(!pv.smsOn && c.channel !== 'email') && <p className="cm-warn">{tr('Texts are not set up on the server (mNotify): they would be kept as not sent.')}</p>}
            {(!pv.emailOn && c.channel !== 'sms') && <p className="cm-warn">{tr('Email is not set up on the server: emails would be kept as not sent.')}</p>}
            {pv.reach > pv.dailyMax - pv.sentToday && <p className="cm-warn">{tr('More than today\'s limit ({n} left): the rest go out tomorrow.', { n: Math.max(0, pv.dailyMax - pv.sentToday) })}</p>}
          </div>
        )}
        <label className="field cm-later"><span>{tr('Send later (optional)')}</span><input className="input" type="datetime-local" value={later} onChange={(e) => setLater(e.target.value)} /></label>
        <div className="cm-go">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-secondary" disabled={busy || !ok} onClick={() => go('save')}>{tr('Save draft')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !ok || !pv || !pv.reach} onClick={() => go('send')}>{later ? tr('Set it') : tr('Send now')}</button>
        </div>
      </aside>
    </div>
  );
}

export default function CampaignsTab({ token, pin, draft, set, companyName, onFail }) {
  const [data, setData] = useState(null);
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState(null);
  const load = useCallback(() => posFetch('POST', '/pos/settings/campaigns', token, { managerPin: pin || undefined }).then(setData).catch(onFail), [token, pin, onFail]);
  useEffect(() => { load(); }, [load]);
  const cs = draft.campaigns;
  const setCs = (patch) => set(['campaigns'], { ...cs, ...patch });
  async function cancel(c) {
    try { setData(await posFetch('POST', '/pos/settings/campaigns', token, { managerPin: pin || undefined, action: 'cancel', id: c.id })); } catch (e) { onFail(e); }
  }
  const g = data && data.guests;
  const manual = data ? data.campaigns.filter((c) => c.kind === 'manual') : [];
  const autos = data ? data.campaigns.filter((c) => c.kind !== 'manual') : [];
  return (
    <section className="ts-sec cm">
      {g && (
        <div className="cm-stats">
          <div className="cm-stat"><b>{g.guests}</b><span>{tr('guests')}</span></div>
          <div className="cm-stat"><b>{g.phones}</b><span>{tr('with a phone')}</span></div>
          <div className="cm-stat"><b>{g.emails}</b><span>{tr('with an email')}</span></div>
          <div className="cm-stat is-yes"><b>{g.agreed}</b><span>{tr('agreed to messages')}</span></div>
          <div className="cm-stat is-no"><b>{g.said_no}</b><span>{tr('said no')}</span></div>
          <div className="cm-stat"><b>{data.sentToday}<small>/{cs.dailyMax}</small></b><span>{tr('sent today')}</span></div>
          <div className="cm-ways">
            <span className={'ko-pill' + (data.smsOn ? ' is-on' : '')}>💬 {data.smsOn ? tr('Texts on') : tr('Texts not set up')}</span>
            <span className={'ko-pill' + (data.emailOn ? ' is-on' : '')}>✉️ {data.emailOn ? tr('Email on') : tr('Email not set up')}</span>
          </div>
        </div>
      )}
      {note && <div className="ts-flash" role="status">{note}</div>}
      <div className="cm-head">
        <h3>{tr('Campaigns')}</h3>
        {!composing && <button type="button" className="btn btn-primary" onClick={() => { setComposing(true); setNote(null); }}>＋ {tr('New campaign')}</button>}
      </div>
      {composing && <Composer token={token} pin={pin} companyName={companyName} onFail={onFail} onCancel={() => setComposing(false)} onDone={(d, words) => { setData(d); setComposing(false); setNote(words); }} />}
      <div className="cm-list">
        {manual.map((c) => (
          <article key={c.id} className={'cm-card is-' + c.status}>
            <header>
              <span className={'cm-status is-' + c.status}>{tr(STATUS[c.status] || STATUS.draft)}</span>
              <strong>{c.name}</strong>
              <small>{c.status === 'scheduled' ? when(c.sendAt) : when(c.finishedAt || c.startedAt || c.createdAt)}{c.by ? ' · ' + c.by : ''}</small>
            </header>
            <p className="cm-card-msg">{c.message}</p>
            <div className="cm-card-meta">
              <span>{CHANNELS.find((x) => x[0] === c.channel)[2]} {audienceWords(c.audience)}</span>
              {c.counts && c.counts.sent != null && <span>{tr('{n} sent', { n: c.counts.sent })}{c.counts.failed ? ' · ' + tr('{n} failed', { n: c.counts.failed }) : ''}{c.counts.skipped ? ' · ' + tr('{n} not sent', { n: c.counts.skipped }) : ''}</span>}
            </div>
            {c.results && (
              <div className="cm-results">
                <span className="cm-results-ico" aria-hidden="true">📈</span>
                <span>{c.results.guests ? tr('{n} came back within 14 days: {orders} orders, {amount}', { n: c.results.guests, orders: c.results.orders, amount: money(c.results.spent) }) : tr('Nobody came back yet in the 14 days after.')}</span>
              </div>
            )}
            {(c.status === 'scheduled' || c.status === 'draft') && <button type="button" className="pos-link is-bad" onClick={() => cancel(c)}>{tr('Cancel it')}</button>}
          </article>
        ))}
        {data && !manual.length && !composing && (
          <div className="tq-empty"><span aria-hidden="true">💌</span><strong>{tr('No campaigns yet')}</strong><p>{tr('Tell your guests about a new dish, a party night or a happy hour: by text or email, to the guests you pick.')}</p></div>
        )}
      </div>

      <div className="ts-bill-block cm-auto">
        <h3><span aria-hidden="true">🤖</span>{tr('Automatic messages')}</h3>
        <p className="dk-muted">{tr('They go out by themselves, once a guest is due. Saved with the settings.')}</p>
        <div className="cm-auto-grid">
          {AUTO.map(([k, ico, title, hint]) => {
            const a = cs[k];
            const sent = autos.find((x) => x.kind === k);
            return (
              <div key={k} className={'cm-auto-card' + (a.on ? ' is-on' : '')}>
                <Toggle on={a.on} title={ico + ' ' + tr(title)} note={tr(hint)} onChange={(v) => setCs({ [k]: { ...a, on: v } })} />
                {k === 'lapsed' && (
                  <label className="cm-param"><input className="input ts-bill-num" type="number" min="7" max="365" value={a.days} onChange={(e) => setCs({ lapsed: { ...a, days: Number(e.target.value) } })} /><span>{tr('days without a visit')}</span></label>
                )}
                <div className="dk-segment" role="radiogroup" aria-label={tr('By')}>
                  {CHANNELS.map(([c2, label, i2]) => <button key={c2} type="button" role="radio" aria-checked={a.channel === c2} className={a.channel === c2 ? 'is-on' : ''} onClick={() => setCs({ [k]: { ...a, channel: c2 } })}>{i2} {tr(label)}</button>)}
                </div>
                <textarea className="input" rows={3} maxLength={480} value={a.message} onChange={(e) => setCs({ [k]: { ...a, message: e.target.value } })} aria-label={tr(title)} />
                {sent && sent.counts && sent.counts.sent > 0 && <small className="dk-muted">{tr('{n} sent so far', { n: sent.counts.sent })}{sent.results && sent.results.guests ? ' · ' + tr('{n} came back', { n: sent.results.guests }) : ''}</small>}
              </div>
            );
          })}
        </div>
        <h3><span aria-hidden="true">🛡️</span>{tr('Keep it welcome')}</h3>
        <div className="ts-guests-grid">
          <div className="field"><label htmlFor="cm-gap">{tr('Days between two to the same guest')}</label><input id="cm-gap" className="input ts-bill-num" type="number" min="0" max="60" value={cs.perGuestDays} onChange={(e) => setCs({ perGuestDays: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="cm-max">{tr('At most a day')}</label><input id="cm-max" className="input ts-bill-num" type="number" min="1" max="5000" value={cs.dailyMax} onChange={(e) => setCs({ dailyMax: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="cm-from">{tr('Not before')}</label><input id="cm-from" className="input" type="time" value={cs.from} onChange={(e) => setCs({ from: e.target.value })} /></div>
          <div className="field"><label htmlFor="cm-to">{tr('Not after')}</label><input id="cm-to" className="input" type="time" value={cs.to === '24:00' ? '23:59' : cs.to} onChange={(e) => setCs({ to: e.target.value })} /></div>
        </div>
        <Toggle on={cs.onlyAgreed} title={tr('Only guests who said yes')} note={cs.onlyAgreed ? tr('Only guests marked as agreeing at the till get messages.') : tr('Every guest who has not said no. Each message has a link to stop them.')} onChange={(v) => setCs({ onlyAgreed: v })} />
      </div>
    </section>
  );
}
