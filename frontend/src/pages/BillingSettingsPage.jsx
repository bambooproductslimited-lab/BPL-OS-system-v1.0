import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './BillingSettingsPage.css';

// Ported from Bamboo OS.dc.html's billing settings screen
// (screens.billingsettings block + saveBillingSettings/addTaxRate
// handlers), backed by GET/PATCH /api/commercial-settings and
// POST /api/commercial-settings/tax-rates (all require settings.manage —
// same permission that gates this screen in navModel.js, so unlike
// Catalog's tax-rate field there is no viewer who can reach this page
// without also being able to fetch its data).

// Redesigned lightly: this page is settings forms plus two small reference
// tables (document numbering, tax rates) with no natural icon dimension,
// so the addition here is a small icon accent on each section header, for
// visual consistency with the rest of the redesigned app.

const ICON_PATHS = {
  document: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  cash: <><rect x="2.5" y="6" width="19" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" /></>,
  hash: <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  receipt: <><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4v-17Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

const EMPTY = {
  quotationIntro: '', quotationFooter: '', invoiceFooter: '', paymentTerms: '', terms: '', validityDays: '', invoiceDueDays: '',
  bankName: '', accountName: '', accountNumber: '', branch: '', swift: '', momoProvider: '', momoNumber: '', instructions: ''
};

export default function BillingSettingsPage() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(false);

  const [taxName, setTaxName] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [addingTax, setAddingTax] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.get('/commercial-settings');
      setSettings(s);
      setForm({
        quotationIntro: s.templates.quotationIntro, quotationFooter: s.templates.quotationFooter, invoiceFooter: s.templates.invoiceFooter,
        paymentTerms: s.templates.paymentTerms, terms: s.templates.termsAndConditions, validityDays: s.templates.validityDays, invoiceDueDays: s.templates.invoiceDueDays,
        bankName: s.paymentDetails.bankName, accountName: s.paymentDetails.accountName, accountNumber: s.paymentDetails.accountNumber,
        branch: s.paymentDetails.branch, swift: s.paymentDetails.swift, momoProvider: s.paymentDetails.momoProvider,
        momoNumber: s.paymentDetails.momoNumber, instructions: s.paymentDetails.instructions
      });
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
    setSaving(true);
    setError(null);
    try {
      await api.patch('/commercial-settings', {
        templates: {
          quotationIntro: form.quotationIntro, quotationFooter: form.quotationFooter, invoiceFooter: form.invoiceFooter,
          paymentTerms: form.paymentTerms, termsAndConditions: form.terms, validityDays: Number(form.validityDays) || 14, invoiceDueDays: Number(form.invoiceDueDays) || 30
        },
        paymentDetails: {
          bankName: form.bankName, accountName: form.accountName, accountNumber: form.accountNumber, branch: form.branch,
          swift: form.swift, momoProvider: form.momoProvider, momoNumber: form.momoNumber, instructions: form.instructions
        }
      });
      setToast('Billing settings saved.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddTaxRate(e) {
    e.preventDefault();
    setAddingTax(true);
    setError(null);
    try {
      await api.post('/commercial-settings/tax-rates', { name: taxName, rate: taxRate });
      setToast('Tax rate added.');
      setTaxName('');
      setTaxRate('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingTax(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (!settings) return <div className="error-banner">{error}</div>;

  const numberingList = Object.keys(settings.numbering).map((k) => {
    const n = settings.numbering[k];
    return { doc: k.charAt(0).toUpperCase() + k.slice(1), format: n.prefix + '-' + (n.includeYear ? new Date().getFullYear() + '-' : '') + String(n.nextNumber).padStart(n.padding, '0') };
  });

  return (
    <div className="bs">
      {error && <div className="error-banner">{error}</div>}

      <form className="bs-form" onSubmit={handleSubmit}>
        <section className="bs-section">
          <h2 className="bs-section-title"><span className="bs-section-icon"><Icon name="document" /></span>Document templates & defaults</h2>
          <div className="field">
            <label htmlFor="bs-qi">Quotation introduction</label>
            <textarea id="bs-qi" className="input" value={form.quotationIntro} onChange={(e) => setForm({ ...form, quotationIntro: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-qf">Quotation footer</label>
            <textarea id="bs-qf" className="input" value={form.quotationFooter} onChange={(e) => setForm({ ...form, quotationFooter: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-if">Invoice footer</label>
            <textarea id="bs-if" className="input" value={form.invoiceFooter} onChange={(e) => setForm({ ...form, invoiceFooter: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-pt">Default payment terms</label>
            <input id="bs-pt" className="input" value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} />
          </div>
          <div className="field bs-span">
            <label htmlFor="bs-terms">Terms & conditions</label>
            <textarea id="bs-terms" className="input" value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-vd">Default quotation validity (days)</label>
            <input id="bs-vd" className="input" type="number" value={form.validityDays} onChange={(e) => setForm({ ...form, validityDays: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-dd">Default invoice due period (days)</label>
            <input id="bs-dd" className="input" type="number" value={form.invoiceDueDays} onChange={(e) => setForm({ ...form, invoiceDueDays: e.target.value })} />
          </div>
        </section>

        <section className="bs-section">
          <h2 className="bs-section-title"><span className="bs-section-icon"><Icon name="cash" /></span>Payment details shown on invoices</h2>
          <div className="field">
            <label htmlFor="bs-bn">Bank name</label>
            <input id="bs-bn" className="input" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-an">Account name</label>
            <input id="bs-an" className="input" value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-acc">Account number</label>
            <input id="bs-acc" className="input" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-br">Branch</label>
            <input id="bs-br" className="input" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-sw">SWIFT</label>
            <input id="bs-sw" className="input" value={form.swift} onChange={(e) => setForm({ ...form, swift: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-mp">Mobile Money provider</label>
            <input id="bs-mp" className="input" value={form.momoProvider} onChange={(e) => setForm({ ...form, momoProvider: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bs-mn">Mobile Money number</label>
            <input id="bs-mn" className="input" value={form.momoNumber} onChange={(e) => setForm({ ...form, momoNumber: e.target.value })} />
          </div>
          <div className="field bs-span">
            <label htmlFor="bs-inst">Payment instructions</label>
            <input id="bs-inst" className="input" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
          </div>
        </section>

        <button className="btn btn-primary bs-save" type="submit" disabled={saving}>Save settings</button>
      </form>

      <section className="bs-narrow">
        <h2 className="bs-section-title"><span className="bs-section-icon"><Icon name="hash" /></span>Document numbering</h2>
        <table className="table">
          <thead><tr><th>Document</th><th>Next number</th></tr></thead>
          <tbody>
            {numberingList.map((n) => <tr key={n.doc}><td>{n.doc}</td><td className="bs-numbering-format">{n.format}</td></tr>)}
          </tbody>
        </table>
      </section>

      <section className="bs-narrow">
        <h2 className="bs-section-title"><span className="bs-section-icon"><Icon name="receipt" /></span>Tax rates</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>Rate</th></tr></thead>
          <tbody>
            {settings.taxRates.map((t) => <tr key={t.id}><td>{t.name}</td><td>{t.rate}%</td></tr>)}
          </tbody>
        </table>
        <form className="bs-tax-form" onSubmit={handleAddTaxRate}>
          <div className="field bs-tax-name">
            <label htmlFor="bs-taxname">New tax name</label>
            <input id="bs-taxname" className="input" value={taxName} onChange={(e) => setTaxName(e.target.value)} required />
          </div>
          <div className="field bs-tax-rate">
            <label htmlFor="bs-taxrate">Rate %</label>
            <input id="bs-taxrate" className="input" type="number" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} required />
          </div>
          <button className="btn btn-secondary" type="submit" disabled={addingTax}>Add</button>
        </form>
      </section>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
