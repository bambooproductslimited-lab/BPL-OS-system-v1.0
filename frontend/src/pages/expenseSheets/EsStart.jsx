import { useState } from 'react';
import { Icon } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { LineForm } from './EsParts';

// Someone with no expense sheet paid for something for the company from
// their own pocket: they record it here with the receipt (POST
// /expense-sheets/start), a sheet with no float opens for them, their
// manager checks it and finance pays them back. `open` shows the form
// straight away (the page of someone with no sheet at all); otherwise it
// waits behind a button (finance or a supervisor with no sheet of their own).
export default function EsStart({ lists, onDone, open: openIn }) {
  const [open, setOpen] = useState(!!openIn);
  const sheet = { id: 'new', lists: lists || { categories: [], costCentres: [] }, suggestions: { payees: [], assets: [] }, lines: [] };
  const steps = [
    { icon: 'receipt', title: tr('You record it'), text: tr('What you bought, what it cost and a photo of the receipt.') },
    { icon: 'check', title: tr('Your manager checks it'), text: tr('They confirm your sheet, the same way floats are checked.') },
    { icon: 'cash', title: tr('Finance pays you back'), text: tr('The money goes on your sheet as received, and it is settled.') }
  ];
  return (
    <section className={'es-card es-start' + (open ? ' is-open' : '')}>
      <div className="es-start-head">
        <span className="es-start-art" aria-hidden="true"><Icon name="receipt" /></span>
        <div className="es-start-text">
          <h2>{tr('Paid for something for the company?')}</h2>
          <p>{tr('Record it here and finance pays you back. Your own expense sheet opens with it, so you can follow it until it is settled.')}</p>
        </div>
        {!open && <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>{tr('I paid for something')}</button>}
      </div>
      <ol className="es-steps">
        {steps.map((s, i) => (
          <li key={s.title}><span className="es-step-n">{i + 1}</span><Icon name={s.icon} /><b>{s.title}</b><small>{s.text}</small></li>
        ))}
      </ol>
      {open && (lists ? <LineForm sheet={sheet} start onSaved={onDone} onCancel={openIn ? null : () => setOpen(false)} /> : <div className="eyebrow">{tr('Loading…')}</div>)}
    </section>
  );
}
