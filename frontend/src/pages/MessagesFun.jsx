import Photo from '../components/Photo';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';

// Chats' livelier pieces (MessagesPage.jsx): the list's header card with
// your photo and how much is unread, the "online now" row of faces, and
// the welcome page shown while no chat is open: your week in messages
// (GET /api/messages/highlights), who you talk to most, the busiest chat,
// what was shared, the reactions your messages got and who is around.
// Styles in MessagesFun.css (.chx-*).

const G = {
  chat: <path d="M4.5 18.5 5.6 15A7 7 0 1 1 8.9 17.6z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  group: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.6c1.6.7 2.6 2.2 3 4.4" /></>,
  send: <path d="m4 12 16-7-6 16-2.5-6.5z" />,
  inbox: <><path d="M4 13.5 6.5 5h11l2.5 8.5V19H4z" /><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20" /></>,
  heart: <path d="M12 19.5s-7.5-4.3-7.5-9.6A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.3c0 5.3-7.5 9.6-7.5 9.6z" />,
  flame: <path d="M12 21c-3.9 0-6.3-2.6-6.3-5.9 0-3.4 2.9-5.4 3.4-8.9 2 1.3 3 3 3 5 1-.8 1.6-2 1.7-3.2 2.3 1.8 4.5 4.2 4.5 7.1 0 3.3-2.4 5.9-6.3 5.9z" />,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m20.5 16-5-5L6 19.5" /></>,
  clip: <path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  crown: <path d="M4 17.5 3 7.5l5 4 4-6.5 4 6.5 5-4-1 10z" />
};
export function Glyph({ name, size = 18 }) {
  return <svg className="chx-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{G[name]}</svg>;
}

function greeting(now) {
  const h = now.getHours();
  return h < 12 ? tr('Good morning') : h < 17 ? tr('Good afternoon') : tr('Good evening');
}

// ── the list's header card ──────────────────────────────────────────────
export function ChatHero({ me, myName, myPhoto, unread, unreadChats, onPhoto, onNewGroup, onNewChat }) {
  return (
    <div className="chx-hero">
      <span className="chx-hero-bubbles" aria-hidden="true"><i /><i /><i /></span>
      <button type="button" className="chx-me" onClick={onPhoto} title={tr('Your photo')}>
        <Photo id={me.id} name={myName} photo={myPhoto} size={44} />
      </button>
      <div className="chx-hero-text">
        <h2>{tr('Chats')}</h2>
        <span>{unread ? (unreadChats === 1 ? tr('{n} unread in 1 chat', { n: unread }) : tr('{n} unread in {c} chats', { n: unread, c: unreadChats })) : tr('All caught up')}</span>
      </div>
      <button type="button" className="chx-hero-btn" onClick={onNewGroup} title={tr('New group')} aria-label={tr('New group')}><Glyph name="group" /></button>
      <button type="button" className="chx-hero-btn is-main" onClick={onNewChat} title={tr('New chat')} aria-label={tr('New chat')}><Glyph name="plus" /></button>
    </div>
  );
}

// ── who is online now ──────────────────────────────────────────────────
export function OnlineStrip({ people, onOpen }) {
  if (!people.length) return null;
  return (
    <div className="chx-online" aria-label={tr('Online now')}>
      <span className="chx-online-label"><i />{tr('Online now')} · {people.length}</span>
      <div className="chx-online-row">
        {people.slice(0, 24).map((p) => (
          <button key={p.id} type="button" className="chx-online-person" onClick={() => onOpen(p)} title={p.name + (p.title ? ' · ' + p.title : '')}>
            <span className="chx-online-photo"><Photo id={p.id} name={p.name} photo={p.photo} size={44} /></span>
            <small>{p.name}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── the welcome page (no chat open) ────────────────────────────────────
// h: GET /api/messages/highlights (null while loading or on an older server).
export function Welcome({ firstName, unread, unreadChats, firstUnread, h, onOpenConv, onOpenPeer, onNewChat, onNewGroup }) {
  const now = new Date();
  const week = h ? h.week : [];
  const max = Math.max(1, ...week.map((d) => Math.max(d.sent, d.received)));
  const top = h ? h.topPeople : [];
  const day = (iso, style) => new Date(iso + 'T12:00').toLocaleDateString(activeIntlLocale(), { weekday: style });
  const tiles = [
    { key: 'unread', icon: 'inbox', tone: unread ? 'warn' : 'good', value: unread, label: tr('unread'), note: unread ? (unreadChats === 1 ? tr('in 1 chat') : tr('in {n} chats', { n: unreadChats })) : tr('all caught up'), onClick: firstUnread ? () => onOpenConv(firstUnread) : null },
    { key: 'sent', icon: 'send', tone: 'mint', value: h ? h.sentThisWeek : '—', label: tr('sent this week'), note: tr('messages you wrote') },
    { key: 'got', icon: 'chat', tone: 'sky', value: h ? h.receivedThisWeek : '—', label: tr('received this week'), note: tr('from your colleagues') },
    { key: 'love', icon: 'heart', tone: 'pink', value: h ? h.reactions.count : '—', label: tr('reactions to your messages'), note: h && h.reactions.top.length ? h.reactions.top.map((r) => r.emoji + ' ' + r.count).join('  ') : tr('this week') }
  ];
  return (
    <div className="chx-welcome">
      <section className="chx-wave">
        <span className="chx-wave-art" aria-hidden="true">
          <span className="chx-float is-a"><Glyph name="chat" size={30} /></span>
          <span className="chx-float is-b">👋</span>
          <span className="chx-float is-c"><Glyph name="heart" size={22} /></span>
          <span className="chx-float is-d">🎉</span>
        </span>
        <p className="chx-eyebrow">{now.toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h2>{greeting(now) + (firstName ? ', ' + firstName : '')}</h2>
        <p className="chx-wave-sub">{tr('Pick a chat on the left, or start one. Here is your week in messages.')}</p>
        <div className="chx-wave-actions">
          <button type="button" className="chx-pill is-main" onClick={onNewChat}><Glyph name="plus" size={16} /> {tr('New chat')}</button>
          <button type="button" className="chx-pill" onClick={onNewGroup}><Glyph name="group" size={16} /> {tr('New group')}</button>
          {firstUnread && <button type="button" className="chx-pill" onClick={() => onOpenConv(firstUnread)}><Glyph name="inbox" size={16} /> {tr('Read the newest')}</button>}
        </div>
      </section>

      <div className="chx-tiles">
        {tiles.map((t) => {
          const Tag = t.onClick ? 'button' : 'div';
          return (
            <Tag key={t.key} {...(t.onClick ? { type: 'button', onClick: t.onClick } : {})} className={'chx-tile is-' + t.tone + (t.onClick ? ' is-link' : '')}>
              <span className="chx-tile-icon"><Glyph name={t.icon} size={20} /></span>
              <span className="chx-tile-body"><strong>{t.value}</strong><b>{t.label}</b><small>{t.note}</small></span>
            </Tag>
          );
        })}
      </div>

      {h && (
        <div className="chx-grid">
          <section className="chx-card">
            <h3>{tr('Your week in messages')}</h3>
            <div className="chx-bars" role="img" aria-label={week.map((d) => day(d.date, 'short') + ': ' + tr('{a} sent, {b} received', { a: d.sent, b: d.received })).join('; ')}>
              {week.map((d, i) => (
                <div key={d.date} className={'chx-bar' + (i === week.length - 1 ? ' is-today' : '')} title={day(d.date, 'long') + ': ' + tr('{a} sent, {b} received', { a: d.sent, b: d.received })}>
                  <span className="chx-bar-pair">
                    <i className="is-sent" style={{ height: (d.sent / max) * 100 + '%' }} />
                    <i className="is-got" style={{ height: (d.received / max) * 100 + '%' }} />
                  </span>
                  <small>{day(d.date, 'short')}</small>
                </div>
              ))}
            </div>
            <div className="chx-legend"><span><i className="is-sent" />{tr('Sent')} · {h.sentThisWeek}</span><span><i className="is-got" />{tr('Received')} · {h.receivedThisWeek}</span></div>
          </section>

          <section className="chx-card">
            <h3>{tr('Who you talk to most')}</h3>
            <p className="chx-muted">{tr('One-to-one chats, the last 30 days.')}</p>
            {top.length ? (
              <ol className="chx-top">
                {top.map((p, i) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => onOpenConv(p.conversationId)}>
                      <span className="chx-rank">{i === 0 ? <Glyph name="crown" size={15} /> : i + 1}</span>
                      <span className={'chx-top-photo' + (p.online ? ' is-online' : '')}><Photo id={p.id} name={p.name} photo={p.photo} size={38} /></span>
                      <span className="chx-top-name"><b>{p.name}</b><small>{p.count === 1 ? tr('1 message') : tr('{n} messages', { n: p.count })}</small></span>
                      <span className="chx-top-bar"><i style={{ width: Math.round((p.count / top[0].count) * 100) + '%' }} /></span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : <p className="chx-muted">{tr('Nobody yet: say hello to a colleague!')}</p>}
          </section>

          <section className="chx-card chx-side">
            {h.busiest && (
              <button type="button" className="chx-busy" onClick={() => onOpenConv(h.busiest.conversationId)}>
                <span className="chx-busy-flame"><Glyph name="flame" size={20} /></span>
                <Photo kind={h.busiest.kind === 'group' ? 'group' : 'person'} id={h.busiest.id} name={h.busiest.name} photo={h.busiest.photo} size={42} />
                <span className="chx-busy-text"><small>{tr('Busiest chat this week')}</small><b>{h.busiest.name}</b><em>{h.busiest.count === 1 ? tr('1 message') : tr('{n} messages', { n: h.busiest.count })}</em></span>
              </button>
            )}
            <div className="chx-shared">
              <small>{tr('Shared in your chats this week')}</small>
              <span className="chx-shared-row">
                <span><Glyph name="image" size={16} /><b>{h.shared.photos}</b> {tr('photos')}</span>
                <span><Glyph name="clip" size={16} /><b>{h.shared.files}</b> {tr('files')}</span>
                <span><Glyph name="grid" size={16} /><b>{h.shared.records}</b> {tr('records')}</span>
              </span>
            </div>
            {h.online.count > 0 && (
              <div className="chx-around">
                <small>{h.online.count === 1 ? tr('1 colleague is online now') : tr('{n} colleagues are online now', { n: h.online.count })}</small>
                <span className="chx-around-faces">
                  {h.online.people.slice(0, 10).map((p) => (
                    <button key={p.id} type="button" onClick={() => onOpenPeer(p.id)} title={p.name}><Photo id={p.id} name={p.name} photo={p.photo} size={34} /></button>
                  ))}
                </span>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

// A voice note being recorded: bars that dance.
export function Wave() {
  return <span className="chx-rec-wave" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ animationDelay: (i * 0.07).toFixed(2) + 's' }} />)}</span>;
}
