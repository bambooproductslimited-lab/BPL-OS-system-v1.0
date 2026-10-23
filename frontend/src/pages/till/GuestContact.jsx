import { useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { msg, tr } from '../../lib/i18n.jsx';
import { contactOf } from './tillBill';
import './growth.css';

// A customer's email, birthday and whether they agree to texts and emails
// from the restaurant (backend restaurantPos guestContact; used by the
// campaigns, restaurantCampaigns): kept from the till's customer picker,
// when adding someone new or for the customer picked.

const ASKED = [['yes', '👍', msg('Yes, they agree')], ['no', '🚫', msg('No messages')], ['unknown', '🤷', msg('Not asked')]];

export function ContactFields({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="gx-fields">
      <label className="field"><span>{tr('Email (optional)')}</span><input className="input" type="email" maxLength={120} value={value.email} onChange={(e) => set({ email: e.target.value })} placeholder={'name@example.com'} /></label>
      <label className="field"><span>{tr('Birthday (optional)')}</span><input className="input" type="date" value={value.birthday} onChange={(e) => set({ birthday: e.target.value })} /></label>
      <div className="field gx-wide"><span>{tr('Texts and emails from us?')}</span>
        <div className="dk-segment" role="radiogroup" aria-label={tr('Texts and emails from us?')}>
          {ASKED.map(([k, ico, label]) => <button key={k} type="button" role="radio" aria-checked={value.marketing === k} className={value.marketing === k ? 'is-on' : ''} onClick={() => set({ marketing: k })}>{ico} {tr(label)}</button>)}
        </div>
      </div>
    </div>
  );
}

export default function GuestContactDialog({ token, guest, onSaved, onClose }) {
  const [v, setV] = useState(() => contactOf(guest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await posFetch('POST', '/pos/guests/' + guest.id + '/contact', token, { email: v.email.trim(), birthday: v.birthday || null, marketing: v.marketing })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog tl-dialog gx" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <span className="tl-dialog-ico is-send" aria-hidden="true">✉️</span>
        <h2>{guest.name}</h2>
        <p className="dk-muted">{tr('For birthday wishes and news from the restaurant. Each message has a link to stop them.')}</p>
        <ContactFields value={v} onChange={setV} />
        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : tr('Save')}</button>
        </div>
      </form>
    </div>
  );
}
