import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './InventoryPage.css';

// Ported from Bamboo OS.dc.html's inventory screen (screens.inventory
// block + the products computed values, and the shared "product"
// create/edit dialog around its render()).

const EMPTY_FORM = { sku: '', name: '', category: '', unit: '', costPrice: '', sellingPrice: '', currentStock: '', reorderLevel: '' };

export default function InventoryPage() {
  const { can } = useAuth();
  const canManage = can('inventory.manage');

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setProducts(await api.get('/products'));
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

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(p) {
    setDialogError(null);
    setEditId(p.id);
    setForm({
      sku: p.sku, name: p.name, category: p.category, unit: p.unit,
      costPrice: p.costPrice, sellingPrice: p.sellingPrice, currentStock: p.currentStock, reorderLevel: p.reorderLevel
    });
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.put('/products/' + editId, form);
      else await api.post('/products', form);
      setToast(editId ? 'Product updated.' : 'Product added.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleProducts = products.filter((p) => matchesQuery(search, p.sku, p.name, p.category));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="inventory-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search products…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>Add product</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th>SKU</th><th>Product</th><th>Category</th><th>Cost</th><th>Selling price</th><th>Stock</th><th>Reorder level</th><th /><th /></tr>
        </thead>
        <tbody>
          {visibleProducts.map((p) => (
            <tr key={p.id}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.sku}</td>
              <td style={{ fontWeight: 600 }}>{p.name}</td>
              <td>{p.category}</td>
              <td>{p.costPrice}</td>
              <td>{p.sellingPrice}</td>
              <td>{p.currentStock} {p.unit}</td>
              <td>{p.reorderLevel}</td>
              <td><span className={'tag ' + (p.lowStock ? 'tag-accent' : 'tag-neutral')}>{p.lowStock ? 'Low stock' : 'OK'}</span></td>
              <td className="table-actions">
                {canManage && <button type="button" className="btn btn-secondary inventory-row-btn" onClick={() => openEdit(p)}>Edit</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!products.length && <p className="table-empty">No products in the catalogue yet.</p>}
      {!!products.length && !visibleProducts.length && <p className="table-empty">No products match "{search}".</p>}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog inventory-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="inventory-dialog-title">{editId ? 'Edit product' : 'Add product'}</h2>
            {dialogError && <div className="error-banner inventory-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="prod-sku">SKU</label>
              <input id="prod-sku" className="input" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prod-name">Name</label>
              <input id="prod-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prod-category">Category</label>
              <input id="prod-category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prod-unit">Unit</label>
              <input id="prod-unit" className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="piece, plank, pack" />
            </div>
            <div className="field">
              <label htmlFor="prod-cost">Cost price</label>
              <input id="prod-cost" className="input" type="number" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prod-price">Selling price</label>
              <input id="prod-price" className="input" type="number" value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prod-stock">Opening stock</label>
              <input id="prod-stock" className="input" type="number" value={form.currentStock} onChange={(e) => setForm({ ...form, currentStock: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prod-reorder">Reorder level</label>
              <input id="prod-reorder" className="input" type="number" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
            </div>
            <div className="dialog-actions inventory-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? 'Save changes' : 'Add product'}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
