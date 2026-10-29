import { useState } from 'react';
import { fmtDate } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { NOT_LEAD_REASONS, NO_FOLLOW_UP_REASONS, reasonText } from './crmStopReasons';
import './crmStop.css';

// Not everyone who gets in touch is a lead, a prospect or a customer, and
// not every lead should be chased (backend migration 0208). Two buttons, on
// a lead and on a customer profile:
//  - Not a lead / Just a contact: a supplier, staff, a job seeker, a wrong
//    number. Out of Leads, Prospects and Customers, and out of every count;
//    the messages and the history stay. Put back with one press.
//  - Stop following up: still a lead or a customer, but out of the
//    follow-ups and the reminders, and left out of marketing sends.
// The reasons are in crmStopReasons.js.

// Pick a reason (and say more), then confirm.
export function ReasonPicker({ reasons, title, confirm, notePlaceholder, needNote, busy, onConfirm, onCancel }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const short = needNote && reason === 'other' && !note.trim();
  return (
    <div className="cst-pick" role="group" aria-label={title}>
      <strong className="cst-pick-title">{title}</strong>
      <div className="cst-reasons" role="radiogroup" aria-label={tr('Reason')}>
        {reasons.map((r) => (
          <button key={r.key} type="button" role="radio" aria-checked={reason === r.key} className={'cst-reason' + (reason === r.key ? ' is-on' : '')} onClick={() => setReason(r.key)}>
            <span className="cst-reason-ic" aria-hidden="true">{r.icon}</span>{tr(r.label)}
          </button>
        ))}
      </div>
      <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)}
        placeholder={reason === 'other' && needNote ? tr('Say who they are, in a few words') : notePlaceholder} aria-label={tr('A note (optional)')} />
      <div className="cst-pick-actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>{tr('Cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !reason || short} onClick={() => onConfirm(reason, note.trim())}>{confirm}</button>
      </div>
    </div>
  );
}

// What is set, and the button to undo it. kind: 'lead' or 'profile'.
export function StopBanners({ kind, notLead, notLeadWhy, noFollowUp, canManage, busy, onNotLead, onFollowUp }) {
  if (!notLead && !noFollowUp) return null;
  return (
    <div className="cst-banners">
      {notLead && (
        <div className="cst-banner cst-out">
          <span className="cst-banner-ic" aria-hidden="true">🗂️</span>
          <div className="cst-banner-main">
            <strong>{kind === 'lead' ? tr('Not a lead') : tr('Just a contact')}</strong>
            <span>{notLeadWhy ? reasonText(notLeadWhy, NOT_LEAD_REASONS) : tr('No reason given')}</span>
            <small>{kind === 'lead' ? tr('Not in Leads or Prospects, and not counted. The notes stay.') : tr('Not in Leads, Prospects or Customers, and not counted. Their messages and history stay.')}</small>
          </div>
          {canManage && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onNotLead(false)}>{kind === 'lead' ? tr('Put back as a lead') : tr('Put back')}</button>}
        </div>
      )}
      {noFollowUp && (
        <div className="cst-banner cst-quiet">
          <span className="cst-banner-ic" aria-hidden="true">🔕</span>
          <div className="cst-banner-main">
            <strong>{tr('Not to be followed up')}</strong>
            <span>{noFollowUp.reason ? reasonText(noFollowUp.reason, NO_FOLLOW_UP_REASONS) : tr('No reason given')}</span>
            <small>
              {noFollowUp.onProfile
                ? tr('Set on their customer profile, so it holds for every lead of theirs.')
                : noFollowUp.by ? tr('Set by {name} on {date}. Nobody is reminded to chase them.', { name: noFollowUp.by, date: fmtDate(noFollowUp.at) }) : tr('Set on {date}. Nobody is reminded to chase them.', { date: fmtDate(noFollowUp.at) })}
            </small>
          </div>
          {canManage && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onFollowUp(false)}>{tr('Follow up again')}</button>}
        </div>
      )}
    </div>
  );
}

// The two buttons. A tile is left out once it is set (its banner shows instead).
export function StopTiles({ kind, notLead, noFollowUp, notLeadBlocked, followable = true, canManage, busy, onNotLead, onFollowUp }) {
  const [picking, setPicking] = useState(null);
  if (!canManage || notLead) return null;
  async function done(fn, reason, note) { if (await fn(true, reason, note)) setPicking(null); }
  return (
    <section className="crm-box cst-box">
      <div className="crm-box-head"><h3 className="dk-h3">{tr('Not for us?')}</h3></div>
      {picking === 'out' ? (
        <ReasonPicker reasons={NOT_LEAD_REASONS} needNote busy={busy} onCancel={() => setPicking(null)} onConfirm={(r, n) => done(onNotLead, r, n)}
          title={kind === 'lead' ? tr('Who are they, if not a lead?') : tr('Who are they, if not a customer?')}
          notePlaceholder={tr('A few words, e.g. sells us bamboo poles')}
          confirm={kind === 'lead' ? tr('Take out of the leads') : tr('Make just a contact')} />
      ) : picking === 'stop' ? (
        <ReasonPicker reasons={NO_FOLLOW_UP_REASONS} busy={busy} onCancel={() => setPicking(null)} onConfirm={(r, n) => done(onFollowUp, r, n)}
          title={tr('Why stop following them up?')} notePlaceholder={tr('A note (optional)')} confirm={tr('Stop following up')} />
      ) : (
        <div className="cst-tiles">
          <button type="button" className="cst-tile cst-out" disabled={busy || !!notLeadBlocked} onClick={() => setPicking('out')} title={notLeadBlocked || undefined}>
            <span className="cst-tile-ic" aria-hidden="true">🗂️</span>
            <span className="cst-tile-main">
              <strong>{kind === 'lead' ? tr('Not a lead') : tr('Just a contact')}</strong>
              <small>{notLeadBlocked || (kind === 'lead'
                ? tr('A supplier, staff, a job seeker, a wrong number… Takes them out of Leads and Prospects.')
                : tr('Not a lead, prospect or customer: a supplier, staff, family, a wrong number… Takes them out of every list.'))}</small>
            </span>
          </button>
          {!noFollowUp && followable && (
            <button type="button" className="cst-tile cst-quiet" disabled={busy} onClick={() => setPicking('stop')}>
              <span className="cst-tile-ic" aria-hidden="true">🔕</span>
              <span className="cst-tile-main">
                <strong>{tr('Stop following up')}</strong>
                <small>{kind === 'lead'
                  ? tr('Stays a lead, but leaves the follow-ups: nobody is reminded to chase them.')
                  : tr('Stays where they are, but leaves the follow-ups and marketing sends: nobody is reminded to chase them.')}</small>
              </span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// A small grey pill for cards and lists.
export function StopPill({ notLead, noFollowUp }) {
  if (notLead) return <span className="cst-pill cst-out" title={tr('Not a lead')}>🗂️ {tr('Not a lead')}</span>;
  if (noFollowUp) return <span className="cst-pill cst-quiet" title={tr('Not to be followed up')}>🔕 {tr('No follow-up')}</span>;
  return null;
}
