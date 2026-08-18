import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import './MessagesPage.css';

// Ported from Bamboo OS.dc.html's messages screen (screens.messages block
// + the msgInbox/msgDirectoryOptions/activeThread computed values, and the
// "New message" dialog around its render()).

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return fmtDate(iso) + ' ' + d.toTimeString().slice(0, 5);
}

export default function MessagesPage() {
  const [inbox, setInbox] = useState([]);
  const [directory, setDirectory] = useState([]);
  const [activePeerId, setActivePeerId] = useState(null);
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const threadEndRef = useRef(null);

  const load = useCallback(async (peerId) => {
    setError(null);
    try {
      const requests = [api.get('/messages'), api.get('/messages/directory')];
      if (peerId) requests.push(api.get('/messages/' + peerId));
      const [inboxRows, dirRows, threadData] = await Promise.all(requests);
      setInbox(inboxRows);
      setDirectory(dirRows);
      if (peerId) setThread(threadData);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(activePeerId); }, [load, activePeerId]);

  useEffect(() => {
    if (threadEndRef.current) threadEndRef.current.scrollIntoView({ block: 'end' });
  }, [thread]);

  function openThread(peerId) {
    setDraft('');
    setActivePeerId(peerId);
  }

  function startConversationWith(peerId) {
    setDialogOpen(false);
    setDraft('');
    setActivePeerId(peerId);
  }

  async function handleSend(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      await api.post('/messages/' + activePeerId, { body: body });
      setDraft('');
      await load(activePeerId);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="messages-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>New message</button>
      </div>

      <div className="messages-panes">
        <div className="messages-inbox">
          {inbox.map((c) => (
            <div
              key={c.peerId}
              className={'messages-inbox-item' + (c.peerId === activePeerId ? ' messages-inbox-item-active' : '')}
              onClick={() => openThread(c.peerId)}
            >
              <div className="messages-inbox-row">
                <div className="messages-inbox-name">{c.peerName}</div>
                <div className="messages-inbox-at">{fmtDate(c.lastAt.slice(0, 10))}</div>
              </div>
              <div className="messages-inbox-preview">{c.lastFromMe ? 'You: ' : ''}{c.lastBody.slice(0, 60)}</div>
              {c.unread > 0 && <span className="tag tag-accent messages-unread-badge">{c.unread} new</span>}
            </div>
          ))}
          {!inbox.length && <p className="messages-empty">No conversations yet.</p>}
        </div>

        <div className="messages-thread-pane">
          {thread && activePeerId ? (
            <>
              <div className="messages-thread-header">
                <div className="messages-thread-peer-name">{thread.peerName}</div>
                <div className="messages-thread-peer-title">{thread.peerTitle}</div>
              </div>
              <div className="messages-thread-body">
                {thread.messages.map((m) => (
                  <div key={m.id} className={'messages-bubble' + (m.fromMe ? ' messages-bubble-mine' : '')}>
                    <div className="messages-bubble-text">{m.body}</div>
                    <div className="messages-bubble-at">{fmtDateTime(m.at)}</div>
                  </div>
                ))}
                <div ref={threadEndRef} />
              </div>
              <form className="messages-compose" onSubmit={handleSend}>
                <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a message…" disabled={sending} />
                <button className="btn btn-primary" type="submit" disabled={sending}>Send</button>
              </form>
            </>
          ) : (
            <div className="messages-thread-placeholder">Select a conversation or start a new one.</div>
          )}
        </div>
      </div>

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <div className="dialog messages-new-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>New message</h2>
            <div className="messages-directory">
              {directory.map((p) => (
                <button type="button" key={p.id} className="messages-directory-item" onClick={() => startConversationWith(p.id)}>
                  {p.name}{p.title ? ' — ' + p.title : ''}
                </button>
              ))}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
