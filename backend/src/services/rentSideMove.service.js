var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { bplScopeClause } = require('../utils/documents');
var poki = require('./poki.service');

// Rent-side invoices that ended up in Bamboo Products' own invoices — CAM
// (service charge) and water & power fees, mostly brought in from Square
// before Poki had its own books — fished out and moved to Poki's Rent &
// utilities, where they belong.
//
// Nothing moves by itself: candidates() finds them and suggests what each
// is; a person ticks which to move and confirms the kind; move() moves
// those. Each invoice keeps its number, lines, payments and receipts; it
// changes company (Poki), kind (CAM / water & power / rent / other) and,
// where needed, customer: the customer becomes a Poki tenant — the same
// record when everything they have with Bamboo Products is rent-side,
// otherwise a Poki copy, so their bamboo purchases stay where they are.

var WORDS = {
  utility: /(water|power|electric|utilit|\becg\b|light bill|prepaid|meter)/i,
  cam: /(\bcam\b|service charge|common area|maintenance fee|security fee)/i,
  rent: /\brent\b|\brental\b/i
};
var KINDS = ['cam', 'utility', 'rent', 'other'];

function guessKind(text) {
  var hits = Object.keys(WORDS).filter(function (k) { return WORDS[k].test(text); });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return 'other';
  return null; // a Square repeat invoice with no words to go on
}

function canMove(ctx) {
  poki.canManage(ctx);
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
}

function digits(p) { var d = String(p || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; }

async function candidates(ctx) {
  canMove(ctx);
  var pokiId = await poki.pokiCompanyId();
  var rows = (await pool.query(
    'SELECT i.id, i.invoice_no, i.customer_id, i.grand_total, i.balance_due, i.status, i.issued_at, i.currency, ' +
    "       c.name AS customer_name, c.phone, c.email, string_agg(coalesce(l.description, '') || ' ' || coalesce(l.notes, ''), ' | ' ORDER BY l.sort_order) AS lines " +
    'FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    "LEFT JOIN document_line_items l ON l.document_type = 'invoice' AND l.document_id = i.id " +
    'WHERE ' + bplScopeClause('i') + " AND i.status <> 'void' " +
    'GROUP BY i.id, c.id ' +
    "HAVING i.invoice_no ~ '-R-[0-9]+$' OR string_agg(coalesce(l.description, '') || ' ' || coalesce(l.notes, ''), ' ') ~* " +
    "'(\\mcam\\M|service charge|common area|maintenance fee|security fee|water|power|electric|utilit|\\mecg\\M|light bill|prepaid|meter|\\mrent\\M|\\mrental\\M)' " +
    'ORDER BY c.name, i.issued_at')).rows;

  var tenants = (await pool.query(
    'SELECT t.id, c.name, c.phone FROM poki_tenants t JOIN customers c ON c.id = t.customer_id WHERE c.company_id = $1', [pokiId])).rows;

  var groups = {};
  rows.forEach(function (r) {
    var g = groups[r.customer_id];
    if (!g) {
      var match = tenants.find(function (t) {
        return t.name.trim().toLowerCase() === r.customer_name.trim().toLowerCase() || (digits(t.phone) && digits(t.phone) === digits(r.phone));
      });
      g = groups[r.customer_id] = {
        customerId: r.customer_id, customerName: r.customer_name, phone: r.phone || '', email: r.email || '',
        matchTenantId: match ? match.id : null, matchTenantName: match ? match.name : null,
        invoices: [], kinds: {}
      };
    }
    var kind = guessKind(r.lines || '');
    if (kind) g.kinds[kind] = (g.kinds[kind] || 0) + 1;
    g.invoices.push({
      id: r.id, invoiceNo: r.invoice_no, issuedAt: r.issued_at, status: r.status, currency: r.currency,
      grandTotal: Number(r.grand_total), balanceDue: Number(r.balance_due),
      lines: String(r.lines || '').replace(/\s+\|/g, ' |').trim().slice(0, 160), kind: kind
    });
  });
  return Object.keys(groups).map(function (k) {
    var g = groups[k];
    var ks = Object.keys(g.kinds);
    g.suggestedKind = ks.length === 1 ? ks[0] : ks.length ? 'other' : null;
    delete g.kinds;
    g.total = g.invoices.reduce(function (s, i) { return s + i.grandTotal; }, 0);
    g.owed = g.invoices.reduce(function (s, i) { return s + i.balanceDue; }, 0);
    return g;
  });
}

// groups: [{ customerId, invoiceIds, kind, tenantId? }]
async function move(ctx, p) {
  canMove(ctx);
  var groups = (p && Array.isArray(p.groups)) ? p.groups : [];
  if (!groups.length) fail('invalid', 'Tick the invoices to move.');
  var pokiId = await poki.pokiCompanyId();
  if (!pokiId) fail('conflict', 'Poki is not set up as a company yet.');

  return withTransaction(async function (client) {
    var moved = 0, tenantsMade = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var ids = Array.isArray(g.invoiceIds) ? g.invoiceIds.filter(Boolean) : [];
      if (!ids.length) continue;
      var chosen = KINDS.indexOf(g.kind) >= 0 ? g.kind : null;
      var invs = (await client.query(
        'SELECT i.* FROM invoices i WHERE i.id = ANY($1::uuid[]) AND i.customer_id = $2 AND ' + bplScopeClause('i') + " AND i.status <> 'void' FOR UPDATE",
        [ids, g.customerId])).rows;
      if (invs.length !== ids.length) fail('conflict', 'Some of those invoices have changed or moved already. Reload and try again.');
      // Each invoice keeps what its own lines say (CAM, water & power…);
      // the person's choice is for the ones that don't say (Square's
      // "Square invoice 000609-R-0009").
      var lineText = (await client.query(
        "SELECT document_id, string_agg(coalesce(description, '') || ' ' || coalesce(notes, ''), ' ') AS t FROM document_line_items " +
        "WHERE document_type = 'invoice' AND document_id = ANY($1::uuid[]) GROUP BY document_id", [ids])).rows;
      var kindOf = {};
      lineText.forEach(function (r) { kindOf[r.document_id] = guessKind(r.t || ''); });
      if (invs.some(function (i) { return !kindOf[i.id]; }) && !chosen) {
        fail('invalid', 'Say what ' + (await client.query('SELECT name FROM customers WHERE id = $1', [g.customerId])).rows[0].name + '\'s invoices are: some of them do not say.');
      }
      var cust = (await client.query('SELECT * FROM customers WHERE id = $1', [g.customerId])).rows[0];

      // Who the tenant is on Poki's side.
      var target;
      if (g.tenantId) {
        var t = (await client.query('SELECT t.customer_id FROM poki_tenants t JOIN customers c ON c.id = t.customer_id WHERE t.id = $1 AND c.company_id = $2', [g.tenantId, pokiId])).rows[0];
        if (!t) fail('invalid', 'That Poki tenant no longer exists. Reload and try again.');
        target = t.customer_id;
      } else {
        // Does the customer have anything else with Bamboo Products?
        var other = (await client.query(
          "SELECT (SELECT count(*) FROM invoices WHERE customer_id = $1 AND status <> 'void' AND NOT (id = ANY($2::uuid[]))) + " +
          '       (SELECT count(*) FROM quotations WHERE customer_id = $1) + (SELECT count(*) FROM sales_orders WHERE customer_id = $1) + ' +
          '       (SELECT count(*) FROM estimates WHERE customer_id = $1 AND company_id IS DISTINCT FROM $3) AS n',
          [g.customerId, ids, pokiId])).rows[0].n;
        if (Number(other) === 0) {
          await client.query('UPDATE customers SET company_id = $1 WHERE id = $2', [pokiId, g.customerId]);
          target = g.customerId;
        } else {
          target = (await client.query(
            'INSERT INTO customers (name, contact_person, email, phone, address, billing_address, category, status, notes, preferred_currency, company_id) ' +
            "VALUES ($1,$2,$3,$4,$5,$6,'active','active',$7,$8,$9) RETURNING id",
            [cust.name, cust.contact_person, cust.email, cust.phone, cust.address, cust.billing_address,
              'Tenant record made when rent-side invoices moved from Bamboo Products.', cust.preferred_currency || 'GHS', pokiId])).rows[0].id;
        }
        var has = (await client.query('SELECT id FROM poki_tenants WHERE customer_id = $1', [target])).rows[0];
        if (!has) {
          var company = /\b(ltd|limited|company|co\.|enterprise|ventures|services|shop|store|auto|restaurant|bar|hotel|plc)\b/i.test(cust.name);
          await client.query(
            'INSERT INTO poki_tenants (customer_id, tenant_type, id_type, id_number, occupation, employer, emergency_contact_name, emergency_contact_phone, next_of_kin_name, next_of_kin_phone, onboarded_on, status, notes) ' +
            "VALUES ($1, $2, '', '', '', '', '', '', '', '', CURRENT_DATE, 'active', 'Added when their rent-side invoices moved from Bamboo Products.')",
            [target, company ? 'company' : 'individual']);
          tenantsMade++;
        }
      }

      for (var ii = 0; ii < invs.length; ii++) {
        await client.query('UPDATE invoices SET company_id = $1, doc_kind = $2, customer_id = $3 WHERE id = $4', [pokiId, kindOf[invs[ii].id] || chosen, target, invs[ii].id]);
      }
      if (target !== g.customerId) {
        for (var tbl of ['payments', 'receipts', 'payment_reminders', 'credit_notes']) {
          await client.query('UPDATE ' + tbl + ' SET customer_id = $1 WHERE invoice_id = ANY($2::uuid[])', [target, ids]);
        }
      }
      await audit(client, ctx, 'invoice.move_to_poki', 'customer', g.customerId,
        'Moved ' + invs.length + ' invoice(s) of ' + cust.name + ' to Poki: ' + invs.map(function (i) { return i.invoice_no + ' (' + (kindOf[i.id] || chosen) + ')'; }).join(', ') + '.');
      moved += invs.length;
    }
    return { moved: moved, tenantsMade: tenantsMade };
  });
}

module.exports = { candidates: candidates, move: move, guessKind: guessKind };
