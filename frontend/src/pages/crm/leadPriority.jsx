import { Icon, fmtDate } from '../../components/DashKit';
import { msg, tr } from '../../lib/i18n.jsx';
import './leadPriority.css';

// A lead's priority, as the Leads and Prospects pages show it: a ring with
// the score (0–100), its tier, and the reasons behind it. Worked out by
// backend/src/services/crmLeadPriority.service.js, which keeps each reason
// as a key, its points and what it is about; the words are here, so they
// are translated.

export const TIERS = [
  { key: 'solid', label: msg('Solid'), help: msg('Likely to buy, or a big job. Work these first.'), from: 70 },
  { key: 'promising', label: msg('Promising'), help: msg('Good signs. Keep them warm.'), from: 50 },
  { key: 'maybe', label: msg('Maybe'), help: msg('Not much known yet. Find out what they need.'), from: 30 },
  { key: 'long_shot', label: msg('Long shot'), help: msg('Little sign they will buy. Try once more, then let go.'), from: 0 }
];
// Estimates in whole cedis: "about GHS 12,000", not "12,000.00".
export const estimate = (n) => 'GHS ' + Math.round(Number(n) || 0).toLocaleString();
export function tier(key) { return TIERS.find((t) => t.key === key) || TIERS[3]; }

const STAGE_REASON = {
  stage_contacted: msg('Already in touch'),
  stage_follow_up: msg('In talks with us'),
  stage_qualified: msg('Qualified: a real job'),
  stage_quote_sent: msg('Has our quotation'),
  stage_negotiation: msg('Agreeing the price or the date'),
  stage_won: msg('Agreed to buy')
};
const SIZE = {
  value_big: msg('Big job: about {amount}'),
  value_good: msg('Good-sized job: about {amount}'),
  value_fair: msg('Smaller job: about {amount}'),
  value_small: msg('Small job: about {amount}'),
  value_known: msg('Worth about {amount}')
};
function days(n, today, yesterday, many) { return n === 0 ? tr(today) : n === 1 ? tr(yesterday) : tr(many, { n }); }

// One reason in words.
export function reasonText(r) {
  if (SIZE[r.k]) return tr(SIZE[r.k], { amount: estimate(r.amount) });
  if (STAGE_REASON[r.k]) return tr(STAGE_REASON[r.k]);
  switch (r.k) {
    case 'marked_high': return r.by ? tr('Marked important by {name}', { name: r.by }) : tr('Marked important');
    case 'marked_low': return r.by ? tr('Marked low priority by {name}', { name: r.by }) : tr('Marked low priority');
    case 'bought_before': return tr('Has bought from us before');
    case 'vip': return tr('A VIP customer');
    case 'want_clear': return tr('Says what they want');
    case 'want_unclear': return tr('Not clear yet what they want');
    case 'business': return tr('A business: {company}', { company: r.company });
    case 'bulk': return tr('Big or business order: “{what}”', { what: r.what });
    case 'wrote_recently': return days(r.days, msg('Wrote to us today'), msg('Wrote to us yesterday'), msg('Wrote to us {n} days ago'));
    case 'talking': return tr('{n} messages from them lately', { n: r.n });
    case 'waiting': return tr('Waiting for our answer');
    case 'visit_done': return tr('Site visit done');
    case 'visit_booked': return tr('Site visit booked');
    case 'referral': return tr('Sent by someone (a referral)');
    case 'source_strong':
    case 'source_good': return tr('{source} leads often go further: {pct}% against {all}% for all leads', { source: r.source, pct: r.pct, all: r.all });
    case 'source_weak': return tr('{source} leads rarely go further: {pct}% against {all}% for all leads', { source: r.source, pct: r.pct, all: r.all });
    case 'keen': return tr('Sounds keen: {words}', { words: r.words.map((w) => '“' + w + '”').join(', ') });
    case 'cold': return tr('Warning signs: {words}', { words: r.words.map((w) => '“' + w + '”').join(', ') });
    case 'fresh': return days(r.days, msg('Came in today'), msg('Came in yesterday'), msg('Came in {n} days ago'));
    case 'quiet': return tr('Nothing heard for {n} days', { n: r.days });
    case 'no_contact': return tr('No phone or email to reach them');
    default: return r.k;
  }
}
// Where an amount comes from.
export function valueBasis(v) {
  if (!v) return '';
  if (v.basis === 'deal') return tr('the sale linked to this lead');
  if (v.basis === 'quote') return tr('their quotation');
  if (v.qty) return tr('{qty} × {unit}, the price of “{name}”', { qty: v.qty, unit: estimate(v.unit), name: v.name });
  if (v.basis === 'catalogue') return tr('the catalogue price of “{name}”', { name: v.name });
  return v.n > 1 ? tr('what “{name}” sold for, over {n} sales and quotations', { name: v.name, n: v.n }) : tr('what “{name}” sold for', { name: v.name });
}

// What moves a lead up or down, for the ladder: the biggest signs.
const KEY_UP = [[20, msg('Negotiating (prospects)')], [15, msg('A big job, or bought from us before')], [12, msg('Wrote to us lately, or a site visit done')], [8, msg('A referral, a big order, a source that often buys')]];
const KEY_DOWN = [[15, msg('No phone or email')], [14, msg('Nothing heard for months')], [6, msg('Warning words, or not clear what they want')], [5, msg('A source that rarely buys')]];
export function PriorityKey() {
  return (
    <div className="lp-key">
      <p className="lp-key-title">{tr('What moves a lead up or down')}</p>
      <div className="lp-key-cols">
        <ul className="is-plus">{KEY_UP.map(([n, k]) => <li key={k}><span className="lp-pts">+{n}</span>{tr(k)}</li>)}</ul>
        <ul className="is-minus">{KEY_DOWN.map(([n, k]) => <li key={k}><span className="lp-pts">−{n}</span>{tr(k)}</li>)}</ul>
      </div>
    </div>
  );
}

// The ring: the score inside, filled to it, in the tier's colour.
export function PriorityRing({ priority, size = 'md' }) {
  if (!priority) return null;
  const t = tier(priority.tier);
  return (
    <span className={'lp-ring is-' + size + ' is-' + priority.tier} style={{ '--v': priority.score }} role="img"
      aria-label={tr('Priority {score} of 100: {tier}', { score: priority.score, tier: tr(t.label) })} title={tr(t.label) + ' · ' + tr(t.help)}>
      <span className="lp-ring-n">{priority.score}</span>
    </span>
  );
}
export function TierTag({ tierKey }) {
  return <span className={'lp-tag is-' + tierKey}>{tr(tier(tierKey).label)}</span>;
}

// The strongest reasons, short: two for it and the worst against it.
export function ReasonChips({ priority, max = 2 }) {
  if (!priority) return null;
  const marked = priority.reasons.filter((r) => r.k.startsWith('marked_'));
  const plus = priority.reasons.filter((r) => r.p > 0).slice(0, max);
  const minus = priority.reasons.filter((r) => r.p < 0).sort((a, b) => a.p - b.p).slice(0, 1);
  const show = [...marked, ...plus, ...minus];
  if (!show.length) return null;
  return (
    <span className="lp-chips">
      {show.map((r, i) => (
        <span key={r.k + i} className={'lp-chip' + (r.k === 'marked_high' ? ' is-star' : r.k === 'marked_low' || r.p < 0 ? ' is-minus' : ' is-plus')}>
          {r.k === 'marked_high' ? <Icon name="star" /> : <b aria-hidden="true">{r.p < 0 || r.k === 'marked_low' ? '−' : '+'}</b>}{reasonText(r)}
        </span>
      ))}
    </span>
  );
}

// The lead window's box: the score, every reason with its points, and the
// choice to mark it Important or Low priority by hand.
export function PriorityPanel({ lead, canManage, busy, onSet }) {
  const p = lead.priority;
  if (!p) return null;
  const t = tier(p.tier);
  const choice = lead.manualPriority || 'auto';
  return (
    <section className={'crm-box lp-panel is-' + p.tier} aria-labelledby="lp-panel-title">
      <div className="lp-panel-head">
        <PriorityRing priority={p} size="lg" />
        <div className="lp-panel-text">
          <h3 className="dk-h3" id="lp-panel-title">{tr('Priority')} · <span className={'lp-tier-word is-' + p.tier}>{tr(t.label)}</span></h3>
          <p className="dk-muted tl-small">{tr(t.help)} {tr('How likely they are to buy, and how big the job is: it starts at 35 and each sign below adds or takes away points.')}</p>
          {p.value && <p className="tl-small lp-value"><Icon name="cash" /><span><strong>{tr('About {amount}', { amount: estimate(p.value.amount) })}</strong> <span className="dk-muted">{tr('from {basis}', { basis: valueBasis(p.value) })}</span></span></p>}
        </div>
        {canManage && (
          <div className="dk-segment lp-choice" role="radiogroup" aria-label={tr('Priority')}>
            {[['auto', tr('Automatic')], ['high', tr('Important')], ['low', tr('Low priority')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={choice === k} className={choice === k ? 'is-on' : ''} disabled={busy}
                onClick={() => choice !== k && onSet(k === 'auto' ? null : k)}>{k === 'high' && <Icon name="star" />}{label}</button>
            ))}
          </div>
        )}
      </div>
      {lead.manualPriority && (
        <p className="tl-small lp-marked">
          <Icon name={lead.manualPriority === 'high' ? 'star' : 'down'} />
          {lead.manualPriority === 'high' ? tr('Marked important: it stays solid, whatever else happens.') : tr('Marked low priority: it stays a long shot, whatever else happens.')}
          {lead.priorityBy ? ' ' + tr('{name}, {date}.', { name: lead.priorityBy, date: fmtDate(String(lead.priorityAt).slice(0, 10)) }) : ''}
        </p>
      )}
      <ul className="lp-reasons">
        {p.reasons.filter((r) => !r.k.startsWith('marked_')).map((r, i) => (
          <li key={r.k + i} className={r.p < 0 ? 'is-minus' : 'is-plus'}>
            <span className="lp-pts">{r.p > 0 ? '+' + r.p : '−' + Math.abs(r.p)}</span>
            <span>{reasonText(r)}</span>
          </li>
        ))}
        {!p.reasons.some((r) => !r.k.startsWith('marked_')) && <li className="dk-muted">{tr('Nothing known yet that changes it.')}</li>}
      </ul>
    </section>
  );
}

// "How it is worked out", for the page's glossary.
export const PRIORITY_GLOSSARY = [
  [msg('Priority'), msg('A number from 0 to 100 for each open lead: how likely they are to buy, and how big the job is. It starts at 35; the signs for it (they wrote lately, a big job, a site visit, a quotation, words like “deposit”) add points, and the signs against it (no phone, nothing heard for months, “too expensive”) take them away. Open a lead to see its reasons.')],
  [msg('Solid'), msg('70 and up. Likely to buy, or a big job. Work these first.')],
  [msg('Promising'), msg('50 to 69. Good signs. Keep them warm.')],
  [msg('Maybe'), msg('30 to 49. Not much known yet. Find out what they need.')],
  [msg('Long shot'), msg('Below 30. Little sign they will buy. Try once more, then let go.')],
  [msg('Important / Low priority'), msg('Anyone who works the leads can mark one by hand: Important keeps it solid, Low priority keeps it a long shot. Automatic puts it back.')],
  [msg('Size of the job'), msg('Their quotation or the sale linked, else what the thing they want usually sells for (past invoices and quotations, then the catalogue), against a typical sale.')]
];
