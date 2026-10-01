/*
 * Regression tests for the browser parser.
 *
 *   node tests/test.js
 *
 * Fixtures: put the three August 2026 CSVs in tests/fixtures/ (git-ignored,
 * they hold real financial data), or set FIXTURE_DIR. Tests skip if absent.
 *
 * The reconciliation test is the one that matters: it proves no charge was
 * silently dropped or double counted.
 */
const fs = require("fs");
const path = require("path");
const P = require("../parser.js");

const DIR = process.env.FIXTURE_DIR || path.join(__dirname, "fixtures");
const FILES = { US: "US - Amazon - August.csv",
                CA: "CA - Amazon - August.csv",
                UK: "UK - Amazon - August.csv" };

let pass = 0, fail = 0, skip = 0;

function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) {
    if (e && e.__skip) { console.log(`  skip ${name} (${e.message})`); skip++; return; }
    console.log(`  FAIL ${name}\n         ${e.message}`); fail++;
  }
}
function eq(actual, expected, what) {
  if (actual !== expected)
    throw new Error(`${what || ""} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function close(actual, expected, what, tol = 0.01) {
  if (Math.abs(actual - expected) > tol)
    throw new Error(`${what || ""} expected ~${expected}, got ${actual}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || "expected truthy"); }

function load(market) {
  const p = path.join(DIR, FILES[market]);
  if (!fs.existsSync(p)) { const e = new Error(`fixture missing: ${p}`); e.__skip = true; throw e; }
  return P.parseReport(fs.readFileSync(p, "utf8"), FILES[market]);
}
function totals(r) {
  const t = {};
  for (const a of r.allocations) t[a.bucket] = (t[a.bucket] || 0) + a.amount;
  return t;
}

console.log("\nparser");

/* --- the core guarantee ------------------------------------------------- */
for (const m of ["US", "CA", "UK"]) {
  test(`${m}: allocations reconcile to the report's own total column`, () => {
    const r = load(m);
    close(r.reconciliation_delta, 0, `${m} reconciliation`, 0.01);
  });
  test(`${m}: nothing unclassified`, () => {
    close(totals(load(m)).unclassified || 0, 0, `${m} unclassified`);
  });
  test(`${m}: period taken from the posted date`, () => {
    const r = load(m);
    eq(r.period, "2026-08");
    ok(r.posted_max.startsWith("2026-08"), "posted dates must not leak into September");
  });
}

/* --- known figures ------------------------------------------------------ */
test("US: known bucket figures", () => {
  const t = totals(load("US"));
  close(t.fba_storage_lt, -36558.01, "long-term storage");
  close(t.fba_storage, -14572.03, "storage");
  close(t.awd_storage, -2659.20, "AWD storage");       // must not fall into fba_storage
  close(t.awd_fees, -1571.72, "AWD processing/transport");
  close(t.referral_fees, -20559.04, "referral");
  close(t.fulfillment, -37488.95, "fulfillment");
  close(t.freight, -65841.69, "freight");
  close(t.tariffs, -37314.21, "tariffs");
  close(t.storage_correction, -705.78, "storage corrections");
});

test("US: fulfillment splits Amazon retail from MCF", () => {
  const by = {};
  for (const a of load("US").allocations)
    if (a.bucket === "fulfillment") by[a.channel] = (by[a.channel] || 0) + a.amount;
  close(by.amazon, -25463.22, "Amazon retail");
  close(by.mcf, -12025.73, "MCF");
});

test("UK/CA: locale variants normalise", () => {
  const uk = totals(load("UK")), ca = totals(load("CA"));
  close(uk.shipping_credits, 185.65, "UK postage credits");     // UK says "postage"
  close(ca.fba_storage_lt, -103.92, "CA long-term storage");     // CA lowercases it
  close(uk.fba_storage, -1446.28, "UK storage");
});

test("US: deferred rows are counted, not dropped", () => {
  const r = load("US");
  eq(r.deferred_rows, 26);
  eq(r.row_count, 6432, "all posted-in-August rows must survive");
});

test("US: shipment ids attach to inbound charges", () => {
  const ships = new Set(load("US").allocations
    .filter((a) => (a.bucket === "freight" || a.bucket === "tariffs") && a.shipment_id)
    .map((a) => a.shipment_id));
  ok(ships.has("FBA19GCK9K7J"), "expected shipment FBA19GCK9K7J");
});

/* --- nothing escapes ---------------------------------------------------- */
test("a new fee type, a new description and a new column are all caught", () => {
  const p = path.join(DIR, FILES.US);
  if (!fs.existsSync(p)) { const e = new Error("fixture missing"); e.__skip = true; throw e; }
  const lines = fs.readFileSync(p, "utf8").replace(/^﻿/, "").split("\n");
  const hi = lines.findIndex((l) =>
    l.toLowerCase().includes("date/time") && l.toLowerCase().includes("settlement id"));
  lines[hi] = lines[hi].trimEnd() + ',"Sustainability Surcharge"';
  for (let i = hi + 1; i < lines.length; i++) if (lines[i].trim()) lines[i] = lines[i].trimEnd() + ',"0"';
  lines.splice(hi + 1, 0,
    '"Aug 5, 2026 1:00:00 AM PDT","1","Quantum Placement Levy","","","Hyperloop Tote Fee","","amazon.com","Standard Orders","","","","","","0","0","0","0","0","0","0","0","0","0","0","0","0","0","-250.00","-250.00","Released","Aug 5, 2026 1:00:00 AM PDT","-12.34"',
    '"Aug 6, 2026 1:00:00 AM PDT","1","FBA Transaction fees","","","FBA Orbital Relocation Fee","","amazon.com","Standard Orders","","","","","","0","0","0","0","0","0","0","0","0","0","0","0","-99.99","0","0","-99.99","Released","Aug 6, 2026 1:00:00 AM PDT","0"');

  const r = P.parseReport(lines.join("\n"), "US-mutated.csv");
  const details = r.unmapped.map((u) => u.detail).join(" ;; ");
  ok(details.includes("Hyperloop Tote Fee"), "new fee type should surface with its description");
  ok(details.includes("FBA Orbital Relocation Fee"), "unknown FBA fee description should surface");
  ok(r.unmapped.some((u) => u.column === "Sustainability Surcharge"),
     "money in a brand-new column must be held, not ignored");
  close(r.unmapped.reduce((s, u) => s + u.amount, 0), -362.33, "unmapped total");
  ok(r.warnings.some((w) => w.includes("Sustainability Surcharge")), "new column should warn");
});

/* --- unit rules --------------------------------------------------------- */
console.log("\nrules");
test("AWD storage beats the generic storage rule", () => {
  eq(P.classifyFbaFee("AWD Storage Fee"), "awd_storage");
  eq(P.classifyFbaFee("FBA Inventory Storage Fee"), "fba_storage");
  eq(P.classifyFbaFee("Fulfilment by Amazon (FBA) Long-Term Storage Fee"), "fba_storage_lt");
  eq(P.classifyFbaFee("Fulfilment by Amazon removal order: disposal fee"), "removals");
});
test("freight vs tariff", () => {
  eq(P.classifyServiceFee("FBA International Freight Shipping Charge"), "freight");
  eq(P.classifyServiceFee("FBA International Freight Delivery Charge"), "freight");
  eq(P.classifyServiceFee("FBA International Freight Duties and Taxes Charge"), "tariffs");
});
test("MCF marketplaces detected", () => {
  ok(P.isMcf("sim1.stores.amazon.com"));
  ok(P.isMcf("siprodukmarketplace.stores.amazon.co.uk"));
  ok(P.isMcf("siprod.stores.amazon.ca"));
  ok(!P.isMcf("amazon.com"));
  ok(!P.isMcf("amazon.co.uk"));
});
test("all three date formats parse without timezone drift", () => {
  eq(JSON.stringify(P.parseDateParts("Aug 1, 2026 12:03:56 AM PDT")), '{"y":2026,"m":8,"d":1}');
  eq(JSON.stringify(P.parseDateParts("Aug 1, 2026 1:37:12 a.m. PDT")), '{"y":2026,"m":8,"d":1}');
  eq(JSON.stringify(P.parseDateParts("1 Aug 2026 00:01:22 UTC")), '{"y":2026,"m":8,"d":1}');
  eq(P.parseDateParts(""), null);
});
test("CSV parser handles quoted commas and doubled quotes", () => {
  const rows = P.parseCSV('a,"b,c","say ""hi"""\n1,2,3\n');
  eq(rows[0][1], "b,c");
  eq(rows[0][2], 'say "hi"');
  eq(rows[1].length, 3);
});
test("thousands separators parse", () => {
  eq(P.toNum("-1,234.56"), -1234.56);
  eq(P.toNum(""), 0);
  eq(P.toNum("0"), 0);
});

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail ? 1 : 0);
