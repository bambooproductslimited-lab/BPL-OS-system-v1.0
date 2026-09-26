import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import ContactButtons from '../../components/ContactButtons';
import { Empty, Glossary, Hero, Section } from '../../components/DashKit';
import SearchInput, { matchesQuery } from '../../components/SearchInput';
import { tr } from '../../lib/i18n.jsx';
import { ImportDialog, StageTag, Toast, usePerms } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';

// People and companies to approach — met at a fair or event, or found for
// an industry list — as the "Customer Leads" sheet kept them. One tap makes
// a prospect a lead, keeping where it came from.

const STEP = 60;
const blank = { listName: '', market: 'local', company: '', name: '', phone: '', email: '', website: '', interest: '', notes: '' };

export default function CrmProspectsPage() {
  const navigate = useNavigate();
  const { canManage } = usePerms();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [list, setList] = useState('');
  const [market, setMarket] = useState('');
  const [shown, setShown] = useState(STEP);
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.get('/crm/prospects')); setError(null); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => (data ? data.prospects.filter((p) =>
    (!list || p.listName === list) && (!market || p.market === market) &&
    matchesQuery(q, p.name, p.company, p.interest, p.email, p.phone, p.notes, p.listName)) : []), [data, list, market, q]);

  if (!data) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;

  const total = data.prospects.length;
  const converted = data.prospects.filter((p) => p.leadId).length;
  const withContact = data.prospects.filter((p) => p.phone || p.email).length;
  const exportCount = data.prospects.filter((p) => p.market === 'export').length;
  const lists = [...new Map(data.lists.map((l) => [l.listName, l])).values()];

  async function toLead(p) {
    setBusy(p.id); setError(null);
    try { const l = await api.post('/crm/prospects/' + p.id + '/lead', {}); setToast(tr('{name} is now lead {ref}.', { name: p.name || p.company, ref: l.ref })); await load(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function save(e) {
    e.preventDefault();
    setBusy('form'); setError(null);
    try {
      if (editing.id) await api.put('/crm/prospects/' + editing.id, editing); else await api.post('/crm/prospects', editing);
      setEditing(null); setToast(tr('Prospect saved.')); await load();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function remove(p) {
    setBusy(p.id);
    try { await api.del('/crm/prospects/' + p.id); setEditing(null); await load(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  return (
    <div className="dk crm">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Hero eyebrow={tr('Sales & CRM')} title={tr('Prospects')}
        sub={tr('People and companies worth approaching: contacts from fairs and events, and lists of businesses by industry. When one shows interest, make them a lead.')}
        actions={canManage && <>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ ...blank })}>{tr('Add a prospect')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => setImporting(true)}>{tr('Import from a spreadsheet')}</button>
        </>}
        stats={[
          { icon: 'people', value: String(total), label: tr('prospects'), note: tr('in {n} lists', { n: lists.length }) },
          { icon: 'check', value: String(converted), label: tr('now leads'), note: total ? tr('{pct}% of them', { pct: Math.round(converted / total * 100) }) : tr('none yet'), tone: converted ? 'good' : '', onClick: () => navigate('/crmleads?source=Prospect%20list&stage=all') },
          { icon: 'phone', value: String(withContact), label: tr('with a phone or email'), note: tr('{n} without a way to reach them', { n: total - withContact }) },
          { icon: 'send', value: String(exportCount), label: tr('export market'), note: tr('{n} local', { n: total - exportCount }) }
        ]} />

      <Section title={tr('Lists')} sub={tr('Where the prospects came from. Press one to see only its people.')}>
        {lists.length ? (
          <ul className="dk-flow crm-lists">
            {lists.map((l) => (
              <li key={l.listName || '-'} className={list === l.listName ? 'is-good' : 'is-muted'}>
                <button type="button" className="crm-flow-btn" onClick={() => { setList(list === l.listName ? '' : l.listName); setShown(STEP); }}>
                  <span className="dk-flow-name">{l.listName || tr('No list')}</span>
                  <span className="dk-flow-n">{l.count}</span>
                  <span className="dk-flow-value">{l.converted ? tr('{n} now leads', { n: l.converted }) : tr('none approached yet')}</span>
                  <span className="dk-flow-help">{l.market === 'export' ? tr('Export market') : tr('Local market')}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <Empty icon="people">{tr('No prospects yet. Add them, or import the Customer Leads sheet.')}</Empty>}
      </Section>

      {total > 0 && (
        <Section id="crm-prospects" title={list || tr('Everyone')} sub={tr('{n} shown.', { n: filtered.length })}>
          <div className="crm-filters">
            <SearchInput value={q} onChange={(v) => { setQ(v); setShown(STEP); }} placeholder={tr('Search name, company, interest…')} />
            <select className="input" value={market} onChange={(e) => setMarket(e.target.value)} aria-label={tr('Market')}>
              <option value="">{tr('Local and export')}</option>
              <option value="local">{tr('Local market')}</option>
              <option value="export">{tr('Export market')}</option>
            </select>
          </div>
          {filtered.length ? (
            <div className="crm-cards">
              {filtered.slice(0, shown).map((p) => (
                <article key={p.id} className={'crm-card' + (p.leadId ? ' is-good' : ' is-muted')}>
                  <div className="crm-card-body">
                    <span className="crm-card-top"><strong className="crm-card-name">{p.name || p.company}</strong>{p.leadId && <StageTag value={p.leadStage} />}</span>
                    {p.name && p.company && p.company !== p.name && <span className="dk-muted tl-small">{p.company}</span>}
                    <span className="dk-muted tl-small">{[p.listName, p.market === 'export' ? tr('Export market') : null, p.interest].filter(Boolean).join(' · ') || '—'}</span>
                    <ContactButtons name={p.name || p.company} phone={p.phone} email={p.email} />
                    {p.notes && <span className="dk-muted tl-small crm-card-note">{p.notes}</span>}
                    {canManage && (
                      <span className="crm-card-acts">
                        {p.leadId ? <button type="button" className="dk-link" onClick={() => navigate('/crmleads?lead=' + p.leadId)}>{tr('Open lead {ref}', { ref: p.leadRef })}</button>
                          : <button type="button" className="btn btn-secondary tl-btn" disabled={busy === p.id} onClick={() => toLead(p)}>{tr('Make a lead')}</button>}
                        <button type="button" className="dk-link" onClick={() => setEditing({ ...p })}>{tr('Edit')}</button>
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : <Empty>{tr('Nothing matches. Try another search or filter.')}</Empty>}
          {filtered.length > shown && <button type="button" className="btn btn-secondary crm-more" onClick={() => setShown(shown + STEP)}>{tr('Show {n} more', { n: Math.min(STEP, filtered.length - shown) })}</button>}
        </Section>
      )}

      <Glossary items={[
        [tr('Prospect'), tr('Someone who might buy, but hasn\'t asked about anything yet.')],
        [tr('Make a lead'), tr('When a prospect shows interest, they become a lead with a stage, a rep and a follow-up date. The prospect stays in its list, marked as a lead.')],
        [tr('Export market'), tr('Buyers outside Ghana.')]
      ]} />

      {editing && (
        <div className="dialog-backdrop" onClick={() => busy !== 'form' && setEditing(null)}>
          <form className="dialog tl-dialog crm-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{editing.id ? tr('Prospect') : tr('Add a prospect')}</h2>
            <div className="tl-form">
              <div className="field"><label htmlFor="cp-name">{tr('Name')}</label><input id="cp-name" className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus /></div>
              <div className="field"><label htmlFor="cp-co">{tr('Company')}</label><input id="cp-co" className="input" value={editing.company} onChange={(e) => setEditing({ ...editing, company: e.target.value })} /></div>
              <div className="field"><label htmlFor="cp-phone">{tr('Phone')}</label><input id="cp-phone" className="input" type="tel" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} /></div>
              <div className="field"><label htmlFor="cp-email">{tr('Email')}</label><input id="cp-email" className="input" type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} /></div>
              <div className="field">
                <label htmlFor="cp-list">{tr('Fair, event or list')}</label>
                <input id="cp-list" className="input" list="cp-lists" value={editing.listName} onChange={(e) => setEditing({ ...editing, listName: e.target.value })} />
                <datalist id="cp-lists">{lists.map((l) => <option key={l.listName} value={l.listName} />)}</datalist>
              </div>
              <div className="field">
                <span className="tl-label">{tr('Market')}</span>
                <div className="dk-segment" role="radiogroup" aria-label={tr('Market')}>
                  {[['local', tr('Local')], ['export', tr('Export')]].map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={editing.market === k} className={editing.market === k ? 'is-on' : ''} onClick={() => setEditing({ ...editing, market: k })}>{label}</button>)}
                </div>
              </div>
              <div className="field"><label htmlFor="cp-web">{tr('Website')}</label><input id="cp-web" className="input" value={editing.website} onChange={(e) => setEditing({ ...editing, website: e.target.value })} /></div>
              <div className="field"><label htmlFor="cp-int">{tr('Interested in')}</label><input id="cp-int" className="input" value={editing.interest} onChange={(e) => setEditing({ ...editing, interest: e.target.value })} /></div>
              <div className="field tl-span"><label htmlFor="cp-notes">{tr('Notes')}</label><textarea id="cp-notes" className="input" rows={2} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></div>
            </div>
            <div className="dialog-actions">
              {editing.id && <button type="button" className="btn btn-secondary crm-left" disabled={busy === editing.id} onClick={() => remove(editing)}>{tr('Delete')}</button>}
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy === 'form'}>{busy === 'form' ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={load} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
