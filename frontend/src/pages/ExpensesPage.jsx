import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './ExpensesPage.css';

// Ported from Bamboo OS.dc.html's expenses screen (screens.expenses block
// + the expenses computed values, and the "Edit expense claim" dialog
// around its render()).

function tagClass(status) {
  if (status === 'approved' || status === 'paid') return 'tag-neutral';
  if (status === 'rejected') return 'tag-accent';
  return 'tag-outline';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY_FORM = { category: '', amount: '', date: '', description: '' };

export default function ExpensesPage() {
  const { session, can } = useAuth();
  const employeeId = session && session.employee && session.employee.id;
  const canRequest = can('expense.request');
  const canApprove = can('expense.approve');

  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editError, setEditError] = useState(null);
  const [editSaving, setEditSaving] = useState(false);

  const [busyId, setBusyId] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setExpenses(await api.get('/expenses'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/expenses', form);
      setToast('Expense claim submitted.');
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDecision(row, decision) {
    setBusyId(row.id);
    setError(null);
    try {
      await api.post('/expenses/' + row.id + '/decision', { decision: decision });
      setToast('Claim ' + decision + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleMarkPaid(row) {
    setBusyId(row.id);
    setError(null);
    try {
      await api.post('/expenses/' + row.id + '/mark-paid');
      setToast('Claim marked paid.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(row) {
    setEditError(null);
    setEditTarget(row);
    setEditForm({ category: row.category, amount: row.amount, date: row.date, description: row.description });
  }

  async function submitEdit(e) {
    e.preventDefault();
    setEditSaving(true);
    setEditError(null);
    try {
      await api.patch('/expenses/' + editTarget.id, editForm);
      setToast('Expense claim updated.');
      setEditTarget(null);
      await load();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    setError(null);
    try {
      await api.del('/expenses/' + deleteTarget.id);
      setToast(deleteTarget.category + ' claim removed.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleExpenses = expenses.filter((x) => matchesQuery(search, x.requesterName, x.departmentName, x.category, x.description, x.status));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canRequest && (
        <form className="card expenses-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="ex-category">Submit expense · category</label>
            <input id="ex-category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Travel, Fuel…" required />
          </div>
          <div className="field">
            <label htmlFor="ex-amount">Amount (GHS)</label>
            <input id="ex-amount" className="input" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="ex-date">Date</label>
            <input id="ex-date" className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="ex-description">Description</label>
            <input id="ex-description" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
          </div>
          <button className="btn btn-primary expenses-submit-btn" type="submit" disabled={submitting}>Submit claim</button>
        </form>
      )}

      <SearchInput value={search} onChange={setSearch} placeholder="Search expense claims…" />

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Requester</th><th>Group</th><th>Category</th><th>Amount</th><th>Date</th><th>Description</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {visibleExpenses.map((x) => {
            const decidable = x.status === 'pending' && canApprove && x.requesterId !== employeeId;
            const payable = x.status === 'approved' && canApprove;
            const canEdit = x.status === 'pending' && (x.requesterId === employeeId || canApprove);
            const busy = busyId === x.id;
            return (
              <tr key={x.id}>
                <td style={{ fontWeight: 600 }}>{x.requesterName}</td>
                <td>{x.departmentName}</td>
                <td>{x.category}</td>
                <td>GHS {x.amount.toLocaleString()}</td>
                <td>{fmtDate(x.date)}</td>
                <td className="expenses-description">{x.description}</td>
                <td><span className={'tag ' + tagClass(x.status)}>{x.status}</span></td>
                <td className="table-actions">
                  {decidable && (
                    <>
                      <button type="button" className="btn btn-secondary expenses-row-btn" disabled={busy} onClick={() => handleDecision(x, 'approved')}>Approve</button>
                      <button type="button" className="btn btn-secondary expenses-row-btn" disabled={busy} onClick={() => handleDecision(x, 'rejected')}>Reject</button>
                    </>
                  )}
                  {payable && <button type="button" className="btn btn-secondary expenses-row-btn" disabled={busy} onClick={() => handleMarkPaid(x)}>Mark paid</button>}
                  {canEdit && <button type="button" className="btn btn-secondary expenses-row-btn" disabled={busy} onClick={() => openEdit(x)}>Edit</button>}
                  {canEdit && <button type="button" className="btn btn-secondary expenses-row-btn" disabled={busy} onClick={() => setDeleteTarget(x)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!expenses.length && <p className="table-empty">Nothing to show.</p>}
      {!!expenses.length && !visibleExpenses.length && <p className="table-empty">No expense claims match "{search}".</p>}

      {editTarget && (
        <div className="dialog-backdrop" onClick={() => setEditTarget(null)}>
          <form className="dialog expenses-edit-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitEdit}>
            <h2>Edit expense claim</h2>
            {editError && <div className="error-banner">{editError}</div>}
            <div className="field">
              <label htmlFor="eec-category">Category</label>
              <input id="eec-category" className="input" value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="eec-amount">Amount (GHS)</label>
              <input id="eec-amount" className="input" type="number" value={editForm.amount} onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="eec-date">Date</label>
              <input id="eec-date" className="input" type="date" value={(editForm.date || '').slice(0, 10)} onChange={(e) => setEditForm({ ...editForm, date: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="eec-description">Description</label>
              <input id="eec-description" className="input" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} required />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditTarget(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={editSaving}>{editSaving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {deleteTarget.category} claim</h2>
            <p className="dialog-body">This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
