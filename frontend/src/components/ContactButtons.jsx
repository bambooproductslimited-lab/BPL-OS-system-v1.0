import { tr } from '../lib/i18n.jsx';

// One-tap call / WhatsApp / email for someone outside the OS — a supplier,
// a client, a tenant. The buttons use the .ppl-act look from
// pages/EmployeesPage.css (import it on the page), the same as the
// employee directory's.

const PATHS = {
  phone: <path d="M6.5 4h3l1.5 4-2 1.2a10 10 0 0 0 5.8 5.8L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  whatsapp: <><path d="M4 20l1.2-4.1A8 8 0 1 1 8.3 19z" /><path d="M9 8.6c0 3.3 3 6.4 6.4 6.4l1-1.6-2-1-1 .9a4.4 4.4 0 0 1-2.7-2.7l.9-1-1-2z" /></>
};
function Glyph({ name }) {
  return <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>;
}

// A Ghanaian number as WhatsApp wants it (233…), or null when it cannot be
// read as a full number.
export function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '233' + d.slice(1);
  else if (d.length === 9) d = '233' + d;
  return d.length >= 11 ? d : null;
}

export default function ContactButtons({ name, phone, email }) {
  const wa = waNumber(phone);
  const mail = email && !/@no-email\.placeholder$/i.test(email) ? email : null;
  if (!phone && !mail) return null;
  return (
    <span className="ppl-acts" onClick={(e) => e.stopPropagation()}>
      {phone && <a className="ppl-act" href={'tel:' + String(phone).replace(/\s+/g, '')} title={tr('Call {name}', { name })} aria-label={tr('Call {name}', { name })}><Glyph name="phone" /></a>}
      {wa && <a className="ppl-act is-wa" href={'https://wa.me/' + wa} target="_blank" rel="noopener noreferrer" title={tr('WhatsApp {name}', { name })} aria-label={tr('WhatsApp {name}', { name })}><Glyph name="whatsapp" /></a>}
      {mail && <a className="ppl-act is-mail" href={'mailto:' + mail} title={tr('Email {name}', { name })} aria-label={tr('Email {name}', { name })}><Glyph name="mail" /></a>}
    </span>
  );
}
