import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import ContactButtons from '../../components/ContactButtons';
import { Empty, Glossary, Hero, Icon, Section, fmtDate } from '../../components/DashKit';
import { activeLocale, tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { CategoryTag, ChannelDot, CustMark, channelLabel, downloadCsv, useReps } from './crmHubShared';
import { Toast, todayISO } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';
import './CrmHub.css';

// Marketing from the CRM (backend/src/services/crmMarketing.service.js):
//  - what customers ask about, on every channel: which products (and if
//    that is rising), what they want to know, where they write from;
//  - posts to make from that, each with why (the numbers), a format, a
//    platform, an opening line and what to show — from the OS's rules, or
//    written by the AI Assistant when it is set up (it sees counts only);
//  - who to tell about a product: everyone who asked about it, was quoted
//    it and didn't buy, bought it, has a lead for it, or buys the same kind
//    of thing, each with the reason; then a message to send and the list on
//    each rep's follow-ups.

const PERIODS = [30, 90, 180];
const QUESTION = {
  price: () => tr('Prices'), delivery: () => tr('Delivery and location'), custom: () => tr('Custom sizes and designs'), stock: () => tr('Availability'),
  payment: () => tr('Paying'), bulk: () => tr('Bulk orders'), quality: () => tr('Quality and care')
};
function platformLabel(k) {
  switch (k) { case 'facebook': return tr('Facebook'); case 'whatsapp': return tr('WhatsApp Status'); case 'email': return tr('Email newsletter'); default: return tr('Instagram'); }
}

// A rule idea in the reader's language, from its numbers.
function ideaText(idea) {
  const v = idea.vars || {};
  const asked = tr('{n} customers asked about {product} in the last {days} days', { n: v.customers, product: v.product, days: v.days }) + (v.trend > 0 ? ' ' + tr('({pct}% more than before)', { pct: v.trend }) : '');
  switch (idea.kind) {
    case 'price': return { title: tr('{product}: prices and sizes', v), format: tr('Carousel post and Status'), platform: platformLabel(v.platform), why: asked + '; ' + tr('{n} of the messages asked the price.', { n: v.asks }), hook: tr('How much is {product}? Here is the full price list.', v), points: [tr('Every size with its price'), tr('What is included and how long it lasts'), tr('How to order: WhatsApp number and payment')] };
    case 'inUse': return { title: tr('{product} in real homes and businesses', v), format: tr('Short video (Reel) or customer photos'), platform: platformLabel(v.platform), why: asked + ', ' + tr('but few went on to buy — show it in use to win them over.'), hook: tr('See {product} after a year of use.', v), points: [tr('A customer showing it in their space'), tr('Close-ups of the finish'), tr('A short testimonial')] };
    case 'trending': return { title: tr('Trending now: {product}', v), format: tr('Story / Status'), platform: platformLabel(v.platform), why: asked + '.', hook: tr('Everyone is asking about {product} — here is why.', v), points: [tr('What it is for'), tr('Price from'), tr('Order today')] };
    case 'why': return { title: tr('Why choose {product}', v), format: tr('Post'), platform: platformLabel(v.platform), why: asked + '.', hook: tr('{product}, made from Ghanaian bamboo.', v), points: [tr('What makes it different'), tr('Who it is for'), tr('How to order')] };
    case 'showcase': return { title: tr('Customer showcase: {product}', v), format: tr('Photo post'), platform: tr('Instagram and Facebook'), why: tr('{n} customers bought {product} in the last {days} days — your best seller.', { n: v.buyers, product: v.product, days: v.days }), hook: tr('From our workshop to your space.'), points: [tr('Installed photos (with the customer\'s permission)'), tr('A thank-you'), tr('Order link')] };
    case 'delivery': return { title: tr('How ordering and delivery work'), format: tr('Short video, pinned post and WhatsApp Status'), platform: tr('All channels'), why: tr('{n} customers asked about delivery or where you are.', { n: v.customers }), hook: tr('Ordering from Bamboo Products in 3 steps.'), points: [tr('Where the workshop and showroom are'), tr('Delivery areas and how long it takes'), tr('How to pay')] };
    case 'custom': return { title: tr('Made to your size: behind the scenes'), format: tr('Reel'), platform: tr('Instagram and TikTok'), why: tr('{n} customers asked about custom sizes or designs.', { n: v.customers }), hook: tr('Your idea, our bamboo.'), points: [tr('Measuring'), tr('Building in the workshop'), tr('The finished piece')] };
    case 'payment': return { title: tr('Ways to pay'), format: tr('Story highlight and Status'), platform: tr('Instagram and WhatsApp Status'), why: tr('{n} customers asked how to pay.', { n: v.customers }), hook: tr('Pay by MoMo, bank or cash.'), points: [tr('MoMo number'), tr('Bank details'), tr('Deposit and balance terms')] };
    case 'quality': return { title: tr('How long bamboo lasts (and how we treat it)'), format: tr('Carousel'), platform: tr('Instagram and Facebook'), why: tr('{n} customers asked about durability or treatment.', { n: v.customers }), hook: tr('Does bamboo last? Yes — here is how.'), points: [tr('Treatment against termites and water'), tr('Care tips'), tr('Warranty')] };
    default: return idea;
  }
}
function whyLine(w) {
  switch (w.type) {
    case 'asked': return tr('Asked about it on {channel} on {date}: “{text}”', { channel: channelLabel(w.channel), date: fmtDate(w.on), text: w.excerpt });
    case 'quoted': return tr('Was quoted {item} ({ref}, {date}) and didn\'t buy', { item: w.item, ref: w.ref, date: fmtDate(w.on) });
    case 'bought': return tr('Bought {item} ({ref}, {date})', { item: w.item, ref: w.ref, date: fmtDate(w.on) });
    case 'lead': return tr('Lead {ref} is for {item}', { ref: w.ref, item: w.item });
    case 'kind': return tr('Buys other {category} ({item})', { category: w.category, item: w.item });
    default: return '';
  }
}
function draftMessage(what) {
  return tr('Hello {name}, this is {rep} from Bamboo Products. You asked us about bamboo products before, so we wanted you to be among the first to know: {what} is now available. Would you like the prices and photos? Reply here and we will send them.', { name: '{name}', rep: '{rep}', what });
}

export default function CrmMarketingPage() {
  const { can, session } = useAuth();
  const canManage = can('crm.manage');
  const [days, setDays] = useState(30);
  const [ideas, setIdeas] = useState(null);
  const [ai, setAi] = useState(false);
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState('');
  const [text, setText] = useState('');
  const [aud, setAud] = useState(null);
  const [finding, setFinding] = useState(false);
  const [chosen, setChosen] = useState(() => new Set());
  const [message, setMessage] = useState('');
  const [on, setOn] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState(null);
  const [toast, setToast] = useState(null);
  const { reps } = useReps();
  const canCrm = can('crm.read');

  const loadIdeas = useCallback(async (withAi) => {
    setLoadingIdeas(true);
    try { setIdeas(await api.get('/crm/marketing/ideas?days=' + days + (withAi ? '&ai=1&lang=' + activeLocale() : ''))); setError(null); } catch (err) { setError(err.message); } finally { setLoadingIdeas(false); }
  }, [days]);
  useEffect(() => { loadIdeas(ai); }, [loadIdeas, ai]);
  useEffect(() => { api.get('/crm/marketing/products').then(setProducts).catch(() => {}); }, []);

  async function find(e) {
    if (e) e.preventDefault();
    setFinding(true); setError(null);
    try {
      const qs = new URLSearchParams();
      if (productId) qs.set('productId', productId);
      if (text.trim()) qs.set('text', text.trim());
      const out = await api.get('/crm/marketing/audience?' + qs.toString());
      setAud(out);
      setChosen(new Set(out.people.filter((p) => p.score >= 40).map((p) => p.id)));
      const what = out.product ? out.product.name : text.split(',')[0].trim();
      setMessage(draftMessage(what));
    } catch (err) { setError(err.message); } finally { setFinding(false); }
  }
  function findFor(product) {
    const p = products.find((x) => x.name === product);
    if (p) { setProductId(p.id); setText(''); } else { setProductId(''); setText(product); }
    setTimeout(() => document.getElementById('who')?.scrollIntoView({ behavior: 'smooth' }), 30);
  }
  useEffect(() => { if (productId || text) setAud(null); }, [productId, text]);

  const t = ideas ? ideas.topics : null;
  const maxAsk = t && t.products.length ? Math.max(...t.products.map((p) => p.customers || 0), 1) : 1;
  const what = aud ? (aud.product ? aud.product.name : text.split(',')[0].trim()) : '';
  const picked = useMemo(() => (aud ? aud.people.filter((p) => chosen.has(p.id)) : []), [aud, chosen]);
  const myName = session && session.employee ? session.employee.firstName : '';

  async function handToReps() {
    setBusy(true); setError(null);
    try {
      const out = await api.post('/crm/marketing/hand-to-reps', { customerIds: [...chosen], what, message: message.slice(0, 300), on });
      setToast(tr('{n} customers are on their reps\' follow-ups from {date}.', { n: out.customers, date: fmtDate(on) }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  function copyMessage() {
    const m = message.replace(/\{rep\}/g, myName);
    if (navigator.clipboard) navigator.clipboard.writeText(m).then(() => setToast(tr('Message copied. Put each customer\'s name in place of {name}.', { name: '{name}' })), () => {});
  }
  function csv() {
    downloadCsv('customers-' + (what || 'list').replace(/[^\w-]+/g, '-').toLowerCase() + '.csv', [
      [tr('Name'), tr('Phone'), tr('Email'), tr('Best way'), tr('Sales rep'), tr('Match'), tr('Why')],
      ...picked.map((p) => [p.name, p.phone, p.email, channelLabel(p.via), p.rep ? p.rep.name : '', p.score, (p.why || []).map(whyLine).join(' | ')])
    ]);
  }

  return (
    <div className="dk crm hub">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Hero eyebrow={tr('Sales & CRM')} title={tr('Marketing from the CRM')}
        sub={tr('The OS reads what customers ask on every channel, what they were quoted and what they bought — then suggests what content to make, and who to tell when you launch or push a product.')}
        actions={<>
          <div className="dk-segment" role="radiogroup" aria-label={tr('Period')}>
            {PERIODS.map((d) => <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? 'is-on' : ''} onClick={() => setDays(d)}>{tr('{n} days', { n: d })}</button>)}
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => document.getElementById('who')?.scrollIntoView({ behavior: 'smooth' })}><Icon name="people" /> {tr('Who to tell')}</button>
        </>}
        stats={t ? [
          { icon: 'send', value: String(t.messages), label: tr('customer messages read'), note: tr('in the last {n} days', { n: t.days }) },
          { icon: 'bag', value: String(t.products.length), label: tr('products asked about'), note: t.products[0] ? tr('most: {name}', { name: t.products[0].name }) : tr('none yet') },
          { icon: 'info', value: String(t.questions.length ? t.questions[0].customers : 0), label: t.questions.length ? tr('asked about {what}', { what: (QUESTION[t.questions[0].key] || (() => t.questions[0].label))().toLowerCase() }) : tr('questions'), note: tr('the top question') },
          { icon: 'spark', value: String(ideas.ideas.length), label: tr('content ideas'), note: ideas.source === 'ai' ? tr('written by the AI Assistant') : tr('from the numbers') }
        ] : [{ icon: 'clock', value: '…', label: tr('Loading…') }]} />

      <Section id="ideas" title={tr('Content to make')} sub={tr('Each idea comes from what customers asked. The numbers say why.')}
        action={ideas && ideas.aiAvailable && (
          <label className="hub-check hub-ai"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> <Icon name="spark" /> {tr('Let the AI Assistant write them')}</label>
        )}>
        {loadingIdeas && <p className="eyebrow">{ai ? tr('The AI Assistant is writing…') : tr('Loading…')}</p>}
        {ideas && ideas.ideas.length ? (
          <div className="hub-ideas">
            {ideas.ideas.map((raw, i) => {
              const idea = raw.kind ? ideaText(raw) : raw;
              return (
                <article key={i} className="hub-idea">
                  <header>
                    <span className="hub-idea-n">{i + 1}</span>
                    <div><h4>{idea.title}</h4><p className="dk-muted tl-small">{idea.format} · {idea.platform}</p></div>
                  </header>
                  <p className="hub-idea-why"><Icon name="info" /> {idea.why}</p>
                  {idea.hook && <p className="hub-idea-hook">“{idea.hook}”</p>}
                  {idea.points && idea.points.length > 0 && <ul className="hub-idea-points">{idea.points.map((p, j) => <li key={j}>{p}</li>)}</ul>}
                  {raw.product && canCrm && <button type="button" className="dk-link" onClick={() => findFor(raw.product)}>{tr('Who to tell about {product}', { product: raw.product })} <Icon name="arrow" /></button>}
                </article>
              );
            })}
          </div>
        ) : ideas && <Empty icon="spark">{tr('Not enough customer messages yet. As WhatsApp, email and social messages come in, ideas will appear here.')}</Empty>}
        {ideas && ideas.source === 'ai' && <p className="dk-muted tl-small">{tr('Written by the AI Assistant from the counts only — no names, numbers or messages were sent to it.')}</p>}
      </Section>

      {t && (
        <Section id="asks" title={tr('What customers ask about')} sub={tr('From every incoming message in the last {n} days, compared with the {n} days before.', { n: t.days })}>
          <div className="hub-asks">
            <div className="crm-box">
              <h3 className="dk-h3">{tr('Products')}</h3>
              {t.products.length ? (
                <ul className="hub-bars">
                  {t.products.slice(0, 12).map((p) => (
                    <li key={p.name}>
                      <button type="button" className="hub-bar-row" onClick={() => findFor(p.name)} title={tr('Who to tell about {product}', { product: p.name })}>
                        <span className="hub-bar-name">{p.name}</span>
                        <span className="hub-bar"><span style={{ width: Math.max(4, Math.round((p.customers / maxAsk) * 100)) + '%' }} /></span>
                        <span className="hub-bar-n">{tr('{n} asked', { n: p.customers })}</span>
                        <span className={'hub-bar-trend' + (p.trend > 0 ? ' is-up' : p.trend < 0 ? ' is-down' : '')}>{p.trend === null ? tr('new') : p.trend > 0 ? '+' + p.trend + '%' : p.trend < 0 ? '−' + Math.abs(p.trend) + '%' : '—'}</span>
                        <span className="dk-muted tl-small hub-bar-sold">{tr('{q} quoted · {s} sold', { q: p.quoted, s: p.sold })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="dk-muted tl-small">{tr('No product names in the messages yet.')}</p>}
            </div>
            <div className="crm-box">
              <h3 className="dk-h3">{tr('What they want to know')}</h3>
              {t.questions.length ? (
                <ul className="hub-questions">
                  {t.questions.map((q) => (
                    <li key={q.key}>
                      <div className="hub-q-head"><strong>{(QUESTION[q.key] || (() => q.label))()}</strong><span className="dk-muted tl-small">{tr('{n} customers · {m} messages', { n: q.customers, m: q.count })}</span></div>
                      {q.examples.slice(0, 2).map((x, i) => <p key={i} className="hub-q-ex">“{x}”</p>)}
                    </li>
                  ))}
                </ul>
              ) : <p className="dk-muted tl-small">{tr('No questions found yet.')}</p>}
              {Object.keys(t.channels).length > 0 && (
                <>
                  <h4 className="hub-subhead">{tr('Where they write from')}</h4>
                  <div className="crm-chips">{Object.entries(t.channels).sort((a, b) => b[1] - a[1]).map(([k, n]) => <span key={k} className="hub-interest"><ChannelDot channel={k} /> {channelLabel(k)} <small>{n}</small></span>)}</div>
                </>
              )}
            </div>
          </div>
        </Section>
      )}

      {canCrm && (
        <Section id="who" title={tr('Who to tell')} sub={tr('Making content on a product, or launching one? Choose it and the OS lists the customers most likely to want it, with why. Customers who said no to marketing are never on it.')}>
          <form className="crm-filters hub-who-form" onSubmit={find}>
            <select className="input" value={productId} onChange={(e) => setProductId(e.target.value)} aria-label={tr('Product')}>
              <option value="">{tr('Choose a product…')}</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.category ? ' · ' + p.category : ''}</option>)}
            </select>
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('or type it, e.g. bamboo straws, straw cups')} aria-label={tr('Or type what it is')} />
            <button type="submit" className="btn btn-primary" disabled={finding || (!productId && text.trim().length < 3)}>{finding ? tr('Looking…') : tr('Find customers')}</button>
          </form>
          {aud && (
            <>
              <div className="crm-note"><Icon name="people" /><span>
                {tr('{n} customers to tell about {what}.', { n: aud.people.length, what })}
                {aud.left.optedOut > 0 && ' ' + tr('{n} left out because they said no to marketing.', { n: aud.left.optedOut })}
                {aud.left.unreachable > 0 && ' ' + tr('{n} left out with no number or address.', { n: aud.left.unreachable })}
              </span></div>
              {aud.people.length ? (
                <>
                  <div className="ppl-chips">
                    <button type="button" className="ppl-chip" onClick={() => setChosen(new Set(aud.people.map((p) => p.id)))}>{tr('Choose all')}</button>
                    <button type="button" className="ppl-chip" onClick={() => setChosen(new Set(aud.people.filter((p) => p.score >= 40).map((p) => p.id)))}>{tr('Best matches only')}</button>
                    <button type="button" className="ppl-chip" onClick={() => setChosen(new Set())}>{tr('None')}</button>
                    <span className="dk-muted tl-small">{tr('{n} chosen', { n: chosen.size })}</span>
                  </div>
                  <ul className="hub-aud">
                    {aud.people.map((p) => (
                      <li key={p.id} className={chosen.has(p.id) ? 'is-on' : ''}>
                        <label className="hub-pick"><input type="checkbox" checked={chosen.has(p.id)} onChange={() => { const n = new Set(chosen); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); setChosen(n); }} /><span className="sr-only">{tr('Choose {name}', { name: p.name })}</span></label>
                        <span className={'hub-match' + (p.score >= 70 ? ' is-high' : p.score >= 40 ? ' is-mid' : '')} title={tr('How good a match')}>{p.score}</span>
                        <div className="hub-aud-main">
                          <div className="hub-aud-top">
                            <button type="button" className="crm-textbtn" onClick={() => setProfile(p.id)}><CustMark name={p.name} size={28} /> {p.name}</button>
                            <CategoryTag value={p.category} />
                            <span className="dk-muted tl-small">{p.rep ? tr('Rep: {name}', { name: p.rep.name }) : tr('No rep yet')}</span>
                          </div>
                          <ul className="hub-aud-why">{(p.why || []).map((w, i) => <li key={i}>{whyLine(w)}</li>)}</ul>
                        </div>
                        <div className="hub-aud-via"><span className="dk-muted tl-small">{tr('Best way:')}</span> <ChannelDot channel={p.via} withLabel /><ContactButtons name={p.name} phone={p.phone} email={p.email} /></div>
                      </li>
                    ))}
                  </ul>
                  <div className="crm-box hub-send">
                    <h3 className="dk-h3">{tr('The message')}</h3>
                    <p className="dk-muted tl-small">{tr('{name} becomes each customer\'s name and {rep} their rep\'s. Edit it as you like.', { name: '{name}', rep: '{rep}' })}</p>
                    <textarea className="input" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} aria-label={tr('The message')} />
                    <div className="crm-inline">
                      {canManage && <>
                        <label className="tl-small" htmlFor="hub-on">{tr('Follow up from')}</label>
                        <input id="hub-on" type="date" className="input crm-date" value={on} min={todayISO()} onChange={(e) => setOn(e.target.value)} />
                        <button type="button" className="btn btn-primary" disabled={busy || !chosen.size} onClick={handToReps}><Icon name="people" /> {tr('Put on each rep\'s follow-ups ({n})', { n: chosen.size })}</button>
                      </>}
                      <button type="button" className="btn btn-secondary" onClick={copyMessage}>{tr('Copy the message')}</button>
                      <button type="button" className="btn btn-secondary" disabled={!chosen.size} onClick={csv}><Icon name="doc" /> {tr('Download the list')}</button>
                    </div>
                    <p className="dk-muted tl-small">{tr('Each rep sees their customers on their follow-ups with the message, and contacts them one by one — personal messages, not a mass send.')}</p>
                  </div>
                </>
              ) : <Empty icon="people">{tr('Nobody has asked about, been quoted or bought this yet. Try other words, e.g. the plural or another name for it.')}</Empty>}
            </>
          )}
        </Section>
      )}

      <Glossary items={[
        [tr('Match'), tr('How likely the customer wants it, out of 100: asked about it recently scores most, then quoted but didn\'t buy, has a lead for it, bought it before, buys the same kind of thing.')],
        [tr('Trend'), tr('Customers asking now compared with the period before. “new” means nobody asked before.')],
        [tr('Best way'), tr('The channel the customer writes on, else their phone (WhatsApp), else their email.')]
      ]} />

      {profile && <CustomerProfile id={profile} reps={reps} onClose={() => setProfile(null)} onChanged={() => {}} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
