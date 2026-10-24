import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { SignatureView } from '../components/SignaturePad';
import ContractText from '../components/ContractText';
import './ContractPage.css';
import './ContractsPage.css';

// Contracts (Quotations & Invoicing → Contracts, and the sales app;
// backend contracts.service.js): a contract from a template, its
// {placeholders} filled from the customer and their quotation, edited while
// a draft, then sent as a link to sign on Bamboo Products' customer
// website. Staff see who looked at it, who signed and when, with the
// signature; a contract is voided with a reason. The templates are kept
// here too.

const STATUS = {
  draft: ['📝', () => tr('Draft')], sent: ['📨', () => tr('Sent')], signed: ['✅', () => tr('Signed')], declined: ['✋', () => tr('Declined')], void: ['🗂️', () => tr('Void')]
};
const FILTERS = ['', 'draft', 'sent', 'signed', 'declined', 'void'];
const PLACEHOLDER_WORDS = {
  customer: () => tr('the customer\'s name'), address: () => tr('their address'), phone: () => tr('their phone'), email: () => tr('their email'), date: () => tr('today\'s date'),
  amount: () => tr('the quotation\'s total'), quote_no: () => tr('the quotation\'s number'), company: () => tr('Bamboo Products Limited'), rep: () => tr('your name')
};
function when(d) { return d ? new Date(d).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
function shareText(k) { return tr('Hello {name}, here is your contract with Bamboo Products, {title} ({no}), to read and sign: {url}', { name: k.customer.name.split(' ')[0], title: k.title, no: k.contractNo, url: k.url }); }

function Placeholders({ list }) {
  return (
    <p className="ktr-ph">{tr('Filled in for you:')} {list.map((p) => <span key={p} title={PLACEHOLDER_WORDS[p] ? PLACEHOLDER_WORDS[p]() : ''}><code>{'{' + p + '}'}</code> {PLACEHOLDER_WORDS[p] ? PLACEHOLDER_WORDS[p]() : ''}</span>)}</p>
  );
}

function TemplatesDialog({ onClose, onToast }) {
  const [d, setD] = useState(null);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = () => api.get('/contract-templates').then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post('/contract-templates', edit); setEdit(null); onToast(tr('Template saved.')); load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function remove(t) {
    if (!window.confirm(tr('Delete the template "{name}"? Contracts made from it stay as they are.', { name: t.name }))) return;
    try { await api.del('/contract-templates/' + t.id); load(); } catch (e) { onToast(e.message); }
  }
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog ktr-dlg is-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ktr-tpl-title">
        <h2 id="ktr-tpl-title">📚 {tr('Contract templates')}</h2>
        {!d ? <p className="muted">{error || tr('Loading…')}</p> : edit ? (
          <form className="ktr-form" onSubmit={save}>
            <label className="ktr-field">{tr('Name')}<input className="input" required maxLength={120} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="ktr-field">{tr('The words')}<textarea className="input ktr-body" rows={16} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
            <p className="muted ktr-help">{tr('A line starting "# " is the title, "## " a heading, "- " a point. A blank line between paragraphs.')}</p>
            <Placeholders list={d.placeholders} />
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEdit(null)} disabled={busy}>{tr('Back')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : tr('Save the template')}</button>
            </div>
          </form>
        ) : (
          <>
            {!d.templates.length ? <p className="muted">{tr('No templates yet. Start from our sample and make it yours.')}</p> : (
              <ul className="ktr-tpls">
                {d.templates.map((t) => (
                  <li key={t.id}><span aria-hidden="true">📄</span><strong>{t.name}</strong><small>{tr('Changed {when}', { when: when(t.updatedAt) })}</small>
                    <button type="button" className="btn btn-secondary" onClick={() => setEdit({ id: t.id, name: t.name, body: t.body })}>{tr('Edit')}</button>
                    <button type="button" className="ktr-x" onClick={() => remove(t)} aria-label={tr('Delete')}>✕</button></li>
                ))}
              </ul>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEdit({ name: d.sample.name, body: d.sample.body })}>✨ {tr('Start from the sample')}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setEdit({ name: '', body: '' })}>＋ {tr('Blank template')}</button>
              <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button>
            </div>
          </>
        )}
      </div>
    </div>, document.body
  );
}

function NewContractDialog({ onClose, onMade }) {
  const [opts, setOpts] = useState(null);
  const [f, setF] = useState({ customerId: '', quotationId: '', templateId: '', title: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    Promise.all([api.get('/customers'), api.get('/quotations').catch(() => []), api.get('/contract-templates')])
      .then(([customers, quotations, t]) => { setOpts({ customers, quotations, templates: t.templates, sample: t.sample }); if (t.templates[0]) setF((x) => ({ ...x, templateId: t.templates[0].id })); })
      .catch((e) => setError(e.message));
  }, []);
  const theirs = opts ? opts.quotations.filter((q) => q.customerId === f.customerId) : [];
  async function make(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = f.templateId ? undefined : opts.sample.body;
      onMade(await api.post('/contracts', { customerId: f.customerId, quotationId: f.quotationId || null, templateId: f.templateId || null, title: f.title || (f.templateId ? '' : opts.sample.name), body }));
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog ktr-dlg" onClick={(e) => e.stopPropagation()} onSubmit={make} role="dialog" aria-modal="true" aria-labelledby="ktr-new-title">
        <h2 id="ktr-new-title">📜 {tr('New contract')}</h2>
        {!opts ? <p className="muted">{error || tr('Loading…')}</p> : (
          <>
            <label className="ktr-field">{tr('Customer')}
              <select className="input" required value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value, quotationId: '' })}>
                <option value="">{tr('Choose…')}</option>
                {opts.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <label className="ktr-field">{tr('Their quotation (optional)')}
              <select className="input" value={f.quotationId} onChange={(e) => setF({ ...f, quotationId: e.target.value })} disabled={!theirs.length}>
                <option value="">{theirs.length ? tr('None') : tr('No quotations for this customer')}</option>
                {theirs.map((q) => <option key={q.id} value={q.id}>{q.quoteNo}{q.title ? ' · ' + q.title : ''}</option>)}
              </select></label>
            <label className="ktr-field">{tr('Template')}
              <select className="input" value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
                <option value="">{tr('Our sample: {name}', { name: opts.sample.name })}</option>
                {opts.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select></label>
            <label className="ktr-field">{tr('Title (optional)')}<input className="input" maxLength={160} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={tr('The template\'s name')} /></label>
            <p className="muted ktr-help">{tr('The customer\'s name, address, the quotation\'s number and total are filled in. You can change the words before sending.')}</p>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !f.customerId}>{busy ? tr('Saving…') : tr('Make the draft')}</button>
            </div>
          </>
        )}
      </form>
    </div>, document.body
  );
}

function ContractDialog({ id, canManage, onClose, onChanged, onToast }) {
  const [k, setK] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/contracts/' + id).then(setK).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function act(fn, done) {
    setBusy(true);
    try { const r = await fn(); setK(r); onChanged(); if (done) onToast(done(r)); } catch (e) { onToast(e.message); } finally { setBusy(false); }
  }
  const send = () => act(() => api.post('/contracts/' + id + '/send', {}), (r) => (r.emailed ? tr('Sent: emailed to {email}. Share the link on WhatsApp too.', { email: r.customer.email }) : tr('Sent: share its link with the customer.')));
  const saveEdit = () => act(async () => { const r = await api.patch('/contracts/' + id, editing); setEditing(null); return r; }, () => tr('Draft saved.'));
  function voidIt() {
    const reason = window.prompt(tr('Why is it voided?'));
    if (reason) act(() => api.post('/contracts/' + id + '/void', { reason }), () => tr('Contract voided.'));
  }
  async function copy() { try { await navigator.clipboard.writeText(k.url); onToast(tr('Link copied.')); } catch { window.prompt(tr('Copy the link'), k.url); } }
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog ktr-dlg is-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ktr-one-title">
        {!k ? <p className="muted">{error || tr('Loading…')}</p> : (
          <>
            <div className="ktr-one-head">
              <span className={'ktr-tag is-' + k.status}>{STATUS[k.status][0]} {STATUS[k.status][1]()}</span>
              <h2 id="ktr-one-title">{k.title}</h2>
              <small>{k.contractNo} · {k.customer.name}{k.quotation ? ' · ' : ''}{k.quotation && <Link to={'/quotations?open=' + k.quotation.id}>{k.quotation.quotationNo}</Link>}</small>
            </div>
            <ol className="ktr-steps">
              <li className="is-done">📝 {tr('Made {when}', { when: when(k.createdAt) })}{k.createdBy ? ' · ' + k.createdBy : ''}</li>
              <li className={k.sentAt ? 'is-done' : ''}>📨 {k.sentAt ? tr('Sent {when}', { when: when(k.sentAt) }) : tr('Not sent yet')}</li>
              <li className={k.viewedAt ? 'is-done' : ''}>👀 {k.viewedAt ? tr('Opened {when}', { when: when(k.viewedAt) }) : tr('Not opened yet')}</li>
              <li className={k.signedAt ? 'is-done is-signed' : k.status === 'declined' ? 'is-declined' : ''}>{k.signedAt ? '✍️ ' + tr('Signed {when} by {name}', { when: when(k.signedAt), name: k.signerName }) : k.status === 'declined' ? '✋ ' + tr('Declined: “{note}”', { note: k.declineNote }) : '✍️ ' + tr('Not signed yet')}</li>
            </ol>
            {k.status === 'void' && k.declineNote && <p className="ktr-void">🗂️ {tr('Voided: {reason}', { reason: k.declineNote })}</p>}
            {k.url && (k.status === 'sent') && (
              <div className="ktr-link">
                <code>{k.url}</code>
                <button type="button" className="btn btn-secondary" onClick={copy}>📋 {tr('Copy link')}</button>
                <a className="btn ktr-wa" href={'https://wa.me/?text=' + encodeURIComponent(shareText(k))} target="_blank" rel="noreferrer">💬 WhatsApp</a>
              </div>
            )}
            {editing ? (
              <div className="ktr-form">
                <label className="ktr-field">{tr('Title')}<input className="input" maxLength={160} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
                <label className="ktr-field">{tr('The words')}<textarea className="input ktr-body" rows={18} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></label>
              </div>
            ) : (
              <div className="ktr-paper csg-paper">
                <ContractText body={k.body} />
                {k.status === 'signed' && (
                  <div className="csg-sigs">
                    <div className="csg-sig"><small>{tr('For {company}', { company: 'Bamboo Products Limited' })}</small><span className="csg-sig-line is-typed">{k.counterName || '—'}</span></div>
                    <div className="csg-sig"><small>{tr('For the client')}</small><SignatureView strokes={k.signature} className="csg-sig-draw" /><span className="csg-sig-line">{k.signerName} · {when(k.signedAt)}</span></div>
                  </div>
                )}
              </div>
            )}
            <div className="dialog-actions">
              {canManage && k.status === 'draft' && !editing && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing({ title: k.title, body: k.body })}>✏️ {tr('Edit')}</button>}
              {editing && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(null)}>{tr('Cancel')}</button>}
              {editing && <button type="button" className="btn btn-primary" disabled={busy} onClick={saveEdit}>{tr('Save the draft')}</button>}
              {canManage && !editing && (k.status === 'draft' || k.status === 'sent') && <button type="button" className="btn btn-primary" disabled={busy} onClick={send}>📨 {k.status === 'draft' ? tr('Send to sign') : tr('Send again')}</button>}
              {k.url && !editing && <a className="btn btn-secondary" href={k.url} target="_blank" rel="noreferrer">🖨️ {tr('Its page (print)')}</a>}
              {canManage && !editing && k.status !== 'void' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={voidIt}>🗂️ {tr('Void')}</button>}
              {!editing && <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>}
            </div>
          </>
        )}
      </div>
    </div>, document.body
  );
}

export default function ContractsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [making, setMaking] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [toast, setToast] = useState(null);
  const openId = params.get('open');
  const load = useCallback(() => api.get('/contracts' + (filter ? '?status=' + filter : '')).then(setData).catch((e) => setError(e.message)), [filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);

  if (error) return <div className="ktr"><div className="error-banner" role="alert">{error}</div></div>;
  if (!data) return <div className="ktr"><p className="muted">{tr('Loading…')}</p></div>;
  const c = data.counts;
  return (
    <div className="ktr">
      <section className="ktr-hero">
        <span className="ktr-hero-art" aria-hidden="true">📜<i>✍️</i></span>
        <div className="ktr-hero-main">
          <h1>{tr('Contracts')}</h1>
          <p>{tr('Agreements signed online: made from a template with the customer\'s details and quotation filled in, sent as a link, signed on a phone with a finger.')}</p>
        </div>
        <div className="ktr-hero-acts">
          <button type="button" className="btn btn-secondary" onClick={() => setTemplates(true)}>📚 {tr('Templates')}</button>
          {can('quotation.manage') && <button type="button" className="btn btn-primary" onClick={() => setMaking(true)}>＋ {tr('New contract')}</button>}
        </div>
      </section>
      <div className="ktr-stats">
        {['draft', 'sent', 'signed', 'declined'].map((s) => (
          <button key={s} type="button" className={'ktr-stat is-' + s + (filter === s ? ' is-on' : '')} onClick={() => setFilter(filter === s ? '' : s)}>
            <small>{STATUS[s][0]} {STATUS[s][1]()}</small><strong>{c[s] || 0}</strong>
          </button>
        ))}
      </div>
      <div className="ktr-filters" role="tablist" aria-label={tr('Which contracts')}>
        {FILTERS.map((k) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>{k ? STATUS[k][1]() : tr('All')}</button>)}
      </div>
      {!data.contracts.length ? (
        <div className="ktr-empty"><span aria-hidden="true">📜</span><strong>{tr('No contracts here')}</strong><p>{tr('Make one from a quotation the customer approved, and send it to sign.')}</p></div>
      ) : (
        <ul className="ktr-list">
          {data.contracts.map((k, i) => (
            <li key={k.id} style={{ '--i': Math.min(i, 10) }}>
              <button type="button" className={'ktr-row is-' + k.status} onClick={() => setParams({ open: k.id })}>
                <span className="ktr-row-ico" aria-hidden="true">{STATUS[k.status][0]}</span>
                <span className="ktr-row-main"><strong>{k.title}</strong><small>{k.contractNo} · {k.customer.name}{k.quotation ? ' · ' + k.quotation.quotationNo : ''}</small></span>
                <span className="ktr-row-when">
                  <span className={'ktr-tag is-' + k.status}>{STATUS[k.status][1]()}</span>
                  <small>{k.signedAt ? tr('Signed {when}', { when: when(k.signedAt) }) : k.viewedAt ? tr('Opened {when}', { when: when(k.viewedAt) }) : k.sentAt ? tr('Sent {when}', { when: when(k.sentAt) }) : when(k.createdAt)}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {making && <NewContractDialog onClose={() => setMaking(false)} onMade={(k) => { setMaking(false); load(); setParams({ open: k.id }); }} />}
      {templates && <TemplatesDialog onClose={() => setTemplates(false)} onToast={setToast} />}
      {openId && <ContractDialog id={openId} canManage={can('quotation.manage')} onClose={() => setParams({})} onChanged={load} onToast={setToast} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
