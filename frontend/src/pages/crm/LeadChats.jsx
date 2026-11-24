import { Icon } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { ChannelDot, ago, channelLabel } from './crmHubShared';
import './CrmHub.css';
import './LeadChats.css';

// A lead's chats, in its window (crmShared.jsx LeadDialog): the WhatsApp
// chat — and email, Facebook, Instagram — of the person the lead is. The
// OS knows them by their number or email, however it was written
// (backend crmLeadMatch.service.js); a press opens the chat in the inbox.
export default function LeadChats({ conversations, onOpen }) {
  if (!conversations || !conversations.length) return null;
  const wa = conversations.find((c) => c.channel === 'whatsapp');
  return (
    <section className="crm-box lm-chats" aria-labelledby="lm-title">
      <div className="crm-box-head"><h3 className="dk-h3" id="lm-title">{tr('Their chats')}</h3></div>
      {wa && (
        <p className="lm-same">
          <ChannelDot channel="whatsapp" />
          <span>{wa.name && wa.name !== wa.label
            ? tr('The same person as {name} on WhatsApp ({number}).', { name: wa.name, number: wa.label })
            : tr('On WhatsApp with the same number ({number}).', { number: wa.label })}</span>
        </p>
      )}
      <ul className="lm-list">
        {conversations.map((c) => (
          <li key={c.id}>
            <button type="button" className="lm-chat" onClick={() => onOpen(c)}>
              <ChannelDot channel={c.channel} />
              <span className="lm-chat-main">
                <span className="lm-chat-top">
                  <b>{channelLabel(c.channel)}</b>
                  <span className="dk-muted tl-small">{c.lastAt ? ago(c.lastAt) : ''}</span>
                  {c.waiting && <span className="lm-wait">{tr('waiting for an answer')}</span>}
                </span>
                <span className="dk-muted tl-small lm-chat-last">{c.lastDirection === 'out' ? tr('Us') + ': ' : ''}{c.lastPreview || '—'}</span>
              </span>
              <span className="lm-go">{tr('Open the chat')} <Icon name="arrow" /></span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
