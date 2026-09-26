import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Change, Empty, Glossary, Hero, Icon, Insights, LinkButton, PairBars, RankList, Row, Section, Status, fmtDate, jump } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { STAGES, ImportDialog, LeadDialog, NewLeadDialog, Toast, VisitDialog, addDays, followUpText, ghs, monthLabel, stage, todayISO, useCrmBasics, usePerms, visitLabel } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';

// The CRM's front page: the sales team's week and quarter at a glance, the
// way the "Kick-back CRM" sheet's Dash-Board and Summary tabs showed it, but
// worked out from the leads and the OS invoices as they are now. Backed by
// GET /api/crm/overview (crm.service.js overview()).

function quarter(offset) {
  const d = new Date();
  const q = Math.floor(d.getUTCMonth() / 3) + offset;
  const y = d.getUTCFullYear() + Math.floor(q / 4);
  const qq = ((q % 4) + 4) % 4;
  const from = new Date(Date.UTC(y, qq * 3, 1));
  const to = new Date(Date.UTC(y, qq * 3 + 3, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
const PERIODS = {
  quarter: () => quarter(0),
  lastQuarter: () => quarter(-1),
  year: () => ({ from: new Date().getUTCFullYear() + '-01-01', to: new Date().getUTCFullYear() + '-12-31' }),
  twelve: () => ({ from: addDays(todayISO(), -364).slice(0, 8) + '01', to: todayISO() })
};

export default function CrmOverviewPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const meId = session && session.employee ? session.employee.id : null;
  const { canManage } = usePerms();
  const { settings, people } = useCrmBasics();
  const [period, setPeriod] = useState('quarter');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    const p = PERIODS[period]();
    try { setD(await api.get('/crm/overview?from=' + p.from + '&to=' + p.to)); setError(null); } catch (err) { setError(err.message); }
  }, [period]);
  useEffect(() => { load(); }, [load]);

  if (!d) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;

  const t = d.totals;
  const periodName = { quarter: tr('this quarter'), lastQuarter: tr('last quarter'), year: tr('this year'), twelve: tr('the last 12 months') }[period];
  const prevName = { quarter: tr('last quarter'), lastQuarter: tr('the quarter before'), year: tr('last year'), twelve: tr('the 12 months before') }[period];
  const f = d.followUps;
  const toLeads = (q) => navigate('/crmleads' + (q ? '?' + q : ''));

  const insights = [];
  if (d.mine.overdue || d.mine.dueToday) {
    insights.push({ tone: d.mine.overdue ? 'bad' : 'warn', icon: 'phone', text: tr('Your follow-ups: {overdue} overdue and {today} due today.', { overdue: d.mine.overdue, today: d.mine.dueToday }), action: { label: tr('Call them'), run: () => toLeads('rep=me&followUp=' + (d.mine.overdue ? 'overdue' : 'today')) } });
  }
  if (f.overdue) insights.push({ tone: 'bad', icon: 'clock', text: f.overdue === 1 ? tr('1 lead is waiting for a follow-up that was due before today.') : tr('{n} leads are waiting for a follow-up that was due before today.', { n: f.overdue }), action: { label: tr('Show them'), run: () => toLeads('followUp=overdue') } });
  const newCount = (d.stages.find((s) => s.stage === 'new') || {}).count || 0;
  if (newCount) insights.push({ tone: 'warn', icon: 'send', text: newCount === 1 ? tr('1 new lead hasn\'t been contacted yet.') : tr('{n} new leads haven\'t been contacted yet.', { n: newCount }), action: { label: tr('Show them'), run: () => toLeads('stage=new') } });
  if (f.stale) insights.push({ tone: 'info', icon: 'calendar', text: tr('{n} open leads have had no stage change for {days} days and no follow-up date — they are drifting.', { n: f.stale, days: f.staleDays }), action: { label: tr('Show them'), run: () => toLeads('followUp=none') } });
  if (d.unlinkedSales.count) insights.push({ tone: 'warn', icon: 'receipt', text: tr('{n} sales invoices worth {amount} {period} aren\'t linked to a lead, so they don\'t count here and nobody\'s commission is worked out.', { n: d.unlinkedSales.count, amount: ghs(d.unlinkedSales.total), period: periodName }) });
  if (d.seeAllCommission && d.commission.readyCount) insights.push({ tone: 'info', icon: 'cash', text: tr('{n} commissions worth {amount} are on paid-up sales and can be paid.', { n: d.commission.readyCount, amount: ghs(d.commission.ready) }), action: { label: tr('Open commissions'), run: () => navigate('/crmcommissions') } });
  const bestSource = d.sources.filter((s) => s.leads >= 3).sort((a, b) => b.won / b.leads - a.won / a.leads)[0];
  if (bestSource && bestSource.won) insights.push({ tone: 'good', icon: 'spark', text: tr('{source} turns the most leads into sales: {won} of {leads}.', { source: bestSource.source || tr('Not known'), won: bestSource.won, leads: bestSource.leads }) });
  if (t.conversion !== null) insights.push({ tone: t.conversion >= 20 ? 'good' : 'info', icon: 'percent', text: tr('{pct}% of the leads received {period} were won ({won} of {n}); {lost} were lost.', { pct: t.conversion, period: periodName, won: t.won, n: t.leads, lost: t.lost }) });
  if (!d.totalLeads) insights.push({ tone: 'info', icon: 'info', text: tr('No leads yet. Add them as they come in, or import the sheets you kept them in.') });

  const flow = STAGES.map((s) => {
    const c = (d.stages.find((x) => x.stage === s.key) || {}).count || 0;
    return { ...s, n: c, pct: d.totalLeads ? Math.round(c / d.totalLeads * 100) : 0 };
  });

  return (
    <div className="dk crm">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="crm-toolbar">
        <div className="dk-segment" role="radiogroup" aria-label={tr('Period')}>
          {[['quarter', tr('This quarter')], ['lastQuarter', tr('Last quarter')], ['year', tr('This year')], ['twelve', tr('Last 12 months')]].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={period === k} className={period === k ? 'is-on' : ''} onClick={() => setPeriod(k)}>{label}</button>
          ))}
        </div>
        <span className="dk-muted tl-small">{fmtDate(d.period.from)} – {fmtDate(d.period.to)}</span>
      </div>

      <Hero eyebrow={d.company || tr('Sales')} title={tr('Sales & CRM')}
        sub={tr('Every enquiry from the first message to a sale: who is on it, when to call back, what was won, and the commission on it. Sales money comes from the OS invoices.')}
        actions={canManage && <>
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'new' })}>{tr('Add a lead')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => setDialog({ kind: 'import' })}>{tr('Import from a spreadsheet')}</button>
        </>}
        stats={[
          { icon: 'cash', value: ghs(t.revenue), label: tr('sales {period}', { period: periodName }), note: <Change now={t.revenue} before={d.previousTotals.revenue} label={prevName} />, onClick: () => jump('crm-months') },
          { icon: 'check', value: String(t.deals), label: tr('deals closed'), note: t.averageDeal ? tr('{amount} on average', { amount: ghs(t.averageDeal) }) : tr('none yet'), onClick: () => navigate('/crmcommissions') },
          { icon: 'owed', value: ghs(t.arrears), label: tr('still owed on them'), note: tr('{amount} received', { amount: ghs(t.cash) }), tone: t.arrears > 0 ? 'bad' : '' },
          { icon: 'phone', value: String(f.overdue + f.today), label: tr('follow-ups due'), note: tr('{overdue} overdue · {week} more this week', { overdue: f.overdue, week: f.week }), tone: f.overdue ? 'alert' : '', onClick: () => toLeads('followUp=overdue') }
        ]} />

      <Insights items={insights.slice(0, 6)} />

      <Section id="crm-pipeline" title={tr('The pipeline')} sub={tr('Every lead, by the stage it has reached ({n} in all, {open} still open). Press a stage to see its leads.', { n: d.totalLeads, open: d.openLeads })}
        action={<LinkButton onClick={() => toLeads('view=board')}>{tr('Open the board')}</LinkButton>}>
        <ul className="dk-flow crm-flow">
          {flow.map((s) => (
            <li key={s.key} className={'is-' + (s.tone === 'good' ? 'good' : s.tone === 'bad' ? 'bad' : s.tone === 'warn' ? 'warn' : 'info')}>
              <button type="button" className="crm-flow-btn" onClick={() => toLeads('stage=' + s.key)}>
                <span className="dk-flow-name">{tr(s.label)}</span>
                <span className="dk-flow-n">{s.n}</span>
                <span className="dk-flow-value">{tr('{pct}% of all leads', { pct: s.pct })}</span>
                <span className="dk-flow-help">{tr(s.help)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section card id="crm-months" title={tr('Month by month')} sub={tr('Sales linked to leads, and the money received on them, in GHS. The gap is what is still owed.')}>
        <PairBars rows={d.months.map((m) => ({ label: monthLabel(m.month), a: m.revenue, b: m.cash }))} aLabel={tr('Sales')} bLabel={tr('Received')} aClass="is-info-bar" bClass="is-in" format={ghs} />
        <ul className="dk-rows crm-months">
          {d.months.map((m) => (
            <Row key={m.month} title={monthLabel(m.month)} meta={(m.leads === 1 ? tr('1 lead received') : tr('{n} leads received', { n: m.leads })) + ' · ' + (m.deals === 1 ? tr('1 deal closed') : tr('{n} deals closed', { n: m.deals }))}
              amount={ghs(m.revenue)} side={m.arrears > 0 ? tr('{amount} owed', { amount: ghs(m.arrears) }) : m.revenue ? tr('all received') : ''} sideClass={m.arrears > 0 ? 'is-warn' : ''} />
          ))}
        </ul>
      </Section>

      <div className="dk-two">
        <Section card title={tr('The team')} sub={tr('Per sales rep {period}: leads they received, deals and sales.', { period: periodName })}>
          {d.team.length ? (
            <RankList rows={d.team.map((r) => ({
              key: r.repId || r.name || 'none', name: r.name || tr('No rep'), value: r.revenue, amount: ghs(r.revenue),
              meta: [r.leads === 1 ? tr('1 lead') : tr('{n} leads', { n: r.leads }), tr('{n} won', { n: r.won }), r.deals === 1 ? tr('1 deal') : tr('{n} deals', { n: r.deals }),
                r.overdue ? (r.overdue === 1 ? tr('1 follow-up overdue') : tr('{n} follow-ups overdue', { n: r.overdue })) : null,
                r.commissionDue ? tr('{amount} commission to pay', { amount: ghs(r.commissionDue) }) : null].filter(Boolean).join(' · ')
            }))} />
          ) : <Empty icon="people">{tr('No leads or deals {period}.', { period: periodName })}</Empty>}
        </Section>
        <Section card title={tr('Where leads come from')} sub={tr('Leads received {period} by how they found us, and how many were won.', { period: periodName })}>
          {d.sources.length ? (
            <RankList barClass="is-info" rows={d.sources.map((s) => ({ key: s.source || '-', name: s.source || tr('Not known'), value: s.leads, amount: s.leads === 1 ? tr('1 lead') : tr('{n} leads', { n: s.leads }), meta: s.leads ? tr('{won} won · {pct}%', { won: s.won, pct: Math.round(s.won / s.leads * 100) }) : '' }))} />
          ) : <Empty icon="spark">{tr('No leads received {period}.', { period: periodName })}</Empty>}
        </Section>
      </div>

      <div className="dk-two">
        <Section card id="crm-follow" title={tr('Follow-ups due')} sub={tr('Overdue first. Press one to open it.')} action={<LinkButton onClick={() => toLeads('followUp=overdue')}>{tr('All overdue')}</LinkButton>}>
          {f.list.length ? (
            <ul className="dk-rows">
              {f.list.map((l) => (
                <li key={l.id} className="dk-row crm-row-btn">
                  <button type="button" onClick={() => setDialog({ kind: 'lead', id: l.id })}>
                    <span className={'dk-lead-icon ' + (l.nextFollowUp < todayISO() ? 'is-bad' : 'is-warn')}><Icon name="phone" /></span>
                    <div className="dk-row-main">
                      <div className="dk-row-title">{l.name}</div>
                      <div className="dk-muted dk-row-meta">{[l.item, l.repName, tr(stage(l.stage).label)].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="dk-row-side"><div className={'dk-row-note ' + (l.nextFollowUp < todayISO() ? 'is-bad' : 'is-warn')}>{followUpText(l.nextFollowUp)}</div></div>
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty>{tr('Nobody is waiting for a call back today.')}</Empty>}
        </Section>
        <Section card title={tr('Site visits')} sub={tr('{visited} of {n} visits {period} done; {cancelled} cancelled.', { visited: d.visits.visited, n: d.visits.scheduled, period: periodName, cancelled: d.visits.cancelled })}
          action={<LinkButton onClick={() => navigate('/crmvisits')}>{tr('Open site visits')}</LinkButton>}>
          {d.visits.upcoming.length ? (
            <ul className="dk-rows">
              {d.visits.upcoming.map((v) => (
                <Row key={v.id} lead={<span className="dk-lead-icon is-info"><Icon name="calendar" /></span>} title={v.client}
                  meta={[v.location, v.assessors.map((a) => a.name).concat(v.assessorsText ? [v.assessorsText] : []).join(', ')].filter(Boolean).join(' · ')}
                  side={<Status tone="info">{visitLabel(v.status)}</Status>} amount={fmtDate(v.scheduledOn)} />
              ))}
            </ul>
          ) : <Empty icon="calendar">{tr('No visit booked for the next two weeks.')}</Empty>}
        </Section>
      </div>

      <Section card title={tr('Prospects')} sub={tr('People and companies from fairs, events and lists, to approach.')} action={<LinkButton onClick={() => navigate('/crmprospects')}>{tr('Open prospects')}</LinkButton>}>
        <p className="crm-big">{tr('{n} prospects, {converted} of them now leads.', { n: d.prospects.total, converted: d.prospects.converted })}</p>
      </Section>

      <Glossary items={[
        [tr('Lead'), tr('Someone who asked about a product. It moves through the stages until it is won or lost.')],
        [tr('Follow-up'), tr('The date someone should get back to the lead. Overdue means that date has passed.')],
        [tr('Deal'), tr('A won lead\'s sale: an OS invoice linked to the lead. Its money is always the invoice\'s.')],
        [tr('Commission'), tr('The rep\'s share of a sale: {rate}% minus the discount given, on the price after discount. 5% off leaves 15%.', { rate: settings ? settings.commissionRate : 20 })],
        [tr('Kick-back'), tr('The same share, paid to someone who isn\'t the sales rep for bringing in the sale.')],
        [tr('Referral'), tr('Someone outside the company who sent a customer; they get {rate}% of the deal.', { rate: settings ? settings.referralRate : 20 })],
        [tr('Conversion'), tr('Leads won out of the leads received in the period.')]
      ]} />

      {dialog && dialog.kind === 'new' && settings && <NewLeadDialog settings={settings} people={people} meId={meId} onClose={() => setDialog(null)} onSaved={(l) => { setDialog({ kind: 'lead', id: l.id }); setToast(tr('Lead {ref} added.', { ref: l.ref })); load(); }} />}
      {dialog && dialog.kind === 'import' && <ImportDialog onClose={() => setDialog(null)} onDone={load} />}
      {dialog && dialog.kind === 'lead' && settings && <LeadDialog leadId={dialog.id} settings={settings} people={people} onClose={() => setDialog(null)} onChanged={load} onVisit={(v) => setDialog({ kind: 'visit', visit: v, back: dialog.id })} />}
      {dialog && dialog.kind === 'visit' && <VisitDialog visit={dialog.visit} people={people} onClose={() => setDialog(dialog.back ? { kind: 'lead', id: dialog.back } : null)} onSaved={() => { setToast(tr('Site visit saved.')); load(); setDialog(dialog.back ? { kind: 'lead', id: dialog.back } : null); }} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
