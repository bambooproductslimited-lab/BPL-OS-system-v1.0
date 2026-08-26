import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './CatalogPage.css';

// Products & Services, restructured to match Square's own catalog shape
// (see migration 0027): an Item can hold one or more Variations — this
// business's real Square catalog uses that heavily (items with anywhere
// from 1 to 22 variations), so a flat one-row-per-product list couldn't
// represent it, and a Square import would otherwise flatten every
// variation into its own unrelated top-level product.

function statusLabel(active) { return active ? 'Active' : 'Archived'; }

const EMPTY_ITEM_FORM = {
  name: '', description: '', categoryId: '', taxRateId: '',
  variationName: '', code: '', unit: '', defaultQty: '', unitPrice: '', costPrice: '', stockQty: ''
};
const EMPTY_VARIATION_FORM = { name: '', code: '', unit: '', defaultQty: '', unitPrice: '', costPrice: '', stockQty: '' };

export default function CatalogPage() {
  const { can } = useAuth();
  const canManage = can('catalog.manage');
  const canSeeTaxRates = can('settings.manage');

  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [search, setSearch] = useState('');

  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editItemId, setEditItemId] = useState(null);
  const [itemForm, setItemForm] = useState(EMPTY_ITEM_FORM);
  const [itemDialogError, setItemDialogError] = useState(null);
  const [savingItem, setSavingItem] = useState(false);

  const [varDialog, setVarDialog] = useState(null); // { itemId, editId, form }
  const [varDialogError, setVarDialogError] = useState(null);
  const [savingVar, setSavingVar] = useState(false);

  const [newCategoryName, setNewCategoryName] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);

  const [deleteItemTarget, setDeleteItemTarget] = useState(null);
  const [deleteVarTarget, setDeleteVarTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [stockDialog, setStockDialog] = useState(null); // { variationId, name, stockQty, delta, note }
  const [stockDialogError, setStockDialogError] = useState(null);
  const [savingStock, setSavingStock] = useState(false);

  const visibleItems = useMemo(() => {
    if (!search.trim()) return items;
    return items.filter((item) => (
      matchesQuery(search, item.name, item.description, item.categoryName) ||
      item.variations.some((v) => matchesQuery(search, v.name, v.code))
    ));
  }, [items, search]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [itemsRes, categoriesRes] = await Promise.all([api.get('/catalog/items'), api.get('/catalog/categories')]);
      setItems(itemsRes);
      setCategories(categoriesRes);
      if (canSeeTaxRates) {
        const settings = await api.get('/commercial-settings');
        setTaxRates(settings.taxRates || []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canSeeTaxRates]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function toggleExpanded(id) {
    setExpanded({ ...expanded, [id]: !expanded[id] });
  }

  function openNewItem() {
    setItemDialogError(null);
    setEditItemId(null);
    setItemForm(EMPTY_ITEM_FORM);
    setItemDialogOpen(true);
  }

  function openEditItem(item) {
    setItemDialogError(null);
    setEditItemId(item.id);
    setItemForm({
      ...EMPTY_ITEM_FORM, name: item.name, description: item.description === '—' ? '' : item.description,
      categoryId: item.categoryId || '', taxRateId: item.taxRateId || ''
    });
    setItemDialogOpen(true);
  }

  async function handleItemSubmit(e) {
    e.preventDefault();
    setSavingItem(true);
    setItemDialogError(null);
    try {
      const payload = { name: itemForm.name, description: itemForm.description, categoryId: itemForm.categoryId || undefined, taxRateId: itemForm.taxRateId || undefined };
      if (editItemId) {
        await api.put('/catalog/items/' + editItemId, payload);
        setToast('Item updated.');
      } else {
        await api.post('/catalog/items', {
          ...payload, name: itemForm.name,
          variationName: itemForm.variationName, code: itemForm.code, unit: itemForm.unit,
          defaultQty: itemForm.defaultQty, unitPrice: itemForm.unitPrice, costPrice: itemForm.costPrice, stockQty: itemForm.stockQty
        });
        setToast('Item added.');
      }
      setItemDialogOpen(false);
      await load();
    } catch (err) {
      setItemDialogError(err.message);
    } finally {
      setSavingItem(false);
    }
  }

  async function toggleItemActive(item) {
    setBusyId(item.id);
    setError(null);
    try {
      await api.post('/catalog/items/' + item.id + '/active', { active: !item.active });
      setToast(item.name + (item.active ? ' archived.' : ' unarchived.'));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDeleteItem() {
    setDeleting(true);
    try {
      await api.del('/catalog/items/' + deleteItemTarget.id);
      setToast(deleteItemTarget.name + ' deleted.');
      setDeleteItemTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  function openNewVariation(itemId) {
    setVarDialogError(null);
    setVarDialog({ itemId, editId: null, form: EMPTY_VARIATION_FORM });
  }
  function openEditVariation(itemId, v) {
    setVarDialogError(null);
    setVarDialog({ itemId, editId: v.id, form: { name: v.name, code: v.code, unit: v.unit, defaultQty: v.defaultQty, unitPrice: v.unitPrice, costPrice: v.costPrice } });
  }

  async function handleVariationSubmit(e) {
    e.preventDefault();
    setSavingVar(true);
    setVarDialogError(null);
    try {
      if (varDialog.editId) await api.put('/catalog/variations/' + varDialog.editId, varDialog.form);
      else await api.post('/catalog/items/' + varDialog.itemId + '/variations', varDialog.form);
      setToast(varDialog.editId ? 'Variation updated.' : 'Variation added.');
      setVarDialog(null);
      await load();
    } catch (err) {
      setVarDialogError(err.message);
    } finally {
      setSavingVar(false);
    }
  }

  async function toggleVariationActive(v) {
    setBusyId(v.id);
    setError(null);
    try {
      await api.post('/catalog/variations/' + v.id + '/active', { active: !v.active });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openStockDialog(v) {
    setStockDialogError(null);
    setStockDialog({ variationId: v.id, name: v.name, stockQty: v.stockQty, delta: '', note: '' });
  }

  async function submitStockAdjust(e) {
    e.preventDefault();
    setSavingStock(true);
    setStockDialogError(null);
    try {
      await api.post('/catalog/variations/' + stockDialog.variationId + '/stock', { delta: stockDialog.delta, note: stockDialog.note });
      setToast('Stock updated.');
      setStockDialog(null);
      await load();
    } catch (err) {
      setStockDialogError(err.message);
    } finally {
      setSavingStock(false);
    }
  }

  async function confirmDeleteVariation() {
    setDeleting(true);
    try {
      await api.del('/catalog/variations/' + deleteVarTarget.id);
      setToast(deleteVarTarget.name + ' deleted.');
      setDeleteVarTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
      setDeleteVarTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  async function submitNewCategory(e) {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    setAddingCategory(true);
    try {
      const created = await api.post('/catalog/categories', { name: newCategoryName.trim() });
      setCategories(categories.concat([created]).sort((a, b) => a.name.localeCompare(b.name)));
      setItemForm({ ...itemForm, categoryId: created.id });
      setNewCategoryName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingCategory(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="catalog-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search items, categories, variations…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNewItem}>Add item</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th /><th>Item</th><th>Category</th><th>Variations</th><th>Stock</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {visibleItems.map((item) => (
            <Fragment key={item.id}>
              <tr className="catalog-item-row" onClick={() => toggleExpanded(item.id)}>
                <td className="catalog-chevron-cell">
                  <span className={'catalog-chevron ' + (expanded[item.id] ? 'catalog-chevron-open' : '')}>›</span>
                </td>
                <td>
                  <div style={{ fontWeight: 600 }}>{item.name}</div>
                  <div className="catalog-description">{item.description || '—'}</div>
                </td>
                <td>{item.categoryName}</td>
                <td>{item.variations.length}</td>
                <td>{item.variations.reduce((sum, v) => sum + v.stockQty, 0).toLocaleString()}</td>
                <td><span className={'tag ' + (item.active ? 'tag-neutral' : 'tag-accent')}>{statusLabel(item.active)}</span></td>
                <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                  {canManage && <button type="button" className="btn btn-secondary catalog-row-btn" onClick={() => openEditItem(item)}>Edit</button>}
                  {canManage && (
                    <button type="button" className="btn btn-secondary catalog-row-btn" disabled={busyId === item.id} onClick={() => toggleItemActive(item)}>
                      {item.active ? 'Archive' : 'Unarchive'}
                    </button>
                  )}
                  {canManage && <button type="button" className="btn btn-secondary catalog-row-btn" onClick={() => setDeleteItemTarget(item)}>Delete</button>}
                </td>
              </tr>
              {expanded[item.id] && (
                <tr>
                  <td />
                  <td colSpan={6} className="catalog-variations-cell">
                    <table className="table catalog-variations-table">
                      <thead>
                        <tr><th>Variation</th><th>Code</th><th>Unit</th><th>Unit price</th><th>Cost price</th><th>Stock</th><th>Status</th><th /></tr>
                      </thead>
                      <tbody>
                        {item.variations.map((v) => (
                          <tr key={v.id}>
                            <td>{v.name}</td>
                            <td>{v.code}</td>
                            <td>{v.unit}</td>
                            <td>GHS {v.unitPrice.toLocaleString()}</td>
                            <td>GHS {v.costPrice.toLocaleString()}</td>
                            <td>{v.stockQty.toLocaleString()} {v.unit !== 'each' ? v.unit : ''}</td>
                            <td><span className={'tag ' + (v.active ? 'tag-neutral' : 'tag-accent')}>{statusLabel(v.active)}</span></td>
                            <td className="table-actions">
                              {canManage && <button type="button" className="btn btn-secondary catalog-row-btn" onClick={() => openStockDialog(v)}>Adjust stock</button>}
                              {canManage && <button type="button" className="btn btn-secondary catalog-row-btn" onClick={() => openEditVariation(item.id, v)}>Edit</button>}
                              {canManage && (
                                <button type="button" className="btn btn-secondary catalog-row-btn" disabled={busyId === v.id} onClick={() => toggleVariationActive(v)}>
                                  {v.active ? 'Archive' : 'Unarchive'}
                                </button>
                              )}
                              {canManage && item.variations.length > 1 && (
                                <button type="button" className="btn btn-secondary catalog-row-btn" onClick={() => setDeleteVarTarget(v)}>Delete</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {canManage && <button type="button" className="btn btn-secondary catalog-add-variation" onClick={() => openNewVariation(item.id)}>+ Add variation</button>}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!items.length && <p className="table-empty">No catalogue items yet.</p>}
      {!!items.length && !visibleItems.length && <p className="table-empty">No items match "{search}".</p>}

      {itemDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setItemDialogOpen(false)}>
          <form className="dialog catalog-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleItemSubmit}>
            <h2 className="catalog-dialog-title">{editItemId ? 'Edit item' : 'Add item'}</h2>
            {itemDialogError && <div className="error-banner catalog-dialog-span">{itemDialogError}</div>}
            <div className="field catalog-dialog-span">
              <label htmlFor="cat-name">Item name</label>
              <input id="cat-name" className="input" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} required />
            </div>
            <div className="field catalog-dialog-span">
              <label htmlFor="cat-desc">Description</label>
              <textarea id="cat-desc" className="input" value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} />
            </div>
            <div className="field catalog-dialog-span">
              <label htmlFor="cat-category">Category</label>
              <div className="catalog-category-row">
                <select id="cat-category" className="input" value={itemForm.categoryId} onChange={(e) => setItemForm({ ...itemForm, categoryId: e.target.value })}>
                  <option value="">No category</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input className="input" placeholder="New category name" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} />
                <button type="button" className="btn btn-secondary" disabled={addingCategory} onClick={submitNewCategory}>Add</button>
              </div>
            </div>
            {canSeeTaxRates && (
              <div className="field catalog-dialog-span">
                <label htmlFor="cat-tax">Tax rate</label>
                <select id="cat-tax" className="input" value={itemForm.taxRateId} onChange={(e) => setItemForm({ ...itemForm, taxRateId: e.target.value })}>
                  <option value="">Default</option>
                  {taxRates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.rate}%)</option>)}
                </select>
              </div>
            )}
            {!editItemId && (
              <>
                <p className="catalog-dialog-span catalog-first-variation-note">Every item needs at least one variation — add more later from the item's row.</p>
                <div className="field">
                  <label htmlFor="cat-var-name">Variation name</label>
                  <input id="cat-var-name" className="input" placeholder="Regular" value={itemForm.variationName} onChange={(e) => setItemForm({ ...itemForm, variationName: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-code">Code</label>
                  <input id="cat-code" className="input" value={itemForm.code} onChange={(e) => setItemForm({ ...itemForm, code: e.target.value })} required />
                </div>
                <div className="field">
                  <label htmlFor="cat-unit">Unit</label>
                  <input id="cat-unit" className="input" value={itemForm.unit} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-defaultqty">Default qty</label>
                  <input id="cat-defaultqty" className="input" type="number" value={itemForm.defaultQty} onChange={(e) => setItemForm({ ...itemForm, defaultQty: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-unitprice">Unit price (GHS)</label>
                  <input id="cat-unitprice" className="input" type="number" value={itemForm.unitPrice} onChange={(e) => setItemForm({ ...itemForm, unitPrice: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-costprice">Cost price (GHS)</label>
                  <input id="cat-costprice" className="input" type="number" value={itemForm.costPrice} onChange={(e) => setItemForm({ ...itemForm, costPrice: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-stockqty">Initial stock</label>
                  <input id="cat-stockqty" className="input" type="number" value={itemForm.stockQty} onChange={(e) => setItemForm({ ...itemForm, stockQty: e.target.value })} />
                </div>
              </>
            )}
            <div className="dialog-actions catalog-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setItemDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingItem}>{editItemId ? 'Save changes' : 'Add item'}</button>
            </div>
          </form>
        </div>
      )}

      {varDialog && (
        <div className="dialog-backdrop" onClick={() => setVarDialog(null)}>
          <form className="dialog catalog-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleVariationSubmit}>
            <h2 className="catalog-dialog-title">{varDialog.editId ? 'Edit variation' : 'Add variation'}</h2>
            {varDialogError && <div className="error-banner catalog-dialog-span">{varDialogError}</div>}
            <div className="field">
              <label htmlFor="var-name">Variation name</label>
              <input id="var-name" className="input" placeholder="Regular" value={varDialog.form.name} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, name: e.target.value } })} />
            </div>
            <div className="field">
              <label htmlFor="var-code">Code</label>
              <input id="var-code" className="input" value={varDialog.form.code} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, code: e.target.value } })} required />
            </div>
            <div className="field">
              <label htmlFor="var-unit">Unit</label>
              <input id="var-unit" className="input" value={varDialog.form.unit} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, unit: e.target.value } })} />
            </div>
            <div className="field">
              <label htmlFor="var-defaultqty">Default qty</label>
              <input id="var-defaultqty" className="input" type="number" value={varDialog.form.defaultQty} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, defaultQty: e.target.value } })} />
            </div>
            <div className="field">
              <label htmlFor="var-unitprice">Unit price (GHS)</label>
              <input id="var-unitprice" className="input" type="number" value={varDialog.form.unitPrice} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, unitPrice: e.target.value } })} />
            </div>
            <div className="field">
              <label htmlFor="var-costprice">Cost price (GHS)</label>
              <input id="var-costprice" className="input" type="number" value={varDialog.form.costPrice} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, costPrice: e.target.value } })} />
            </div>
            {!varDialog.editId && (
              <div className="field">
                <label htmlFor="var-stockqty">Initial stock</label>
                <input id="var-stockqty" className="input" type="number" value={varDialog.form.stockQty} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, stockQty: e.target.value } })} />
              </div>
            )}
            <div className="dialog-actions catalog-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setVarDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingVar}>{varDialog.editId ? 'Save changes' : 'Add variation'}</button>
            </div>
          </form>
        </div>
      )}

      {stockDialog && (
        <div className="dialog-backdrop" onClick={() => setStockDialog(null)}>
          <form className="dialog catalog-stock-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitStockAdjust}>
            <h2 className="catalog-dialog-title">Adjust stock — {stockDialog.name}</h2>
            {stockDialogError && <div className="error-banner">{stockDialogError}</div>}
            <p className="catalog-stock-current">Currently in stock: <strong>{stockDialog.stockQty.toLocaleString()}</strong></p>
            <div className="field">
              <label htmlFor="stock-delta">Change (use a negative number to remove stock)</label>
              <input id="stock-delta" className="input" type="number" value={stockDialog.delta} onChange={(e) => setStockDialog({ ...stockDialog, delta: e.target.value })} placeholder="e.g. 20 or -5" required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="stock-note">Reason (optional)</label>
              <input id="stock-note" className="input" value={stockDialog.note} onChange={(e) => setStockDialog({ ...stockDialog, note: e.target.value })} placeholder="e.g. Shipment received, stocktake correction" />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStockDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingStock}>{savingStock ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {deleteItemTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteItemTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {deleteItemTarget.name}</h2>
            <p className="dialog-body">This deletes the item and all of its variations. This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteItemTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteItem}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {deleteVarTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteVarTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {deleteVarTarget.name}</h2>
            <p className="dialog-body">This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteVarTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteVariation}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
