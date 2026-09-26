import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { tr, msg, activeIntlLocale } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './IntegrationsPage.css';

// Integrations — the outside systems Bamboo OS connects to, in the same
// "explains itself" layout as the dashboards (components/DashKit.jsx): how
// many accounts are connected, which services set up on the server are
// ready, what stands out (a service everything relies on missing, a
// Connect button that can't work yet because the platform's app keys
// aren't on the server), the accounts connected here as cards by kind, and
// the services on the server with the names of the settings each needs
// (settings.service.js: listIntegrations, services).
//
// Three ways to connect (listIntegrations' `how`):
//   oauth   — a Connect button that signs in to the platform;
//   server  — keys set in the server's settings on Render, nothing typed
//             here (WhatsApp, Google Analytics, Square, TimeStation);
//   planned — listed but not built yet, so no key is asked for: a key
//             pasted here would sit unused.
// No key or secret is ever shown or typed on this page. Everything here
// needs settings.manage, like the nav gate.

const OAUTH_LABEL = { facebook: 'Facebook', instagram: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', twitch: 'Twitch' };
const HOW = {
  oauth: { label: msg('Sign in to connect'), tone: 'info' },
  server: { label: msg('Set up on the server'), tone: 'muted' },
  planned: { label: msg('Not available yet'), tone: 'muted' }
};
const SERVICE_TEXT = {
  ai: msg('The AI Assistant and marketing suggestions.'),
  sms: msg('Text messages: payment reminders, booking notices, sign-in codes.'),
  mail: msg('Sign-in codes by email.'),
  storage: msg('File storage for documents, photos and receipts. Without it, files up to 15 MB are kept in the database.'),
  drive: msg('Importing documents from Google Drive.'),
  timestation: msg('Importing employees and clock-ins from TimeStation.'),
  square: msg('Importing customers, catalogue, invoices and payments from Square.'),
  whatsapp: msg('The WhatsApp channel on the Social & campaign tracker.'),
  ga4: msg('Website visits on the Social & campaign tracker.'),
  meta: msg('The Connect buttons for Facebook and Instagram.'),
  tiktok: msg('The Connect button for TikTok.'),
  youtube: msg('The Connect button for YouTube.'),
  twitch: msg('The Connect button for Twitch.')
};

// The Square import's four stages, in the order the server runs them
// (backend/src/services/squareImport.service.js).
const SQUARE_STAGES = [
  ['customers', 'customers', msg('Customers'), msg('Square customers become customers here, matched by their Square id.')],
  ['catalog', 'catalogItems', msg('Catalogue'), msg('Items and their variations, refreshed from Square each time.')],
  ['invoices', 'invoices', msg('Invoices'), msg('Every Square sale becomes an invoice, a page of 200 at a time.')],
  ['payments', 'payments', msg('Payments'), msg('Payments with receipts, so each invoice shows what is still owed.')]
];

function fmtDateTime(ts) { return ts ? new Date(ts).toLocaleString(activeIntlLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }

function PlugIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 17v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [chip, setChip] = useState('all');
  const [squareJob, setSquareJob] = useState(null);
  const [squareStarting, setSquareStarting] = useState(false);
  const [squareError, setSquareError] = useState(null);
  const squareRunning = !!(squareJob && squareJob.status === 'running');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, sv] = await Promise.all([api.get('/settings/integrations'), api.get('/settings/services')]);
      setIntegrations(list);
      setServices(sv);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  // The Square import runs on the server; the latest one's progress is
  // read on arrival and every few seconds while it runs.
  useEffect(() => {
    let live = true;
    api.get('/square/import').then((j) => { if (live) setSquareJob(j); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!squareRunning) return undefined;
    const t = setTimeout(async () => {
      try {
        setSquareJob(await api.get('/square/import'));
      } catch { /* try again on the next tick */ setSquareJob((j) => ({ ...j })); }
    }, 3000);
    return () => clearTimeout(t);
  }, [squareJob, squareRunning]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function startOAuth(i) {
    setBusyId(i.id);
    setError(null);
    try {
      const path = i.id === 'facebook' || i.id === 'instagram' ? '/marketing/oauth/meta/start' : '/marketing/oauth/' + i.id + '/start';
      const { url } = await api.post(path, {});
      window.location.href = url;
    } catch (err) {
      setError(err.message);
      setBusyId(null);
    }
  }
  async function disconnect(i) {
    setBusyId(i.id);
    setError(null);
    try {
      const updated = await api.post('/settings/integrations/' + i.id + '/disconnect', {});
      setToast(tr('{name} disconnected.', { name: updated.name }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }
  async function runSquareImport() {
    setSquareStarting(true);
    setSquareError(null);
    try {
      setSquareJob(await api.post('/square/import', {}));
      jump('in-square');
    } catch (err) {
      setSquareError(err.message);
    } finally {
      setSquareStarting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const usable = integrations.filter((i) => i.how !== 'planned');
  const connected = integrations.filter((i) => i.connected);
  const ready = services.filter((s) => s.ready);
  const missingEssential = services.filter((s) => s.essential && !s.ready);
  const cantConnect = integrations.filter((i) => i.how === 'oauth' && !i.connected && !i.ready);
  const planned = integrations.filter((i) => i.how === 'planned');
  const lastChange = integrations.filter((i) => i.lastChange).sort((a, b) => new Date(b.lastChange.at) - new Date(a.lastChange.at))[0];
  const aiReady = services.find((s) => s.id === 'ai');

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('in-list'); }
  const stats = [
    { icon: 'check', value: String(connected.length), label: tr('accounts connected'), note: tr('of {n} that can be connected', { n: usable.length }), tone: connected.length ? 'good' : '', onClick: () => showOnly('connected') },
    { icon: 'warn', value: tr('{n} of {total}', { n: ready.length, total: services.length }), label: tr('server services ready'), note: missingEssential.length ? tr('{n} that much depends on still missing', { n: missingEssential.length }) : tr('the essential ones are ready'), tone: missingEssential.length ? 'bad' : 'good', onClick: () => jump('in-services') },
    { icon: 'spark', value: aiReady && aiReady.ready ? tr('On') : tr('Off'), label: tr('AI Assistant'), note: aiReady && aiReady.ready ? tr('Claude answers questions in the OS') : tr('needs the Anthropic key on the server'), tone: aiReady && aiReady.ready ? 'good' : '', onClick: () => jump('in-services') },
    { icon: 'calendar', value: lastChange ? fmtDate(lastChange.lastChange.at) : '—', label: tr('last connect or disconnect'), note: lastChange ? tr('{name} · {who}', { name: lastChange.name, who: lastChange.lastChange.actorName }) : tr('nothing changed yet') }
  ];

  const insights = [];
  missingEssential.forEach((s) => insights.push({ tone: 'bad', icon: 'warn', text: tr('{name} isn\'t set up: {what} Add {vars} in Render → Environment.', { name: s.name, what: tr(SERVICE_TEXT[s.id]), vars: s.env.join(', ') }), action: { label: tr('Show'), run: () => jump('in-services') } }));
  if (cantConnect.length) insights.push({ tone: 'warn', icon: 'warn', text: tr('The Connect button for {names} can\'t work until the platform\'s app keys are on the server.', { names: cantConnect.map((i) => i.name).join(', ') }), action: { label: tr('Show them'), run: () => showOnly('cant') } });
  if (planned.length) insights.push({ tone: 'info', icon: 'info', text: tr('{names} are listed but not built yet, so there is nothing to connect. Ask for them if the company needs them.', { names: planned.map((i) => i.name).join(', ') }), action: null });
  if (squareJob && (squareJob.status === 'failed' || squareJob.status === 'interrupted')) insights.unshift({ tone: 'bad', icon: 'warn', text: squareJob.status === 'failed' ? tr('The last Square import stopped with an error on {date}.', { date: fmtDate(squareJob.finishedAt || squareJob.heartbeatAt) }) : tr('The last Square import was stopped by a server restart. Run it again to finish — nothing is imported twice.'), action: { label: tr('Show'), run: () => jump('in-square') } });
  if (squareRunning) insights.unshift({ tone: 'info', icon: 'info', text: tr('A Square import is running on the server.'), action: { label: tr('Show'), run: () => jump('in-square') } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Everything the company relies on is connected.') });

  const chipTest = { all: () => true, connected: (i) => i.connected, cant: (i) => i.how === 'oauth' && !i.connected && !i.ready, oauth: (i) => i.how === 'oauth', server: (i) => i.how === 'server', planned: (i) => i.how === 'planned' };
  const visible = integrations.filter(chipTest[chip] || chipTest.all);
  const chips = [['all', tr('All'), integrations.length], ['connected', tr('Connected'), connected.length], ['cant', tr('Can\'t connect yet'), cantConnect.length],
    ['oauth', tr('Sign in to connect'), integrations.filter(chipTest.oauth).length], ['server', tr('Set up on the server'), integrations.filter(chipTest.server).length], ['planned', tr('Not available yet'), planned.length]]
    .filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  function stateOf(i) {
    if (i.connected) return { tone: 'good', text: tr('Connected') };
    if (i.how === 'planned') return { tone: 'muted', text: tr('Not available yet') };
    if (i.how === 'oauth' && !i.ready) return { tone: 'warn', text: tr('App keys missing on the server') };
    return { tone: 'muted', text: tr('Not connected') };
  }

  // ── the Square import ─────────────────────────────────────────────
  const square = integrations.find((i) => i.id === 'squareup');
  let squareSection = null;
  if (squareJob || (square && square.connected)) {
    const j = squareJob;
    const at = j ? (j.phase === 'done' ? SQUARE_STAGES.length : Math.max(0, SQUARE_STAGES.findIndex(([k]) => k === j.phase))) : -1;
    const stopped = j && (j.status === 'failed' || j.status === 'interrupted');
    const head = !j ? { tone: 'muted', text: tr('Not run yet') }
      : squareRunning ? { tone: 'info', text: tr('Running') }
      : j.status === 'done' ? { tone: 'good', text: tr('Finished') }
      : j.status === 'interrupted' ? { tone: 'bad', text: tr('Stopped by a restart') }
      : { tone: 'bad', text: tr('Failed') };
    squareSection = (
      <Section id="in-square" title={tr('Square import')} sub={tr('Brings the sales history from Square into Bamboo OS: customers, the catalogue, invoices and payments. It runs on the server, so you can leave this page and come back. Running it again only updates what is already here — nothing is imported twice.')}>
        <div className={'in-sq is-' + (j ? j.status : 'none')} role="status">
          <div className="in-sq-head">
            <Status tone={head.tone}>{head.text}</Status>
            <span className="dk-muted tl-small">
              {!j ? tr('Press Run Square import to bring in the history.')
                : squareRunning ? tr('Started {when} · last update {ago}', { when: fmtDateTime(j.startedAt), ago: fmtDateTime(j.heartbeatAt) })
                : tr('Started {when} · ended {end}', { when: fmtDateTime(j.startedAt), end: fmtDateTime(j.finishedAt || j.heartbeatAt) })}
            </span>
            {square && square.connected && (
              <button type="button" className="btn btn-primary in-sq-run" disabled={squareStarting || squareRunning} onClick={runSquareImport}>
                {squareRunning ? tr('Importing…') : j ? tr('Run it again') : tr('Run Square import')}
              </button>
            )}
          </div>
          {squareError && <p className="in-error">{squareError}</p>}
          {j && (
            <ol className="dk-flow in-sq-stages">
              {SQUARE_STAGES.map(([key, field, label, help], n) => {
                const c = j[field] || { imported: 0, skipped: 0 };
                const state = n < at || j.status === 'done' ? 'done' : n === at ? (stopped ? 'stopped' : 'now') : 'waiting';
                const tone = state === 'done' ? 'is-good' : state === 'now' ? '' : state === 'stopped' ? 'is-bad' : 'is-muted';
                return (
                  <li key={key} className={tone}>
                    <span className="dk-flow-name">{n + 1}. {tr(label)}</span>
                    <span className="dk-flow-n">{c.imported.toLocaleString()}</span>
                    <span className="dk-flow-value">
                      {state === 'done' ? tr('done') : state === 'now' ? (key === 'invoices' ? tr('saving page {n}…', { n: j.pagesDone + 1 }) : tr('saving…')) : state === 'stopped' ? tr('stopped here') : tr('waiting')}
                      {c.skipped > 0 && <> · {tr('{n} skipped', { n: c.skipped })}</>}
                    </span>
                    <span className="dk-flow-help">{tr(help)}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {j && j.status === 'failed' && j.message && <p className="in-sq-msg"><strong>{tr('What stopped it:')}</strong> {j.message}</p>}
          {j && j.status === 'interrupted' && <p className="dk-muted tl-small">{tr('The server restarted while it was running. Run it again to finish — what was already saved is updated, not copied.')}</p>}
          {j && j.errorCount > 0 && (
            <details className="in-sq-errors">
              <summary>{tr('{n} record(s) could not be imported', { n: j.errorCount })}</summary>
              <ul>{j.errors.slice(0, 10).map((e, k) => <li key={k}><code>{e.externalId}</code> {e.message}</li>)}</ul>
              {j.errorCount > 10 && <p className="dk-muted tl-small">{tr('The first 10 are shown; the rest are in the audit trail and server logs.')}</p>}
            </details>
          )}
        </div>
      </Section>
    );
  }

  return (
    <div className="dk tl in">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Governance')}
        title={tr('Integrations')}
        sub={tr('The outside systems Bamboo OS works with: accounts connected here, and services set up in the server\'s settings. No key or password is ever shown or typed on this page.')}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="in-list" title={tr('Accounts')} sub={tr('Social media, payments and time clocks. Press Connect to sign in to the platform.')}>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? <div className="dk-empty tl-empty"><p>{integrations.length ? tr('Nothing matches. Try another filter.') : tr('No integrations configured')}</p></div> : (
          <div className="tl-grid">
            {visible.map((i) => {
              const st = stateOf(i);
              return (
                <article key={i.id} className={'tl-card in-card is-' + i.how + (i.connected ? ' is-on' : '')}>
                  <div className="in-head">
                    <span className="in-badge"><PlugIcon /></span>
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{tr(i.category)} · {tr(HOW[i.how].label)}</span>
                      <span className="tl-name">{i.name}</span>
                    </span>
                  </div>
                  <p className="dk-muted tl-small in-desc">{tr(i.description)}</p>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status></div>
                  {i.lastChange && <p className="dk-muted tl-small in-last">{i.lastChange.action === 'integration.connect' ? tr('Connected {date} by {name}', { date: fmtDate(i.lastChange.at), name: i.lastChange.actorName }) : tr('Disconnected {date} by {name}', { date: fmtDate(i.lastChange.at), name: i.lastChange.actorName })}</p>}
                  <div className="in-actions">
                    {i.how === 'oauth' && (i.connected
                      ? <button type="button" className="btn btn-secondary" disabled={busyId === i.id} onClick={() => disconnect(i)}>{tr('Disconnect')}</button>
                      : <button type="button" className="btn btn-primary" disabled={busyId === i.id || !i.ready} title={!i.ready ? tr('App keys missing on the server') : undefined} onClick={() => startOAuth(i)}>{busyId === i.id ? tr('Redirecting…') : tr('Connect with {platform}', { platform: OAUTH_LABEL[i.id] || i.name })}</button>)}
                    {i.how === 'server' && !i.connected && <span className="dk-muted tl-small">{tr('Set up in the server\'s settings — see below.')}</span>}
                    {i.how === 'server' && i.connected && i.id !== 'squareup' && <span className="dk-muted tl-small">{tr('Configured on the server — live and syncing automatically.')}</span>}
                    {i.id === 'squareup' && i.connected && <button type="button" className="btn btn-primary" disabled={squareStarting || squareRunning} onClick={runSquareImport}>{squareRunning ? tr('Importing…') : tr('Run Square import')}</button>}
                    {i.id === 'squareup' && squareJob && <button type="button" className="btn btn-secondary" onClick={() => jump('in-square')}>{tr('See the import')}</button>}
                    {i.id === 'timestation' && i.connected && <Link className="btn btn-secondary" to="/attendance">{tr('Open Attendance')}</Link>}
                    {i.how === 'planned' && i.connected && <button type="button" className="btn btn-secondary" disabled={busyId === i.id} onClick={() => disconnect(i)}>{tr('Remove the saved key')}</button>}
                  </div>
                  {i.id === 'instagram' && !i.connected && i.ready && <p className="dk-muted tl-small">{tr('Connects via your Facebook Page login — you\'ll pick the Page, and its linked Instagram account (if any) connects automatically.')}</p>}
                  {i.id === 'squareup' && squareError && <p className="in-error">{squareError}</p>}
                </article>
              );
            })}
          </div>
        )}
      </Section>

      {squareSection}

      <Section id="in-services" title={tr('Services set up on the server')} sub={tr('These are switched on by adding settings in Render → bamboo-os-backend → Environment, then redeploying. Only whether each is ready is shown here, never the values.')}>
        <ul className="in-services">
          {services.map((s) => (
            <li key={s.id} className={s.ready ? 'is-ready' : s.essential ? 'is-missing' : ''}>
              <div className="in-sv-main">
                <strong>{s.name}</strong>
                <span className="dk-muted tl-small">{tr(SERVICE_TEXT[s.id])}</span>
                {!s.ready && <span className="in-env">{s.env.map((v) => <code key={v}>{v}</code>)}</span>}
              </div>
              <Status tone={s.ready ? 'good' : s.essential ? 'bad' : 'muted'}>{s.ready ? tr('Ready') : tr('Not set up')}</Status>
            </li>
          ))}
        </ul>
      </Section>

      <Glossary items={[
        [tr('Sign in to connect'), tr('Press Connect, sign in to the platform and allow Bamboo OS. Nothing is typed here; the platform hands the OS its own access.')],
        [tr('Set up on the server'), tr('Keys added in Render → Environment by whoever looks after the server. They never pass through this page or chat.')],
        [tr('App keys'), tr('The keys that identify Bamboo OS to a platform. Without them, that platform\'s Connect button can\'t work.')],
        [tr('Not available yet'), tr('Listed so it can be asked for, but nothing in the OS uses it yet.')],
        [tr('Disconnect'), tr('Stops the OS using that account straight away and forgets its access. Connecting again means signing in again.')]
      ]} />

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
