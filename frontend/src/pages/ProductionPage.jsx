import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './ProductionPage.css';

// Ported from Bamboo OS.dc.html's production screen (screens.production
// block + the rawBatches/warehouses/productionBatches computed values,
// and the shared supplier/warehouse/product dialogs around its render()).
// Two fields the prototype tracks but never exposes a control for:
// rbUnit (always 'kg' on create, silently carried through on edit) and
// the production batch's line ('Weaving Line', hardcoded) and notes
// (always empty) — this port keeps that exact behavior rather than adding
// controls the design never had.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY_RAW_BATCH_FORM = { species: '', supplierId: '', quantity: '', grade: 'B', cost: '', warehouseId: '', unit: 'kg' };
const EMPTY_WAREHOUSE_FORM = { name: '', location: '', capacity: '' };
const EMPTY_SUPPLIER_FORM = { name: '', contactPerson: '', phone: '', email: '', address: '', materialsSupplied: '' };
const EMPTY_PRODUCTION_FORM = { rawBatchId: '', outputProductId: '', inputQty: '', outputQty: '', wasteQty: '', rejectedQty: '' };
const EMPTY_PRODUCT_FORM = { sku: '', name: '', category: '', unit: '', costPrice: '', sellingPrice: '', currentStock: '', reorderLevel: '' };

export default function ProductionPage() {
  const { can } = useAuth();
  const canProduction = can('production.manage');
  const canWarehouse = can('warehouse.manage');
  const canSupplier = can('supplier.manage');
  const canInventory = can('inventory.manage');

  const [rawBatches, setRawBatches] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [productionBatches, setProductionBatches] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const rawBatchFormRef = useRef(null);

  const [rbForm, setRbForm] = useState(EMPTY_RAW_BATCH_FORM);
  const [rbEditId, setRbEditId] = useState(null);
  const [rbSaving, setRbSaving] = useState(false);

  const [whDialogOpen, setWhDialogOpen] = useState(false);
  const [whEditId, setWhEditId] = useState(null);
  const [whForm, setWhForm] = useState(EMPTY_WAREHOUSE_FORM);
  const [whDialogError, setWhDialogError] = useState(null);
  const [whSaving, setWhSaving] = useState(false);
  const [whDeleteTarget, setWhDeleteTarget] = useState(null);
  const [whDeleting, setWhDeleting] = useState(false);

  const [supDialogOpen, setSupDialogOpen] = useState(false);
  const [supForm, setSupForm] = useState(EMPTY_SUPPLIER_FORM);
  const [supDialogError, setSupDialogError] = useState(null);
  const [supSaving, setSupSaving] = useState(false);

  const [pbForm, setPbForm] = useState(EMPTY_PRODUCTION_FORM);
  const [pbSaving, setPbSaving] = useState(false);

  const [prodDialogOpen, setProdDialogOpen] = useState(false);
  const [prodEditId, setProdEditId] = useState(null);
  const [prodForm, setProdForm] = useState(EMPTY_PRODUCT_FORM);
  const [prodDialogError, setProdDialogError] = useState(null);
  const [prodSaving, setProdSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rb, wh, pb] = await Promise.all([
        api.get('/raw-batches'), api.get('/warehouses'), api.get('/production')
      ]);
      setRawBatches(rb);
      setWarehouses(wh);
      setProductionBatches(pb);
      // Suppliers/products only feed the create forms below, which are
      // themselves gated on production.manage — skip fetching them for a
      // read-only viewer who may not hold supplier.read/inventory.read.
      if (canProduction) {
        const [sup, prod] = await Promise.all([api.get('/suppliers'), api.get('/products')]);
        setSuppliers(sup);
        setProducts(prod);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canProduction]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- raw batches ---
  function openNewRawBatch() {
    setRbEditId(null);
    setRbForm((f) => ({ ...f, species: '', quantity: '', cost: '' }));
    if (rawBatchFormRef.current) rawBatchFormRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function openEditRawBatch(r) {
    setRbEditId(r.id);
    setRbForm({ species: r.species, supplierId: r.supplierId, quantity: r.quantity, grade: r.qualityGrade, cost: r.cost, warehouseId: r.warehouseId, unit: r.unit });
    if (rawBatchFormRef.current) rawBatchFormRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function cancelRawBatchEdit() {
    setRbEditId(null);
    setRbForm((f) => ({ ...f, species: '', quantity: '', cost: '' }));
  }

  async function submitRawBatch(e) {
    e.preventDefault();
    setRbSaving(true);
    setError(null);
    try {
      const payload = { species: rbForm.species, supplierId: rbForm.supplierId, quantity: rbForm.quantity, unit: rbForm.unit, qualityGrade: rbForm.grade, cost: rbForm.cost, warehouseId: rbForm.warehouseId };
      const r = rbEditId ? await api.put('/raw-batches/' + rbEditId, payload) : await api.post('/raw-batches', payload);
      setToast(rbEditId ? 'Updated batch ' + r.batchNo + '.' : 'Received ' + r.batchNo + '.');
      setRbEditId(null);
      setRbForm((f) => ({ ...f, species: '', quantity: '', cost: '' }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRbSaving(false);
    }
  }

  // --- warehouses ---
  function openNewWarehouse() {
    setWhDialogError(null);
    setWhEditId(null);
    setWhForm(EMPTY_WAREHOUSE_FORM);
    setWhDialogOpen(true);
  }

  function openEditWarehouse(w) {
    setWhDialogError(null);
    setWhEditId(w.id);
    setWhForm({ name: w.name, location: w.location, capacity: w.capacity });
    setWhDialogOpen(true);
  }

  async function submitWarehouse(e) {
    e.preventDefault();
    setWhSaving(true);
    setWhDialogError(null);
    try {
      if (whEditId) await api.put('/warehouses/' + whEditId, whForm);
      else await api.post('/warehouses', whForm);
      setToast(whEditId ? 'Warehouse updated.' : 'Warehouse added.');
      setWhDialogOpen(false);
      await load();
    } catch (err) {
      setWhDialogError(err.message);
    } finally {
      setWhSaving(false);
    }
  }

  async function confirmDeleteWarehouse() {
    setWhDeleting(true);
    try {
      await api.del('/warehouses/' + whDeleteTarget.id);
      setToast(whDeleteTarget.name + ' deleted.');
      setWhDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setWhDeleting(false);
    }
  }

  // --- suppliers (create-only, reachable from the raw batch form) ---
  function openNewSupplier() {
    setSupDialogError(null);
    setSupForm(EMPTY_SUPPLIER_FORM);
    setSupDialogOpen(true);
  }

  async function submitSupplier(e) {
    e.preventDefault();
    setSupSaving(true);
    setSupDialogError(null);
    try {
      await api.post('/suppliers', supForm);
      setToast('Supplier added.');
      setSupDialogOpen(false);
      await load();
    } catch (err) {
      setSupDialogError(err.message);
    } finally {
      setSupSaving(false);
    }
  }

  // --- products (create/edit, reachable from the production batch form) ---
  function openNewProduct() {
    setProdDialogError(null);
    setProdEditId(null);
    setProdForm(EMPTY_PRODUCT_FORM);
    setProdDialogOpen(true);
  }

  function editSelectedProduct() {
    const p = products.find((x) => x.id === pbForm.outputProductId);
    if (!p) { setToast('Pick a product first.'); return; }
    setProdDialogError(null);
    setProdEditId(p.id);
    setProdForm({ sku: p.sku, name: p.name, category: p.category, unit: p.unit, costPrice: p.costPrice, sellingPrice: p.sellingPrice, currentStock: p.currentStock, reorderLevel: p.reorderLevel });
    setProdDialogOpen(true);
  }

  async function submitProduct(e) {
    e.preventDefault();
    setProdSaving(true);
    setProdDialogError(null);
    try {
      const r = prodEditId ? await api.put('/products/' + prodEditId, prodForm) : await api.post('/products', prodForm);
      setToast(prodEditId ? 'Product ' + r.sku + ' updated.' : 'Product ' + r.sku + ' added.');
      setProdDialogOpen(false);
      await load();
    } catch (err) {
      setProdDialogError(err.message);
    } finally {
      setProdSaving(false);
    }
  }

  // --- production batches ---
  async function recordProduction(e) {
    e.preventDefault();
    setPbSaving(true);
    setError(null);
    try {
      const r = await api.post('/production', {
        rawBatchId: pbForm.rawBatchId, outputProductId: pbForm.outputProductId, productionLine: 'Weaving Line',
        inputQty: pbForm.inputQty, outputQty: pbForm.outputQty, wasteQty: pbForm.wasteQty, rejectedQty: pbForm.rejectedQty, notes: ''
      });
      setToast('Batch ' + r.batchNo + ' recorded.');
      setPbForm((f) => ({ ...f, inputQty: '', outputQty: '', wasteQty: '', rejectedQty: '' }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setPbSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const inStockBatches = rawBatches.filter((r) => r.status !== 'depleted');

  return (
    <div className="production-page">
      {error && <div className="error-banner">{error}</div>}

      {canProduction && (
        <form className="card production-rb-form" ref={rawBatchFormRef} onSubmit={submitRawBatch}>
          <div className="field">
            <label htmlFor="rb-species">{rbEditId ? 'Edit raw bamboo batch · species' : 'Receive raw bamboo · species'}</label>
            <input id="rb-species" className="input" value={rbForm.species} onChange={(e) => setRbForm({ ...rbForm, species: e.target.value })} placeholder="Bambusa vulgaris" required />
          </div>
          <div className="field">
            <label htmlFor="rb-supplier">Supplier</label>
            <div className="production-inline-select">
              <select id="rb-supplier" className="input" value={rbForm.supplierId} onChange={(e) => setRbForm({ ...rbForm, supplierId: e.target.value })} required>
                <option value="" disabled>Choose a supplier</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {canSupplier && <button type="button" className="btn btn-secondary production-inline-btn" onClick={openNewSupplier}>+ New</button>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="rb-qty">Quantity</label>
            <input id="rb-qty" className="input" type="number" value={rbForm.quantity} onChange={(e) => setRbForm({ ...rbForm, quantity: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="rb-grade">Grade</label>
            <select id="rb-grade" className="input" value={rbForm.grade} onChange={(e) => setRbForm({ ...rbForm, grade: e.target.value })}>
              <option value="A">A</option><option value="B">B</option><option value="C">C</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="rb-cost">Cost (GHS)</label>
            <input id="rb-cost" className="input" type="number" value={rbForm.cost} onChange={(e) => setRbForm({ ...rbForm, cost: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="rb-warehouse">Warehouse</label>
            <div className="production-inline-select">
              <select id="rb-warehouse" className="input" value={rbForm.warehouseId} onChange={(e) => setRbForm({ ...rbForm, warehouseId: e.target.value })} required>
                <option value="" disabled>Choose a warehouse</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              {canWarehouse && <button type="button" className="btn btn-secondary production-inline-btn" onClick={openNewWarehouse}>+ New</button>}
            </div>
          </div>
          <button className="btn btn-primary production-submit-btn" type="submit" disabled={rbSaving}>{rbEditId ? 'Save changes' : 'Receive'}</button>
          {rbEditId && <button type="button" className="btn btn-secondary production-submit-btn" onClick={cancelRawBatchEdit}>Cancel edit</button>}
        </form>
      )}

      <h2 className="production-section-title">Raw bamboo in stock</h2>
      <table className="table">
        <thead>
          <tr><th>Batch</th><th>Species</th><th>Supplier</th><th>Warehouse</th><th>Quantity</th><th>Grade</th><th>Received</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {rawBatches.map((r) => (
            <tr key={r.id}>
              <td>{r.batchNo}</td>
              <td>{r.species}</td>
              <td>{r.supplierName}</td>
              <td>{r.warehouseName}</td>
              <td>{r.quantity} {r.unit}</td>
              <td>{r.qualityGrade}</td>
              <td>{fmtDate(r.dateReceived)}</td>
              <td><span className={'tag ' + (r.status === 'depleted' ? 'tag-accent' : 'tag-neutral')}>{r.status}</span></td>
              <td className="table-actions">
                {canProduction && <button type="button" className="btn btn-secondary production-row-btn" onClick={() => openEditRawBatch(r)}>Edit</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rawBatches.length && <p className="table-empty">No raw material received yet.</p>}

      <h2 className="production-section-title">Warehouses</h2>
      <table className="table">
        <thead>
          <tr><th>Name</th><th>Location</th><th>Capacity</th><th>Raw stock held</th><th /></tr>
        </thead>
        <tbody>
          {warehouses.map((w) => (
            <tr key={w.id}>
              <td style={{ fontWeight: 600 }}>{w.name}</td>
              <td>{w.location || '—'}</td>
              <td>{w.capacity || 0}</td>
              <td>{w.rawQty}</td>
              <td className="table-actions">
                {canWarehouse && <button type="button" className="btn btn-secondary production-row-btn" onClick={() => openEditWarehouse(w)}>Edit</button>}
                {canWarehouse && w.rawQty === 0 && (
                  <button type="button" className="btn btn-secondary production-row-btn" onClick={() => setWhDeleteTarget(w)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canWarehouse && <button type="button" className="btn btn-secondary" onClick={openNewWarehouse}>Add warehouse</button>}

      {canProduction && (
        <form className="card production-pb-form" onSubmit={recordProduction}>
          <div className="field">
            <label htmlFor="pb-rawbatch">Record production · raw batch</label>
            <div className="production-inline-select">
              <select id="pb-rawbatch" className="input" value={pbForm.rawBatchId} onChange={(e) => setPbForm({ ...pbForm, rawBatchId: e.target.value })} required>
                <option value="" disabled>Choose a batch</option>
                {inStockBatches.map((r) => <option key={r.id} value={r.id}>{r.batchNo} — {r.species} ({r.quantity}{r.unit})</option>)}
              </select>
              <button type="button" className="btn btn-secondary production-inline-btn" onClick={openNewRawBatch}>+ New</button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="pb-product">Output product</label>
            <div className="production-inline-select">
              <select id="pb-product" className="input" value={pbForm.outputProductId} onChange={(e) => setPbForm({ ...pbForm, outputProductId: e.target.value })} required>
                <option value="" disabled>Choose a product</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {canInventory && <button type="button" className="btn btn-secondary production-inline-btn" onClick={openNewProduct}>+ New</button>}
              {canInventory && <button type="button" className="btn btn-secondary production-inline-btn" onClick={editSelectedProduct}>Edit</button>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="pb-input">Input qty</label>
            <input id="pb-input" className="input" type="number" value={pbForm.inputQty} onChange={(e) => setPbForm({ ...pbForm, inputQty: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="pb-output">Output qty</label>
            <input id="pb-output" className="input" type="number" value={pbForm.outputQty} onChange={(e) => setPbForm({ ...pbForm, outputQty: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="pb-waste">Waste</label>
            <input id="pb-waste" className="input" type="number" value={pbForm.wasteQty} onChange={(e) => setPbForm({ ...pbForm, wasteQty: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pb-rejected">Rejected</label>
            <input id="pb-rejected" className="input" type="number" value={pbForm.rejectedQty} onChange={(e) => setPbForm({ ...pbForm, rejectedQty: e.target.value })} />
          </div>
          <button className="btn btn-primary production-submit-btn" type="submit" disabled={pbSaving}>Record batch</button>
        </form>
      )}

      <h2 className="production-section-title">Production batches</h2>
      <table className="table">
        <thead>
          <tr><th>Batch</th><th>Date</th><th>Line</th><th>Supervisor</th><th>Input</th><th>Output</th><th>Waste</th><th>Efficiency</th></tr>
        </thead>
        <tbody>
          {productionBatches.map((b) => (
            <tr key={b.id}>
              <td>{b.batchNo}</td>
              <td>{fmtDate(b.date)}</td>
              <td>{b.productionLine}</td>
              <td>{b.supervisorName}</td>
              <td>{b.inputQty}</td>
              <td>{b.outputQty} ({b.productName})</td>
              <td>{b.wasteQty}</td>
              <td>{b.efficiency}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!productionBatches.length && <p className="table-empty">No production batches recorded yet.</p>}

      {whDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setWhDialogOpen(false)}>
          <form className="dialog production-wh-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitWarehouse}>
            <h2>{whEditId ? 'Edit warehouse' : 'Add warehouse'}</h2>
            {whDialogError && <div className="error-banner">{whDialogError}</div>}
            <div className="field">
              <label htmlFor="wh-name">Warehouse name</label>
              <input id="wh-name" className="input" value={whForm.name} onChange={(e) => setWhForm({ ...whForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="wh-location">Location</label>
              <input id="wh-location" className="input" value={whForm.location} onChange={(e) => setWhForm({ ...whForm, location: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wh-capacity">Capacity</label>
              <input id="wh-capacity" className="input" type="number" value={whForm.capacity} onChange={(e) => setWhForm({ ...whForm, capacity: e.target.value })} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setWhDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={whSaving}>{whEditId ? 'Save changes' : 'Add warehouse'}</button>
            </div>
          </form>
        </div>
      )}

      {whDeleteTarget && (
        <div className="dialog-backdrop" onClick={() => setWhDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete warehouse</h2>
            <p className="dialog-body">Delete <strong>{whDeleteTarget.name}</strong>? This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setWhDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={whDeleting} onClick={confirmDeleteWarehouse}>{whDeleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {supDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setSupDialogOpen(false)}>
          <form className="dialog production-2col-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitSupplier}>
            <h2 className="production-dialog-title">Add supplier</h2>
            {supDialogError && <div className="error-banner production-dialog-span">{supDialogError}</div>}
            <div className="field production-dialog-span">
              <label htmlFor="prsup-name">Supplier name</label>
              <input id="prsup-name" className="input" value={supForm.name} onChange={(e) => setSupForm({ ...supForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prsup-contact">Contact person</label>
              <input id="prsup-contact" className="input" value={supForm.contactPerson} onChange={(e) => setSupForm({ ...supForm, contactPerson: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prsup-phone">Phone</label>
              <input id="prsup-phone" className="input" value={supForm.phone} onChange={(e) => setSupForm({ ...supForm, phone: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prsup-email">Email</label>
              <input id="prsup-email" className="input" type="email" value={supForm.email} onChange={(e) => setSupForm({ ...supForm, email: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prsup-address">Address</label>
              <input id="prsup-address" className="input" value={supForm.address} onChange={(e) => setSupForm({ ...supForm, address: e.target.value })} />
            </div>
            <div className="field production-dialog-span">
              <label htmlFor="prsup-materials">Materials supplied</label>
              <input id="prsup-materials" className="input" value={supForm.materialsSupplied} onChange={(e) => setSupForm({ ...supForm, materialsSupplied: e.target.value })} required />
            </div>
            <div className="dialog-actions production-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setSupDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={supSaving}>Add supplier</button>
            </div>
          </form>
        </div>
      )}

      {prodDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setProdDialogOpen(false)}>
          <form className="dialog production-2col-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitProduct}>
            <h2 className="production-dialog-title">{prodEditId ? 'Edit product' : 'Add product'}</h2>
            {prodDialogError && <div className="error-banner production-dialog-span">{prodDialogError}</div>}
            <div className="field">
              <label htmlFor="prprod-sku">SKU</label>
              <input id="prprod-sku" className="input" value={prodForm.sku} onChange={(e) => setProdForm({ ...prodForm, sku: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prprod-name">Name</label>
              <input id="prprod-name" className="input" value={prodForm.name} onChange={(e) => setProdForm({ ...prodForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prprod-category">Category</label>
              <input id="prprod-category" className="input" value={prodForm.category} onChange={(e) => setProdForm({ ...prodForm, category: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prprod-unit">Unit</label>
              <input id="prprod-unit" className="input" value={prodForm.unit} onChange={(e) => setProdForm({ ...prodForm, unit: e.target.value })} placeholder="piece, plank, pack" />
            </div>
            <div className="field">
              <label htmlFor="prprod-cost">Cost price</label>
              <input id="prprod-cost" className="input" type="number" value={prodForm.costPrice} onChange={(e) => setProdForm({ ...prodForm, costPrice: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prprod-price">Selling price</label>
              <input id="prprod-price" className="input" type="number" value={prodForm.sellingPrice} onChange={(e) => setProdForm({ ...prodForm, sellingPrice: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prprod-stock">Opening stock</label>
              <input id="prprod-stock" className="input" type="number" value={prodForm.currentStock} onChange={(e) => setProdForm({ ...prodForm, currentStock: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prprod-reorder">Reorder level</label>
              <input id="prprod-reorder" className="input" type="number" value={prodForm.reorderLevel} onChange={(e) => setProdForm({ ...prodForm, reorderLevel: e.target.value })} />
            </div>
            <div className="dialog-actions production-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setProdDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={prodSaving}>{prodEditId ? 'Save changes' : 'Add product'}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
