/*
 * Amazon transaction report parser — browser edition.
 *
 * Direct port of the Python parser. Same rules, same buckets, same
 * reconciliation guarantee: every monetary cell is allocated to exactly one
 * bucket, and the sum of allocations must equal the sum of the report's own
 * `total` column. A non-zero residual is surfaced, never swallowed.
 *
 * Runs in the browser with no dependencies, and under Node for the test suite.
 */
(function (root) {
  "use strict";

  /* ---------------------------------------------------------------- buckets */
  const REVENUE = "revenue", COGS_VARIABLE = "cogs_variable", INVENTORY = "inventory",
        LOGISTICS = "logistics", OPEX = "opex", PASSTHROUGH = "passthrough", CASH = "cash";

  const BUCKETS = {
    product_sales:      ["Product sales (ex-tax)",        REVENUE, 10],
    promo_rebates:      ["Promotional rebates",           REVENUE, 11],
    shipping_credits:   ["Shipping / postage credits",    REVENUE, 12],
    giftwrap_credits:   ["Gift wrap credits",             REVENUE, 13],
    regulatory_fee:     ["Regulatory fee collected",      REVENUE, 14],
    product_refunds:    ["Product sale refunds",          REVENUE, 15],

    referral_fees:      ["Referral / selling fees",       COGS_VARIABLE, 20],
    fulfillment:        ["Fulfillment fees",              COGS_VARIABLE, 21],
    other_txn_fees:     ["Other per-order txn fees",      COGS_VARIABLE, 22],

    fba_storage:        ["FBA storage fees",              INVENTORY, 30],
    fba_storage_lt:     ["FBA long-term storage fees",    INVENTORY, 31],
    storage_correction: ["Storage fee corrections",       INVENTORY, 32],
    awd_storage:        ["AWD storage fees",              INVENTORY, 33],
    awd_fees:           ["AWD processing / transport",    INVENTORY, 34],
    removals:           ["Removal & disposal orders",     INVENTORY, 35],
    reimbursements:     ["Inventory reimbursements",      INVENTORY, 36],

    freight:            ["International freight",         LOGISTICS, 40],
    tariffs:            ["Duties & tariffs",              LOGISTICS, 41],
    inbound_placement:  ["Inbound placement service fee", LOGISTICS, 42],
    partnered_carrier:  ["Partnered carrier (inbound)",   LOGISTICS, 43],

    advertising:        ["Advertising",                   OPEX, 50],
    subscription:       ["Seller subscription",           OPEX, 51],
    service_fee_other:  ["Other service fees",            OPEX, 52],
    retrocharge:        ["Order retrocharges",            OPEX, 53],
    chargebacks:        ["Chargebacks / guarantee claims", OPEX, 54],
    liquidations:       ["Liquidations",                  OPEX, 55],

    tax:                ["Tax collected & withheld",      PASSTHROUGH, 60],
    debt_recovery:      ["Debt recovery",                 CASH, 70],
    transfers:          ["Bank transfers",                CASH, 71],

    unclassified:       ["UNMAPPED - needs a rule",       OPEX, 99],
  };

  const GROUP_LABELS = {
    revenue: "Revenue", cogs_variable: "Variable selling cost",
    inventory: "Inventory carrying cost", logistics: "Inbound logistics",
    opex: "Operating", passthrough: "Pass-through", cash: "Cash movement",
  };

  // Catch-alls rather than specific rules. Counted in every total, but listed
  // for review so a fee type Amazon invents gets named rather than absorbed.
  const REVIEW_BUCKETS = new Set(["unclassified", "service_fee_other"]);
  const SHIPMENT_BUCKETS = new Set(["freight", "tariffs", "inbound_placement", "partnered_carrier"]);
  const CHANNEL_BUCKETS = new Set(["fulfillment", "product_sales", "referral_fees", "product_refunds"]);

  // Referral is reported rolled into fulfillment; both lines are still kept.
  const COMBINED_FULFILLMENT = ["referral_fees", "fulfillment"];
  const COMBINED_FULFILLMENT_LABEL = "Fulfillment incl. referral";

  const bucketLabel = (k) => (BUCKETS[k] || [k, OPEX, 99])[0];
  const bucketGroup = (k) => (BUCKETS[k] || [k, OPEX, 99])[1];
  const bucketOrder = (k) => (BUCKETS[k] || [k, OPEX, 99])[2];

  /* ------------------------------------------------------------ column map */
  const COLUMN_ALIASES = {
    "date/time": "posted_at", "settlement id": "settlement_id", "type": "type",
    "order id": "order_id", "sku": "sku", "description": "description",
    "quantity": "quantity", "marketplace": "marketplace", "account type": "account_type",
    "fulfillment": "fulfillment_by", "fulfilment": "fulfillment_by",
    "order city": "order_city", "order state": "order_state", "order postal": "order_postal",
    "tax collection model": "tax_model",
    "product sales": "product_sales", "product sales tax": "product_sales_tax",
    "shipping credits": "shipping_credits", "postage credits": "shipping_credits",
    "shipping credits tax": "shipping_credits_tax", "postage credits tax": "shipping_credits_tax",
    "gift wrap credits": "giftwrap_credits", "giftwrap credits": "giftwrap_credits",
    "gift wrap credits tax": "giftwrap_credits_tax", "giftwrap credits tax": "giftwrap_credits_tax",
    "regulatory fee": "regulatory_fee", "tax on regulatory fee": "regulatory_fee_tax",
    "promotional rebates": "promo_rebates", "promotional rebates tax": "promo_rebates_tax",
    "marketplace withheld tax": "withheld_tax",
    "selling fees": "selling_fees", "fba fees": "fba_fees",
    "other transaction fees": "other_txn_fees", "other": "other", "total": "total",
    "transaction status": "status", "transaction release date": "released_at",
  };

  const MONEY_COLUMNS = [
    "product_sales", "product_sales_tax", "shipping_credits", "shipping_credits_tax",
    "giftwrap_credits", "giftwrap_credits_tax", "regulatory_fee", "regulatory_fee_tax",
    "promo_rebates", "promo_rebates_tax", "withheld_tax",
    "selling_fees", "fba_fees", "other_txn_fees", "other",
  ];

  const TAX_COLUMNS = new Set([
    "product_sales_tax", "shipping_credits_tax", "giftwrap_credits_tax",
    "regulatory_fee_tax", "promo_rebates_tax", "withheld_tax",
  ]);

  const CURRENCY_BY_MARKET = { US: "USD", CA: "CAD", UK: "GBP", EU: "EUR" };

  /* -------------------------------------------------------------- CSV parse */
  // RFC4180: quoted fields may contain commas, newlines and doubled quotes.
  // Amazon product descriptions are full of commas, so this has to be real.
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false, i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function toNum(v) {
    if (v === null || v === undefined) return 0;
    const s = String(v).replace(/,/g, "").trim();
    if (s === "" || s === "-") return 0;
    const f = parseFloat(s);
    return Number.isFinite(f) ? f : 0;
  }

  function looksNumeric(v) {
    const s = String(v == null ? "" : v).replace(/,/g, "").trim();
    if (s === "") return false;
    return /^-?\(?\$?-?\d*\.?\d+\)?$/.test(s);
  }

  /* ------------------------------------------------------- classification */
  function normType(raw) {
    const t = String(raw || "").trim().toLowerCase();
    if (t.includes("retrocharge")) return "RETROCHARGE";
    if (t.includes("transaction fees") &&
        (t.includes("fba") || t.includes("fulfilment by amazon") || t.includes("fulfillment by amazon")))
      return "FBA_FEES";
    if (t.includes("inventory fee")) return "INVENTORY_FEE";
    if (t === "order") return "ORDER";
    if (t.includes("refund")) return "REFUND";
    if (t.includes("adjustment")) return "ADJUSTMENT";
    if (t.includes("service fee")) return "SERVICE_FEE";
    if (t.includes("transfer")) return "TRANSFER";
    if (t.includes("debt")) return "DEBT";
    if (t.includes("amazon charges")) return "AMAZON_CHARGES";
    if (t.includes("liquidation")) return "LIQUIDATION";
    if (t.includes("chargeback") || t.includes("a-to-z") || t.includes("safe-t")) return "CHARGEBACK";
    return "UNKNOWN";
  }

  function classifyFbaFee(desc) {
    const d = String(desc || "").toLowerCase();
    // AWD before the generic storage patterns: "AWD Storage Fee" also matches
    // "storage fee" and would otherwise land in FBA storage.
    if (d.includes("awd") && d.includes("storage")) return "awd_storage";
    if (d.includes("awd")) return "awd_fees";
    if (d.includes("long term storage") || d.includes("long-term storage")) return "fba_storage_lt";
    if (d.includes("inventory storage") || d.includes("storage fee")) return "fba_storage";
    if (d.includes("inbound placement")) return "inbound_placement";
    if (d.includes("partnered carrier")) return "partnered_carrier";
    if (d.includes("removal") || d.includes("disposal")) return "removals";
    if (d.includes("low-inventory") || d.includes("low inventory")) return "fba_storage";
    return "unclassified";
  }

  function classifyServiceFee(desc) {
    const d = String(desc || "").toLowerCase();
    if (d.includes("freight") && (d.includes("duties") || d.includes("tax") || d.includes("tariff")))
      return "tariffs";
    if (d.includes("freight")) return "freight";
    if (d.includes("advertising")) return "advertising";
    if (d.includes("subscription")) return "subscription";
    return "service_fee_other";
  }

  function isMcf(marketplace) {
    const m = String(marketplace || "").toLowerCase();
    return m.includes(".stores.amazon.") || m.startsWith("non-amazon");
  }

  /* ------------------------------------------------------------- dates */
  const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
                   jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

  // Three formats across the three markets:
  //   "Aug 1, 2026 12:03:56 AM PDT"   (US)
  //   "Aug 1, 2026 1:37:12 a.m. PDT"  (CA)
  //   "1 Aug 2026 00:01:22 UTC"       (UK)
  // Only y/m/d is needed, so the date is read directly rather than handed to
  // Date.parse — which would drag timezones into a question that has none.
  function parseDateParts(s) {
    const t = String(s || "").trim();
    if (!t) return null;
    let m = t.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/);
    if (m) {
      const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mo) return { y: +m[3], m: mo, d: +m[2] };
    }
    m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
    if (m) {
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo) return { y: +m[3], m: mo, d: +m[1] };
    }
    return null;
  }

  const periodOf = (p) => (p ? `${p.y}-${String(p.m).padStart(2, "0")}` : null);

  /* ------------------------------------------------------------- detection */
  function detectMarket(text, filename) {
    const head = text.slice(0, 2000).toLowerCase();
    if (head.includes("amounts in gbp")) return "UK";
    if (head.includes("amounts in cad")) return "CA";
    if (head.includes("amounts in eur")) return "EU";
    if (head.includes("amounts in usd")) return "US";
    const fn = String(filename || "").toLowerCase();
    for (const m of ["uk", "ca", "eu", "us"]) {
      if (new RegExp(`\\b${m}\\b`).test(fn)) return m.toUpperCase();
    }
    return "US";
  }

  function findHeaderRow(rows) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const joined = rows[i].join(",").toLowerCase();
      if (joined.includes("date/time") && joined.includes("settlement id")) return i;
    }
    return 9;
  }

  /* ---------------------------------------------------------------- parse */
  function parseReport(text, filename) {
    text = text.replace(/^﻿/, "");
    const market = detectMarket(text, filename);
    const currency = CURRENCY_BY_MARKET[market] || "USD";

    const all = parseCSV(text);
    const hi = findHeaderRow(all);
    const rawHeader = (all[hi] || []).map((c) => String(c).trim());
    const header = rawHeader.map((c) => COLUMN_ALIASES[c.toLowerCase()] || c);
    const known = new Set(Object.values(COLUMN_ALIASES));

    const body = all.slice(hi + 1).filter((r) => r.some((c) => String(c).trim() !== ""));
    const rows = body.map((r) => {
      const o = {};
      header.forEach((h, i) => { o[h] = r[i] === undefined ? "" : r[i]; });
      return o;
    });

    const warnings = [];

    // Any column Amazon adds that we don't know about: if it holds money it is
    // pulled into the allocation run rather than ignored. Ignoring it would
    // drop the charge from every bucket and only show up later as an
    // unexplained reconciliation delta.
    const extraMoneyCols = [];
    header.forEach((h, idx) => {
      if (known.has(h)) return;
      if (header.indexOf(h) !== idx) return;      // duplicate header name
      let sawNumber = false, sum = 0;
      for (const r of rows) {
        const v = r[h];
        if (looksNumeric(v)) { sawNumber = true; sum += Math.abs(toNum(v)); }
      }
      if (sawNumber && sum > 0) {
        extraMoneyCols.push(h);
        warnings.push(`New column "${h}" is carrying money and has no rule yet - ` +
                      "its total is held in UNMAPPED so nothing is lost.");
      } else {
        warnings.push(`Unrecognised column ignored (no money in it): "${h}"`);
      }
    });

    const allocations = [];
    // Units are counted from Order rows directly. Deriving them from the
    // product_sales allocations would silently drop any order that posted at
    // zero (fully rebated, or an MCF order that has no Amazon revenue at all).
    const units = { amazon: 0, mcf: 0 };
    let reportTotal = 0, kept = 0, deferred = 0;
    const periodCount = {};
    let minP = null, maxP = null;

    for (const r of rows) {
      const parts = parseDateParts(r.posted_at);
      const rowTotal = toNum(r.total);
      if (!parts && rowTotal === 0) continue;
      kept++;
      reportTotal += rowTotal;

      if (parts) {
        const p = periodOf(parts);
        periodCount[p] = (periodCount[p] || 0) + 1;
        const key = parts.y * 10000 + parts.m * 100 + parts.d;
        if (minP === null || key < minP) minP = key;
        if (maxP === null || key > maxP) maxP = key;
      }
      if (String(r.status || "").toLowerCase() === "deferred") deferred++;

      const nt = normType(r.type);
      const desc = String(r.description || "");
      const chan = isMcf(r.marketplace) ? "mcf" : "amazon";
      const oid = String(r.order_id || "");
      const detail = `${r.type || ""} | ${desc}`.replace(/^ \| | \| $/g, "").slice(0, 220);
      if (nt === "ORDER") units[chan] += toNum(r.quantity);

      const add = (bucket, amount, column, channel, shipmentId) => {
        if (!amount) return;
        allocations.push({
          bucket, channel: channel || "n/a", amount,
          shipment_id: shipmentId || null, order_id: oid || null,
          sku: r.sku || null, status: r.status || "Released",
          source_column: column, detail,
          quantity: toNum(r.quantity),
        });
      };

      for (const col of extraMoneyCols) add("unclassified", toNum(r[col]), col);

      for (const col of MONEY_COLUMNS) {
        const amt = toNum(r[col]);
        if (!amt) continue;

        if (TAX_COLUMNS.has(col)) { add("tax", amt, col); continue; }

        switch (col) {
          case "product_sales":
            add(nt === "REFUND" ? "product_refunds" : "product_sales", amt, col, chan); break;
          case "shipping_credits": add("shipping_credits", amt, col, chan); break;
          case "giftwrap_credits": add("giftwrap_credits", amt, col, chan); break;
          case "regulatory_fee":   add("regulatory_fee", amt, col, chan); break;
          case "promo_rebates":    add("promo_rebates", amt, col, chan); break;
          case "selling_fees":
            // On refund rows Amazon nets the referral credit against the refund
            // administration fee; the CSV does not expose them separately.
            add("referral_fees", amt, col, chan); break;
          case "fba_fees":
            if (nt === "ORDER" || nt === "REFUND" || nt === "RETROCHARGE") {
              add("fulfillment", amt, col, chan);
            } else {
              add(classifyFbaFee(desc), amt, col, "n/a", oid || null);
            }
            break;
          case "other_txn_fees":
            if (nt === "SERVICE_FEE") add(classifyServiceFee(desc), amt, col);
            else add("other_txn_fees", amt, col, chan);
            break;
          case "other": {
            if (nt === "SERVICE_FEE") {
              const b = classifyServiceFee(desc);
              add(b, amt, col, "n/a", (oid && (b === "freight" || b === "tariffs")) ? oid : null);
            } else if (nt === "ADJUSTMENT") add("reimbursements", amt, col);
            else if (nt === "AMAZON_CHARGES") {
              const isMcfCredit = desc.toLowerCase().includes("mcf");
              add(isMcfCredit ? "fulfillment" : "service_fee_other", amt, col,
                  isMcfCredit ? "mcf" : "n/a");
            }
            else if (nt === "INVENTORY_FEE") add("storage_correction", amt, col);
            else if (nt === "TRANSFER") add("transfers", amt, col);
            else if (nt === "DEBT") add("debt_recovery", amt, col);
            else if (nt === "LIQUIDATION") add("liquidations", amt, col);
            else if (nt === "CHARGEBACK") add("chargebacks", amt, col);
            else if (nt === "RETROCHARGE") add("retrocharge", amt, col);
            else if (nt === "REFUND") add("product_refunds", amt, col, chan);
            else add("unclassified", amt, col);
            break;
          }
          default: break;
        }
      }
    }

    const allocatedTotal = allocations.reduce((s, a) => s + a.amount, 0);
    const delta = Math.round((allocatedTotal - reportTotal) * 100) / 100;

    // Review list: everything that hit a catch-all, grouped by what Amazon
    // actually called it, so a new fee type can be named on sight.
    const reviewMap = new Map();
    for (const a of allocations) {
      if (!REVIEW_BUCKETS.has(a.bucket)) continue;
      const k = `${a.bucket} ${a.source_column} ${a.detail}`;
      const cur = reviewMap.get(k) || { bucket: a.bucket, column: a.source_column,
                                        detail: a.detail, amount: 0, rows: 0 };
      cur.amount += a.amount; cur.rows++;
      reviewMap.set(k, cur);
    }
    const unmapped = [...reviewMap.values()]
      .map((u) => ({ ...u, amount: Math.round(u.amount * 100) / 100 }))
      .sort((a, b) => a.amount - b.amount);

    const unclassified = allocations.reduce(
      (s, a) => s + (a.bucket === "unclassified" ? a.amount : 0), 0);
    if (Math.abs(unclassified) > 0.005) {
      warnings.push(`${Math.abs(unclassified).toFixed(2)} ${currency} could not be classified ` +
                    "- check the UNMAPPED bucket before using these numbers.");
    }
    const catchall = allocations.reduce(
      (s, a) => s + (a.bucket === "service_fee_other" ? a.amount : 0), 0);
    if (Math.abs(catchall) > 0.005) {
      warnings.push(`${Math.abs(catchall).toFixed(2)} ${currency} landed in the generic ` +
                    "service-fee catch-all - it is counted, but it deserves its own rule.");
    }
    if (Math.abs(delta) > 0.05) {
      warnings.push(`Reconciliation off by ${delta.toFixed(2)}: allocated ` +
                    `${allocatedTotal.toFixed(2)} vs report total ${reportTotal.toFixed(2)}.`);
    }

    const periodKeys = Object.keys(periodCount);
    let period = "";
    if (periodKeys.length) {
      period = periodKeys.reduce((a, b) => (periodCount[a] >= periodCount[b] ? a : b));
      if (periodKeys.length > 1) {
        warnings.push("Rows span more than one posted month - this report was not cut " +
                      "on month boundaries.");
      }
    }

    const fmtKey = (k) => k === null ? null
      : `${Math.floor(k / 10000)}-${String(Math.floor(k / 100) % 100).padStart(2, "0")}-${String(k % 100).padStart(2, "0")}`;

    return {
      market, currency, period,
      row_count: kept, deferred_rows: deferred,
      allocations, units,
      reconciliation_delta: delta,
      report_total: reportTotal,
      allocated_total: allocatedTotal,
      warnings, unmapped,
      posted_min: fmtKey(minP), posted_max: fmtKey(maxP),
    };
  }

  /* ------------------------------------------------- aggregate for storage */
  // Collapses the allocation list into the compact shape the UI and
  // localStorage need. Raw rows are never persisted.
  function summarise(result, filename) {
    const buckets = {}, channels = {}, shipments = {};
    for (const a of result.allocations) {
      buckets[a.bucket] = (buckets[a.bucket] || 0) + a.amount;
      if (CHANNEL_BUCKETS.has(a.bucket) && a.channel !== "n/a") {
        const k = `${a.bucket}|${a.channel}`;
        channels[k] = (channels[k] || 0) + a.amount;
      }
      if (SHIPMENT_BUCKETS.has(a.bucket) && a.shipment_id) {
        shipments[a.shipment_id] = shipments[a.shipment_id] || {};
        shipments[a.shipment_id][a.bucket] =
          (shipments[a.shipment_id][a.bucket] || 0) + a.amount;
      }
    }

    const round = (o) => Object.fromEntries(
      Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));

    return {
      market: result.market, period: result.period, currency: result.currency,
      filename: filename || "", rows: result.row_count, deferred: result.deferred_rows,
      reconDelta: result.reconciliation_delta, reportTotal: Math.round(result.report_total * 100) / 100,
      warnings: result.warnings, unmapped: result.unmapped,
      postedMin: result.posted_min, postedMax: result.posted_max,
      buckets: round(buckets),
      channels: round(channels),
      shipments: Object.fromEntries(
        Object.entries(shipments).map(([s, b]) => [s, round(b)])),
      units: result.units,
      fx: result.currency === "USD"
        ? { rate: 1, source: "fixed", note: null }
        : { rate: null, source: "pending", note: null },
      uploadedAt: new Date().toISOString(),
    };
  }

  const API = {
    parseReport, summarise, parseCSV, toNum,
    normType, classifyFbaFee, classifyServiceFee, isMcf, parseDateParts,
    detectMarket, BUCKETS, GROUP_LABELS, REVIEW_BUCKETS, SHIPMENT_BUCKETS,
    CHANNEL_BUCKETS, COMBINED_FULFILLMENT, COMBINED_FULFILLMENT_LABEL,
    bucketLabel, bucketGroup, bucketOrder, CURRENCY_BY_MARKET,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.FeeParser = API;
})(typeof self !== "undefined" ? self : this);
