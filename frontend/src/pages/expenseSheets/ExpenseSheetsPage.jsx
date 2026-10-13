import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Glossary } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import EsOverview from './EsOverview';
import EsSheet from './EsSheet';
import './ExpenseSheets.css';

// Officers' expense sheets (GET /api/expense-sheets…): each officer's float
// as their own running sheet, in place of one spreadsheet per officer.
// Finance (and whoever may see every sheet) starts on the overview of all
// officers; an officer goes straight to their own sheet; a supervisor with
// several sheets to check picks one. ?sheet= opens a sheet (notifications
// link here).

export default function ExpenseSheetsPage() {
  const { session, can } = useAuth();
  const me = session && session.employee ? session.employee : {};
  const finance = can('expensesheet.manage') || can('expensesheet.read.all');
  const [params, setParams] = useSearchParams();
  const sheetParam = params.get('sheet');
  const [sheets, setSheets] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [report, setReport] = useState(null);
  const [topups, setTopups] = useState([]);
  const [people, setPeople] = useState([]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [sheetYear, setSheetYear] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const loadList = useCallback(async () => {
    try {
      setSheets(await api.get('/expense-sheets'));
      if (finance) setReport(await api.get('/expense-sheets/report?year=' + year));
      if (can('expensesheet.manage')) setTopups(await api.get('/expense-sheets/topups'));
    } catch (e) { setError(e.message); }
  }, [finance, year, can]);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    if (!can('expensesheet.manage')) return;
    // Everyone active (the chat directory, which leaves out the viewer), and the viewer.
    api.get('/messages/directory').then((list) => setPeople(list.map((p) => ({ id: p.id, name: p.name, department: p.department || '' }))
      .concat(me.id ? [{ id: me.id, name: ((me.firstName || '') + ' ' + (me.lastName || '')).trim(), department: '' }] : [])
      .sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {});
  }, [can, me.id, me.firstName, me.lastName]);

  // Which sheet is open: the one asked for, else an officer's only sheet.
  const openId = sheetParam || (sheets && !finance && sheets.length === 1 ? sheets[0].id : null);
  const loadSheet = useCallback(async (y) => {
    if (!openId) { setSheet(null); return; }
    try { setSheet(await api.get('/expense-sheets/' + openId + (y ? '?year=' + y : ''))); setError(null); } catch (e) { setError(e.message); setSheet(null); }
  }, [openId]);
  useEffect(() => { loadSheet(sheetYear); }, [loadSheet, sheetYear]);
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  function open(id) { setSheetYear(null); setParams(id ? { sheet: id } : {}); window.scrollTo(0, 0); }
  function reloadSheet(y) {
    if (typeof y === 'number') { setSheetYear(y); return; }
    loadSheet(sheetYear); loadList();
  }

  if (!sheets) return error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>;

  return (
    <div className="dk es">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {openId ? (
        sheet ? <EsSheet sheet={sheet} viewerId={me.id} people={people} onReload={reloadSheet} onBack={finance || sheets.length > 1 ? () => open(null) : null} setNotice={setNotice} />
          : <div className="eyebrow">{tr('Loading…')}</div>
      ) : sheets.length || finance ? (
        <EsOverview sheets={sheets} report={finance ? report : null} topups={topups} can={{ manage: can('expensesheet.manage') }} people={people}
          year={year} onYear={setYear} onOpen={open} onReload={loadList} setNotice={setNotice} />
      ) : (
        <div className="es-none">
          <h2>{tr('You have no expense sheet')}</h2>
          <p>{tr('If the company gives you a float to spend for it, ask finance to open an expense sheet for you. You will then record here what you spend and the money you receive.')}</p>
          <p className="es-muted">{tr('To be paid back for something you bought yourself, use Expenses (claims) instead.')}</p>
        </div>
      )}
      <Glossary items={[
        [tr('Float'), tr('Money the company gives an officer to spend for it. The usual float is the amount they are topped up to.')],
        [tr('Balance'), tr('Money received minus money spent. Above zero it is cash the officer holds; below zero the company owes the officer.')],
        [tr('Check'), tr('A supervisor or finance confirms the balance up to a date, counting the cash if they want. Lines on or before that date are then locked.')],
        [tr('Cost centre'), tr('The company, site or job the money was spent for.')],
        [tr('Top-up'), tr('Money the officer asks finance for. Once approved it is added to the sheet as money received.')]
      ]} />
      {notice && <div className="es-notice" role="status">{notice}</div>}
    </div>
  );
}
