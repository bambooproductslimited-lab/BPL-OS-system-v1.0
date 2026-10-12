import { useEffect, useRef, useState } from 'react';
import { API_URL, getToken } from '../../api/client';
import { CompanySwitcher, Icon, useCompany } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import { Ring } from '../crm/crmFun';
import './marketing.css';

// What the marketing department's pages share (pages/marketing/*): the
// words for every kind and status, the company picker, the banner, the
// little drawings, meters and pills. The look is in marketing.css (.mk-*).

export const OBJECTIVES = {
  awareness: msg('Get known'), leads: msg('Bring in leads'), sales: msg('Sell more'),
  launch: msg('Launch something new'), loyalty: msg('Bring customers back'), event: msg('Fill an event')
};
export const OBJECTIVE_GLYPH = { awareness: 'megaphone', leads: 'magnet', sales: 'cash', launch: 'rocket', loyalty: 'heart', event: 'flag' };
export const CAMPAIGN_STATUS = { draft: msg('Draft'), planned: msg('Planned'), active: msg('Live'), paused: msg('Paused'), completed: msg('Finished'), cancelled: msg('Cancelled') };
export const PHASES = {
  draft: msg('Draft'), upcoming: msg('Starts soon'), running: msg('Running'), paused: msg('Paused'),
  overdue: msg('Past its end date'), ended: msg('Finished'), cancelled: msg('Cancelled')
};
export const CHANNELS = {
  facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', whatsapp: 'WhatsApp', youtube: 'YouTube', website: msg('Website'),
  email: msg('Email'), sms: 'SMS', radio: msg('Radio'), tv: msg('TV'), print: msg('Print'), billboard: msg('Billboards'),
  events: msg('Events'), in_store: msg('In store'), referral: msg('Referrals'), other: msg('Other')
};
export const SPEND = {
  digital_ads: msg('Digital ads'), content: msg('Content & photos'), print: msg('Print'), events: msg('Events & fairs'),
  sponsorship: msg('Sponsorship'), influencers: msg('Influencers'), agency: msg('Agency & freelancers'), promo_items: msg('Promotional items'),
  pr: msg('PR & media'), other: msg('Other')
};
export const REQUEST_KINDS = {
  social_post: msg('Social media post'), flyer: msg('Flyer'), brochure: msg('Brochure or catalogue'), banner: msg('Banner or roll-up'),
  signage: msg('Signage'), video: msg('Video'), photos: msg('Photos'), website: msg('Website change'), presentation: msg('Presentation'),
  event: msg('Help with an event'), other: msg('Something else')
};
export const REQUEST_GLYPH = { social_post: 'chat', flyer: 'file', brochure: 'book', banner: 'flag', signage: 'sign', video: 'video', photos: 'camera', website: 'globe', presentation: 'chart', event: 'calendar', other: 'sparkle' };
export const REQUEST_STATUS = { new: msg('New'), in_progress: msg('In progress'), review: msg('Ready to check'), done: msg('Done'), declined: msg('Declined') };
export const EVENT_KINDS = {
  trade_fair: msg('Trade fair'), exhibition: msg('Exhibition'), launch: msg('Launch'), showroom: msg('Showroom day'), tasting: msg('Tasting'),
  sponsorship: msg('Sponsorship'), community: msg('Community event'), webinar: msg('Webinar or online event'), other: msg('Other')
};
export const EVENT_STATUS = { planned: msg('Planned'), confirmed: msg('Confirmed'), done: msg('Done'), cancelled: msg('Cancelled') };
export const PROMO_KINDS = { percent: msg('Percentage off'), amount: msg('Amount off'), bundle: msg('Bundle'), free_item: msg('Free item'), other: msg('Other') };
export const PROMO_STATE = { upcoming: msg('Starts soon'), running: msg('Running'), ended: msg('Ended'), paused: msg('Paused') };
export const ASSET_KINDS = { logo: msg('Logos'), guideline: msg('Brand guidelines'), template: msg('Templates'), photo: msg('Photos'), video: msg('Videos'), font: msg('Fonts'), print: msg('Print-ready artwork'), other: msg('Other files') };
export const INTEL_KINDS = { price: msg('A price'), promotion: msg('A promotion'), product: msg('A new product'), news: msg('News'), review: msg('Reviews'), other: msg('Other') };
export const POSITIONS = { lower: msg('Cheaper than us'), similar: msg('About the same'), higher: msg('Dearer than us'), unknown: msg('Not known yet') };
// The marketing moments the calendar marks (mkHome.service.js moments()).
export const MOMENTS = {
  new_year: msg('New Year\'s Day'), valentines: msg('Valentine\'s Day'), womens_day: msg('International Women\'s Day'), easter: msg('Easter Sunday'),
  mothers_day: msg('Mother\'s Day'), fathers_day: msg('Father\'s Day'), black_friday: msg('Black Friday'), christmas_eve: msg('Christmas Eve'),
  christmas: msg('Christmas Day'), new_years_eve: msg('New Year\'s Eve')
};
// An event's standard checklist (mkEvents.service.js CHECKLISTS), to show
// in the reader's language.
export const CHECKLIST_WORDS = [
  msg('Book the stand or space'), msg('Design the stand, banners and roll-ups'), msg('Print flyers, brochures and price lists'), msg('Rota the staff for the stand'),
  msg('Pack samples, stand and lead forms'), msg('Collect every visitor\'s details'), msg('Enter the leads in the CRM'), msg('Follow up every lead'), msg('Write up how it went'),
  msg('Fix the date and guest list'), msg('Send the invitations'), msg('Invite press and influencers'), msg('Tease it on social media'), msg('Photos and video on the day'),
  msg('Post the thank-yous and photos'), msg('Confirm the venue and date'), msg('Get the promotion material ready'), msg('Post about it'), msg('Photos on the day')
];

export function L(map, key) { return map[key] ? tr(map[key]) : key || '—'; }
export function cedis(n) { return money(n || 0); }
export function short(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 1 }) + 'M';
  if (Math.abs(v) >= 1e4) return (v / 1e3).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 1 }) + 'k';
  return v.toLocaleString(activeIntlLocale(), { maximumFractionDigits: 0 });
}
export function whole(n) { return Number(n || 0).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 0 }); }
export function todayIso() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function addDays(iso, n) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000); }
export function dayLabel(iso, opts) { return iso ? new Date(String(iso).slice(0, 10) + 'T00:00').toLocaleDateString(activeIntlLocale(), opts || { day: 'numeric', month: 'short' }) : '—'; }
export function dateRange(a, b) {
  if (!a && !b) return tr('No dates yet');
  if (a && b && a !== b) return dayLabel(a) + ' – ' + dayLabel(b, { day: 'numeric', month: 'short', year: 'numeric' });
  return dayLabel(a || b, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function readParam(name) { try { return new URLSearchParams(window.location.search).get(name); } catch { return null; } }

// The company the pages are about: Bamboo Products and the restaurants,
// remembered on this device and in ?company=.
export function useMkCompany() {
  return useCompany('bos.mk.company', '/mk/companies');
}
export function MkCompanies({ mk }) {
  return <CompanySwitcher companies={mk.companies} company={mk.company} onPick={mk.switchTo} />;
}

// Drawings the DashKit icons do not have.
const GLYPH = {
  megaphone: <><path d="M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1z" /><path d="M15 9a3.5 3.5 0 0 1 0 6M17.5 6.5a7 7 0 0 1 0 11" /></>,
  magnet: <><path d="M6 3v8a6 6 0 0 0 12 0V3" /><path d="M6 7h4M14 7h4M10 3v8a2 2 0 0 0 4 0V3" /></>,
  cash: <><rect x="3" y="6.5" width="18" height="11" rx="2" /><circle cx="12" cy="12" r="2.5" /></>,
  rocket: <><path d="M12 3c3 2 5 5.5 5 9.5L15 15H9l-2-2.5C7 8.5 9 5 12 3z" /><circle cx="12" cy="9.5" r="1.6" /><path d="M9 15l-2 4 3-1M15 15l2 4-3-1" /></>,
  heart: <><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" /></>,
  flag: <><path d="M5 21V4M5 4h11l-2 3.5L16 11H5" /></>,
  chat: <><path d="M4 5h16v11H9l-5 4z" /></>,
  file: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4" /></>,
  book: <><path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5" /></>,
  sign: <><path d="M12 3v3M5 6h14l2 3-2 3H5z" /><path d="M12 12v9" /></>,
  video: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>,
  camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  sparkle: <><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" /></>,
  wallet: <><path d="M4 7h15a1 1 0 0 1 1 1v11H5a1 1 0 0 1-1-1z" /><path d="M4 7l11-3v3M16 13h1" /></>,
  ticket: <><path d="M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 1 0-4V4H3z" transform="translate(0 2)" /><path d="M14 6v12" strokeDasharray="2 2" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.5-1.2-1.7-1.2-3 0-1 .8-1.5 1.7-1.5H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" /><circle cx="7.5" cy="11" r="1.2" /><circle cx="10" cy="7" r="1.2" /><circle cx="14.5" cy="7" r="1.2" /></>,
  binoculars: <><circle cx="6.5" cy="15.5" r="3.5" /><circle cx="17.5" cy="15.5" r="3.5" /><path d="M10 15.5h4M5 12l2-7h3v10M19 12l-2-7h-3v10" /></>,
  inbox: <><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 2h6l1-2h5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  check: <><path d="M5 12.5l4.5 4.5L19 7" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  fire: <><path d="M12 21c-4 0-6.5-2.6-6.5-6 0-3.5 3-5.5 3.5-9 2 1.3 3 3 3 5 1-.8 1.6-2 1.7-3.3C16.3 9.5 18.5 12 18.5 15c0 3.4-2.5 6-6.5 6z" /></>,
  trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7" /></>,
  download: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14" /></>,
  upload: <><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 20h14" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" /></>,
  pin: <><path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z" /><circle cx="12" cy="10.5" r="2" /></>,
  tag: <><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1.4" /></>,
  arrowR: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  play: <><path d="M7 5v14l12-7z" /></>,
  stop: <><rect x="6" y="6" width="12" height="12" rx="2" /></>,
  moon: <><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></>,
  gift: <><rect x="3" y="8" width="18" height="5" rx="1" /><path d="M5 13v8h14v-8M12 8v13M12 8C10 4 6.5 4.5 7 7c.3 1.4 3 1 5 1zM12 8c2-4 5.5-3.5 5-1-.3 1.4-3 1-5 1z" /></>
};
export function Glyph({ name, size }) {
  const s = size || 18;
  return <svg className="mk-glyph" width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[name] || GLYPH.sparkle}</svg>;
}

// The banner every marketing page opens with. ring: { value, max, big,
// small, caption, tone }; stats: [{ icon, value, label, note, tone, onClick }].
export function MkBanner({ eyebrow, title, sub, actions, ring, stats, art = 'megaphone', theme = '' }) {
  return (
    <section className={'mk-hero' + (theme ? ' is-' + theme : '')}>
      <span className="mk-hero-glow" aria-hidden="true" />
      <span className="mk-hero-art" aria-hidden="true">
        <span className="mk-bubble is-1" /><span className="mk-bubble is-2" /><span className="mk-bubble is-3" />
        <span className="mk-hero-big"><Glyph name={art} size={150} /></span>
        <span className="mk-spark is-1"><Glyph name="sparkle" size={26} /></span>
        <span className="mk-spark is-2"><Glyph name="sparkle" size={18} /></span>
      </span>
      <div className="mk-hero-main">
        <span className="mk-eyebrow"><span className="mk-eyebrow-dot" />{eyebrow}</span>
        <h1 className="mk-hero-title">{title}</h1>
        {sub && <p className="mk-hero-sub">{sub}</p>}
        {actions && <div className="mk-hero-actions no-print">{actions}</div>}
      </div>
      {(ring || (stats && stats.length > 0)) && (
        <div className={'mk-hero-side' + (ring ? '' : ' no-ring')}>
          {ring && (
            <div className="mk-ring">
              <Ring value={ring.value} max={ring.max || 1} size={132} stroke={13} tone={ring.tone || ''}>
                <strong>{ring.big}</strong>
                {ring.small && <small>{ring.small}</small>}
              </Ring>
              {ring.caption && <span className="mk-ring-cap">{ring.caption}</span>}
            </div>
          )}
          <div className="mk-tiles">
            {(stats || []).map((s, i) => {
              const Tag = s.onClick ? 'button' : 'div';
              return (
                <Tag key={i} type={s.onClick ? 'button' : undefined} onClick={s.onClick} className={'mk-tile' + (s.tone ? ' is-' + s.tone : '')}>
                  <span className="mk-tile-label">{s.glyph ? <Glyph name={s.glyph} size={14} /> : <Icon name={s.icon || 'spark'} />} {s.label}</span>
                  <span className={'mk-tile-value' + (String(s.value).length > 12 ? ' is-long' : '')}>{s.value}</span>
                  {s.note && <span className="mk-tile-note">{s.note}</span>}
                </Tag>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// A bar to a target; over 100% shows full with the figure beside it.
export function Meter({ value, max, tone, label }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <span className={'mk-meter' + (tone ? ' is-' + tone : '')} title={label}>
      <span className="mk-meter-track" aria-hidden="true"><i style={{ width: Math.min(100, Math.max(value > 0 ? 3 : 0, pct)) + '%' }} /></span>
      {label && <span className="mk-meter-label">{label}</span>}
    </span>
  );
}

export function Pill({ tone, children, glyph }) {
  return <span className={'mk-pill is-' + (tone || 'muted')}>{glyph && <Glyph name={glyph} size={12} />}{children}</span>;
}
// A campaign's third figure: what it reached for one meant to get known;
// otherwise its return, once a sale came in or it has ended (a campaign
// still waiting for its first sale is not "−100%").
export function campaignReturn(c) {
  const r = c.results;
  if (c.objective === 'awareness') return { label: tr('Reached'), value: short(r.reach), tone: '' };
  if (r.roi === null || (r.revenue <= 0 && c.phase !== 'ended')) return { label: tr('Return'), value: '—', tone: '', note: tr('No sales yet') };
  return { label: tr('Return'), value: (r.roi > 0 ? '+' : '') + r.roi + '%', tone: r.roi >= 0 ? 'good' : 'bad' };
}
export const PHASE_TONE = { draft: 'muted', upcoming: 'info', running: 'good', paused: 'warn', overdue: 'bad', ended: 'violet', cancelled: 'muted' };
export const REQUEST_TONE = { new: 'info', in_progress: 'violet', review: 'warn', done: 'good', declined: 'muted' };

export function ChannelChips({ list }) {
  if (!list || !list.length) return null;
  return <span className="mk-chans">{list.map((c) => <span key={c} className={'mk-chan is-' + c}>{L(CHANNELS, c)}</span>)}</span>;
}

// Picks from a list as toggle chips. options: [[key, label]].
export function ChipPicker({ options, value, onChange, single, label }) {
  const on = (k) => (single ? value === k : (value || []).includes(k));
  return (
    <div className="mk-chippick" role={single ? 'radiogroup' : 'group'} aria-label={label}>
      {options.map(([k, text, glyph]) => (
        <button key={k} type="button" role={single ? 'radio' : 'checkbox'} aria-checked={on(k)} className={'mk-chipopt' + (on(k) ? ' is-on' : '')}
          onClick={() => onChange(single ? k : (on(k) ? value.filter((x) => x !== k) : [...(value || []), k]))}>
          {glyph && <Glyph name={glyph} size={14} />}{text}
        </button>
      ))}
    </div>
  );
}

// A protected file opened in a new tab (fetched with the sign-in token).
export function openFile(path, download) {
  const win = download ? null : window.open('', '_blank');
  fetch(API_URL + path + (download ? (path.includes('?') ? '&' : '?') + 'download=1' : ''), { headers: { Authorization: 'Bearer ' + (getToken() || '') } })
    .then((r) => (r.ok ? r.blob().then((b) => ({ b, name: (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) })) : null))
    .then((x) => {
      if (!x) { if (win) win.close(); return; }
      const url = URL.createObjectURL(x.b);
      if (download) {
        const a = document.createElement('a'); a.href = url; a.download = x.name ? x.name[1] : 'file'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      } else if (win) win.location.href = url;
    }).catch(() => { if (win) win.close(); });
}
// A protected image as an object URL.
export function useProtectedImage(path) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true, made = null;
    setUrl(null);
    if (!path) return undefined;
    fetch(API_URL + path, { headers: { Authorization: 'Bearer ' + (getToken() || '') } })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && alive) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  return url;
}

// The empty state with a drawing and what to do.
export function MkEmpty({ glyph, title, children, action }) {
  return (
    <div className="mk-empty">
      <span className="mk-empty-art"><Glyph name={glyph || 'sparkle'} size={34} /></span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// A wide window with a title row and a close button.
export function MkDialog({ title, sub, onClose, wide, children, footer, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    // Escape closes the window on top only.
    function onKey(e) { if (e.key === 'Escape' && ref.current && ref.current === Array.from(document.querySelectorAll('.mk-dialog')).pop()) onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div ref={ref} className={'dialog mk-dialog' + (wide ? ' is-wide' : '') + (className ? ' ' + className : '')} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="mk-dialog-head">
          <div className="mk-dialog-titles"><h2>{title}</h2>{sub && <p className="dk-muted">{sub}</p>}</div>
          <button type="button" className="mk-x" onClick={onClose} aria-label={tr('Close')}>×</button>
        </div>
        <div className="mk-dialog-body">{children}</div>
        {footer && <div className="dialog-actions mk-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
