/*
 * UI + state for the static build. Everything happens in the browser:
 * files are parsed here, nothing is uploaded anywhere, and the only storage
 * is this browser's localStorage.
 */
(function () {
  "use strict";
  const P = window.FeeParser;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "vsg-fee-parser-v1";

  const fmt = (n, dp = 2) =>
    n === null || n === undefined || Number.isNaN(n) ? "—"
      : n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const money = (n) =>
    n === null || n === undefined
      ? '<span class="pending">FX pending</span>'
      : `<span class="${n < 0 ? "neg" : n > 0 ? "pos" : ""}">${fmt(n)}</span>`;
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* ------------------------------------------------------------- storage */
  // localStorage is per-browser and per-device. It is a convenience, not a
  // system of record -- hence the JSON backup buttons.
  let STATE = {};
  let storageOK = true;

  function load() {
    try {
      STATE = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
    } catch (e) { STATE = {}; storageOK = false; }
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(STATE));
    } catch (e) {
      storageOK = false;
      banner("Couldn't save to this browser's storage — the numbers on screen are fine, "
           + "but they won't be here next visit. Use \"Back up\" to keep a copy.", true);
    }
  }
  function banner(msg, bad) {
    const el = $("uploadLog");
    el.hidden = false;
    el.insertAdjacentHTML("beforeend", `<div class="${bad ? "err" : "warn"}">${esc(msg)}</div>`);
  }

  /* -------------------------------------------------------------- upload */
  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((e) =>
    dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((e) =>
    dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (ev) => handle(ev.dataTransfer.files));
  $("fileInput").addEventListener("change", (ev) => handle(ev.target.files));

  function handle(fileList) {
    const files = [...fileList].filter((f) => /\.csv$/i.test(f.name));
    const el = $("uploadLog");
    el.hidden = false;
    if (!files.length) { el.innerHTML = '<div class="err">Drop .csv transaction reports.</div>'; return; }
    el.innerHTML = `<div>Parsing ${files.length} file${files.length > 1 ? "s" : ""}…</div>`;

    let done = 0, html = "", lastPeriod = null;
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const r = P.parseReport(String(reader.result), file.name);
          if (!r.period) {
            html += `<div class="err">${esc(file.name)}: couldn't determine a posted month.</div>`;
          } else {
            const s = P.summarise(r, file.name);
            STATE[r.period] = STATE[r.period] || {};
            const prev = STATE[r.period][r.market];
            if (prev && prev.fx && prev.fx.rate) s.fx = prev.fx;   // keep the rate already set
            STATE[r.period][r.market] = s;
            lastPeriod = r.period;

            html += `<div class="ok"><strong>${r.market} ${r.period}</strong> — ${fmt(r.row_count, 0)} rows`
              + (r.deferred_rows ? `, ${r.deferred_rows} deferred (counted)` : "")
              + (prev ? ", replaced previous upload" : "")
              + (Math.abs(r.reconciliation_delta) < 0.05
                  ? ", reconciled to the report total"
                  : `, <span class="neg">reconciliation off by ${fmt(r.reconciliation_delta)}</span>`)
              + "</div>";
            r.warnings.forEach((w) => { html += `<div class="warn">${r.market}: ${esc(w)}</div>`; });
            if (r.currency !== "USD" && !s.fx.rate) {
              html += `<div class="warn">${r.market}: needs an exchange rate before it rolls into USD.</div>`;
            }
          }
        } catch (err) {
          html += `<div class="err">${esc(file.name)}: ${esc(err.message)}</div>`;
        }
        if (++done === files.length) {
          save();
          el.innerHTML = html;
          refresh(lastPeriod);
        }
      };
      reader.onerror = () => {
        html += `<div class="err">${esc(file.name)}: could not be read.</div>`;
        if (++done === files.length) { save(); el.innerHTML = html; refresh(lastPeriod); }
      };
      reader.readAsText(file);
    });
  }

  /* ------------------------------------------------------------- refresh */
  function refresh(prefer) {
    const periods = Object.keys(STATE).sort().reverse();
    const sel = $("periodSelect");
    if (!periods.length) {
      ["controls", "fxPanel", "summary", "breakdown", "channels", "unmapped",
       "shipments", "trend", "flags"].forEach((id) => { $(id).hidden = true; });
      return;
    }
    sel.innerHTML = periods.map((p) =>
      `<option value="${p}">${p} — ${Object.keys(STATE[p]).sort().join(", ")}</option>`).join("");
    if (prefer && periods.includes(prefer)) sel.value = prefer;
    $("controls").hidden = false;
    sel.onchange = () => render(sel.value);
    render(sel.value);
  }

  /* ------------------------------------------------------------ helpers */
  const fxReady = (s) => s.currency === "USD" || !!(s.fx && s.fx.rate);
  const rateOf = (s) => (s.currency === "USD" ? 1 : (s.fx && s.fx.rate) || 0);
  const usd = (s, v) => (fxReady(s) ? Math.round(v * rateOf(s) * 100) / 100 : null);

  function markets(period) { return Object.keys(STATE[period]).sort(); }

  function bucketTotalUSD(period, bucket) {
    return markets(period).reduce((t, m) => {
      const s = STATE[period][m];
      const v = usd(s, s.buckets[bucket] || 0);
      return t + (v === null ? 0 : v);
    }, 0);
  }

  /* ------------------------------------------------------------- render */
  function render(period) {
    const ms = markets(period);
    renderFx(period, ms);
    renderSummary(period, ms);
    renderBreakdown(period, ms);
    renderChannels(period, ms);
    renderUnmapped(period, ms);
    renderShipments(period, ms);
    renderTrend();
    renderFlags(period, ms);
    $("exportBtn").onclick = () => exportCSV(period);
  }

  function renderFx(period, ms) {
    $("fxRows").innerHTML = ms.map((m) => {
      const s = STATE[period][m];
      if (s.currency === "USD") {
        return `<div class="fx-row ready"><div class="hdr"><span class="mkt">${m}</span>
          <span class="state">USD — no conversion needed</span></div></div>`;
      }
      const state = fxReady(s)
        ? `1 ${s.currency} = ${fmt(s.fx.rate, 4)} USD · ${s.fx.source}`
          + (s.fx.note ? ` · ${esc(s.fx.note)}` : "")
        : "rate not set — this market is excluded from USD totals";
      return `<div class="fx-row ${fxReady(s) ? "ready" : ""}">
        <div class="hdr"><span class="mkt">${m} (${s.currency})</span><span class="state">${state}</span></div>
        <div class="fx-inputs">
          <div class="fx-field"><small>USD per 1 ${s.currency}</small>
            <input type="number" step="0.000001" id="rate-${m}" placeholder="e.g. 1.3514"></div>
          <button class="btn small" data-act="rate" data-m="${m}">Set rate</button>
          <span class="or">or derive the settled rate from a disbursement</span>
          <div class="fx-field"><small>${s.currency} disbursed</small>
            <input type="number" step="0.01" id="loc-${m}"></div>
          <div class="fx-field"><small>USD received</small>
            <input type="number" step="0.01" id="usd-${m}"></div>
          <button class="btn small" data-act="derive" data-m="${m}">Derive</button>
        </div></div>`;
    }).join("");
    $("fxPanel").hidden = false;

    $("fxRows").querySelectorAll("button[data-act]").forEach((b) => {
      b.onclick = () => {
        const m = b.dataset.m, s = STATE[period][m];
        if (b.dataset.act === "rate") {
          const v = parseFloat($(`rate-${m}`).value);
          if (!v) return alert("Enter a rate.");
          if (!(v > 0.01 && v < 100))
            return alert("That rate looks out of range. Enter USD per 1 unit of local currency.");
          s.fx = { rate: v, source: "manual", note: null };
        } else {
          const loc = parseFloat($(`loc-${m}`).value), u = parseFloat($(`usd-${m}`).value);
          if (!loc || !u) return alert("Enter both the local amount disbursed and the USD received.");
          s.fx = {
            rate: Math.round(Math.abs(u) / Math.abs(loc) * 1e6) / 1e6, source: "settled",
            note: `Derived from disbursement: ${fmt(Math.abs(loc))} ${s.currency} → ${fmt(Math.abs(u))} USD`,
          };
        }
        save(); render(period);
      };
    });
  }

  function renderSummary(period, ms) {
    const g = (b) => bucketTotalUSD(period, b);
    const sales = g("product_sales") + g("promo_rebates") + g("product_refunds");
    const referral = g("referral_fees"), fulfil = g("fulfillment");
    const combined = referral + fulfil;
    const storage = g("fba_storage") + g("fba_storage_lt") + g("storage_correction") + g("awd_storage");
    const inbound = g("freight") + g("tariffs") + g("inbound_placement")
                  + g("partnered_carrier") + g("awd_fees");
    const cards = [
      ["Net product sales", sales, "after rebates and refunds"],
      ["Fulfillment incl. referral", combined,
        sales ? `${Math.abs(combined / sales * 100).toFixed(1)}% of net sales` : ""],
      ["— referral portion", referral, "commission on Amazon sales"],
      ["— fulfillment portion", fulfil, "Amazon + MCF, net of credits"],
      ["Storage", storage, "FBA + AWD + long-term"],
      ["Inbound logistics", inbound, "freight, duties, placement"],
    ];
    $("summary").innerHTML = `<h2>${period} at a glance <span class="pending">(USD)</span></h2>
      <div class="cards">${cards.map(([k, v, m]) =>
        `<div class="card"><div class="k">${k}</div><div class="v ${v < 0 ? "neg" : ""}">${fmt(v)}</div>
         <div class="m">${m}</div></div>`).join("")}</div>`;
    $("summary").hidden = false;
  }

  function renderBreakdown(period, ms) {
    const locals = ms.filter((m) => STATE[period][m].currency !== "USD");
    const cols = locals.length + ms.length + 2;
    const keys = [...new Set(ms.flatMap((m) => Object.keys(STATE[period][m].buckets)))]
      .sort((a, b) => P.bucketOrder(a) - P.bucketOrder(b));

    const cellLocal = (m, b) => money(STATE[period][m].buckets[b] || 0);
    const cellUSD = (m, b) => money(usd(STATE[period][m], STATE[period][m].buckets[b] || 0));

    let html = `<h2>Every charge, by bucket</h2><table><thead><tr><th>Bucket</th>
      ${locals.map((m) => `<th>${m} (${STATE[period][m].currency})</th>`).join("")}
      ${ms.map((m) => `<th>${m} USD</th>`).join("")}<th>Total USD</th></tr></thead><tbody>`;

    let group = null, total = 0;
    const subtotalRow = () => {
      const loc = (m) => P.COMBINED_FULFILLMENT.reduce((t, b) => t + (STATE[period][m].buckets[b] || 0), 0);
      const tot = ms.reduce((t, m) => {
        const v = usd(STATE[period][m], loc(m)); return t + (v === null ? 0 : v);
      }, 0);
      return `<tr class="subtotalrow"><td>${P.COMBINED_FULFILLMENT_LABEL}</td>
        ${locals.map((m) => `<td class="num">${money(Math.round(loc(m) * 100) / 100)}</td>`).join("")}
        ${ms.map((m) => `<td class="num">${money(usd(STATE[period][m], loc(m)))}</td>`).join("")}
        <td class="num">${money(Math.round(tot * 100) / 100)}</td></tr>`;
    };

    keys.forEach((b) => {
      const gp = P.bucketGroup(b);
      if (gp !== group) {
        if (group === "cogs_variable") html += subtotalRow();
        group = gp;
        html += `<tr class="grouphead"><td colspan="${cols}">${P.GROUP_LABELS[gp] || gp}</td></tr>`;
      }
      const t = bucketTotalUSD(period, b);
      total += t;
      html += `<tr><td>${P.bucketLabel(b)}</td>
        ${locals.map((m) => `<td class="num">${cellLocal(m, b)}</td>`).join("")}
        ${ms.map((m) => `<td class="num">${cellUSD(m, b)}</td>`).join("")}
        <td class="num">${money(Math.round(t * 100) / 100)}</td></tr>`;
    });
    if (group === "cogs_variable") html += subtotalRow();

    html += `<tr class="totalrow"><td>Net (ties to report total)</td>
      ${Array(cols - 2).fill("<td></td>").join("")}
      <td class="num">${money(Math.round(total * 100) / 100)}</td></tr></tbody></table>`;
    $("breakdown").innerHTML = html;
    $("breakdown").hidden = false;
  }

  function renderChannels(period, ms) {
    const rows = [];
    ms.forEach((m) => {
      const s = STATE[period][m];
      ["amazon", "mcf"].forEach((ch) => {
        const ref = s.channels[`referral_fees|${ch}`] || 0;
        const ful = s.channels[`fulfillment|${ch}`] || 0;
        if (!ref && !ful) return;
        const units = ch === "mcf" ? s.units.mcf : s.units.amazon;
        rows.push({
          m, ch, ref: usd(s, ref), ful: usd(s, ful), units,
          comb: usd(s, ref + ful),
          perUnit: units ? usd(s, (ref + ful) / units) : null,
        });
      });
    });
    if (!rows.length) { $("channels").hidden = true; return; }
    $("channels").innerHTML = `<h2>Fulfillment incl. referral, by channel</h2>
      <p class="note">MCF is Amazon fulfilling orders that were sold somewhere else — Shopify,
      Kickstarter backer shipments. The cost lands here; the revenue does not, and MCF carries no
      referral fee because there was no Amazon sale to take commission on.</p>
      <table><thead><tr><th>Market</th><th>Channel</th><th>Units</th><th>Referral USD</th>
        <th>Fulfillment USD</th><th>Combined USD</th><th>$/unit</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${r.m}</td>
        <td>${r.ch === "mcf" ? "MCF (external orders)" : "Amazon retail"}</td>
        <td class="num">${fmt(r.units, 0)}</td>
        <td class="num">${r.ref ? money(r.ref) : "—"}</td>
        <td class="num">${money(r.ful)}</td>
        <td class="num"><strong>${money(r.comb)}</strong></td>
        <td class="num">${r.perUnit === null ? "—" : fmt(Math.abs(r.perUnit))}</td></tr>`).join("")}
      </tbody></table>`;
    $("channels").hidden = false;
  }

  function renderUnmapped(period, ms) {
    const rows = [];
    ms.forEach((m) => {
      const s = STATE[period][m];
      (s.unmapped || []).forEach((u) =>
        rows.push({ ...u, market: m, currency: s.currency, usd: usd(s, u.amount) }));
    });
    const el = $("unmapped");
    if (!rows.length) {
      el.innerHTML = `<h2>Unmapped charges</h2>
        <div class="flag ok-flag"><strong>Nothing unmapped.</strong> Every charge in this month
        matched a specific rule, and the allocations tie to the report's own total column.</div>`;
      el.hidden = false; return;
    }
    rows.sort((a, b) => a.amount - b.amount);
    el.innerHTML = `<h2>Unmapped charges — needs a rule</h2>
      <p class="note">These hit a catch-all instead of a named rule. They are still counted in
      every total, so nothing is lost — but each should get its own bucket. The description is
      exactly what Amazon called it.</p>
      <table><thead><tr><th>What Amazon called it</th><th>Market</th><th>Column</th>
        <th>Rows</th><th>Local</th><th>USD</th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td>${esc(u.detail) || "(no description)"}</td><td>${u.market}</td>
        <td><code>${esc(u.column)}</code></td><td class="num">${fmt(u.rows, 0)}</td>
        <td class="num">${money(u.amount)}</td><td class="num">${money(u.usd)}</td></tr>`).join("")}
      </tbody></table>`;
    el.hidden = false;
  }

  function renderShipments(period, ms) {
    const keys = ["freight", "tariffs", "partnered_carrier", "inbound_placement"];
    const names = { freight: "Freight", tariffs: "Duties & tariffs",
                    partnered_carrier: "Partnered carrier", inbound_placement: "Inbound placement" };
    const rows = [];
    ms.forEach((m) => {
      const s = STATE[period][m];
      Object.entries(s.shipments || {}).forEach(([ship, b]) => {
        const conv = {}; let tot = 0;
        keys.forEach((k) => { if (b[k]) { conv[k] = usd(s, b[k]); tot += b[k]; } });
        rows.push({ ship, market: m, conv, total: usd(s, tot) });
      });
    });
    if (!rows.length) { $("shipments").hidden = true; return; }
    rows.sort((a, b) => (a.total || 0) - (b.total || 0));
    $("shipments").innerHTML = `<h2>Inbound cost by shipment</h2>
      <p class="note">Freight, duties and inbound fees carry Amazon's shipment ID, so each
      container can be costed on its own.</p>
      <table><thead><tr><th>Shipment</th><th>Market</th>
        ${keys.map((k) => `<th>${names[k]}</th>`).join("")}<th>Total USD</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.ship)}</td><td>${r.market}</td>
          ${keys.map((k) => `<td class="num">${r.conv[k] !== undefined ? money(r.conv[k]) : "—"}</td>`).join("")}
          <td class="num">${money(r.total)}</td></tr>`).join("")}
      </tbody></table>`;
    $("shipments").hidden = false;
  }

  function renderTrend() {
    const periods = Object.keys(STATE).sort();
    if (periods.length < 2) { $("trend").hidden = true; return; }
    const lines = [
      ["Net product sales", (p) => bucketTotalUSD(p, "product_sales")
        + bucketTotalUSD(p, "promo_rebates") + bucketTotalUSD(p, "product_refunds")],
      ["Fulfillment incl. referral", (p) => bucketTotalUSD(p, "referral_fees")
        + bucketTotalUSD(p, "fulfillment")],
      ["Storage", (p) => bucketTotalUSD(p, "fba_storage") + bucketTotalUSD(p, "fba_storage_lt")
        + bucketTotalUSD(p, "awd_storage") + bucketTotalUSD(p, "storage_correction")],
      ["Inbound logistics", (p) => bucketTotalUSD(p, "freight") + bucketTotalUSD(p, "tariffs")
        + bucketTotalUSD(p, "inbound_placement") + bucketTotalUSD(p, "partnered_carrier")
        + bucketTotalUSD(p, "awd_fees")],
    ];
    $("trend").innerHTML = `<h2>Month over month <span class="pending">(USD)</span></h2>
      <table><thead><tr><th>Line</th>${periods.map((p) => `<th>${p}</th>`).join("")}</tr></thead>
      <tbody>${lines.map(([label, fn]) => `<tr><td>${label}</td>
        ${periods.map((p) => `<td class="num">${money(Math.round(fn(p) * 100) / 100)}</td>`).join("")}
      </tr>`).join("")}</tbody></table>`;
    $("trend").hidden = false;
  }

  function renderFlags(period, ms) {
    const out = [];
    ms.forEach((m) => {
      const s = STATE[period][m];
      if (Math.abs(s.reconDelta) > 0.05)
        out.push([`${m}: allocations are off the report total by ${fmt(s.reconDelta)}. `
          + "Do not use these figures until it is resolved.", true]);
      (s.warnings || []).forEach((w) => out.push([`${m}: ${w}`, false]));
      if (s.deferred)
        out.push([`${m}: ${s.deferred} deferred rows are included, as they should be. `
          + "Their amounts are provisional until released.", false]);
      if (!fxReady(s))
        out.push([`${m}: no exchange rate set — excluded from USD totals.`, true]);
    });
    const lt = bucketTotalUSD(period, "fba_storage_lt");
    const ful = bucketTotalUSD(period, "fulfillment");
    if (lt && ful && Math.abs(lt) > Math.abs(ful) * 0.5)
      out.push([`Long-term storage (${fmt(lt)}) is running at more than half of total fulfillment `
        + "— that is aged inventory, not a fulfillment problem.", false]);
    const corr = bucketTotalUSD(period, "storage_correction");
    if (corr && Math.abs(corr) < 50)
      out.push(["Storage fee corrections net to roughly zero — a correction and its reversal are "
        + "both present. Any filter that catches one side invents a large phantom charge.", false]);
    if (ms.some((m) => (STATE[period][m].channels["fulfillment|mcf"] || 0) !== 0))
      out.push(["MCF fulfillment cost is carried against zero Amazon revenue. Move it to the "
        + "channel that sold the order before computing any fee-as-%-of-sales ratio.", false]);
    if (!storageOK)
      out.push(["This browser isn't saving data (private window, or storage blocked). Numbers on "
        + "screen are correct but won't persist — use \"Back up\" to keep a copy.", true]);

    $("flags").innerHTML = out.length
      ? `<h2>Flags</h2>${out.map(([t, bad]) =>
          `<div class="flag ${bad ? "bad" : ""}">${esc(t)}</div>`).join("")}`
      : "";
    $("flags").hidden = !out.length;
  }

  /* -------------------------------------------------------------- export */
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const csvCell = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function exportCSV(period) {
    const ms = markets(period);
    const rows = [["Period", "Group", "Bucket", "Market", "Currency",
                   "Amount (local)", "FX (USD per local)", "FX source", "Amount (USD)"]];
    ms.forEach((m) => {
      const s = STATE[period][m];
      Object.keys(s.buckets).sort((a, b) => P.bucketOrder(a) - P.bucketOrder(b)).forEach((b) => {
        const amt = s.buckets[b];
        rows.push([period, P.GROUP_LABELS[P.bucketGroup(b)] || "", P.bucketLabel(b), m, s.currency,
                   amt.toFixed(2), fxReady(s) ? rateOf(s).toFixed(6) : "", s.fx.source,
                   fxReady(s) ? (amt * rateOf(s)).toFixed(2) : "FX PENDING"]);
      });
      const comb = P.COMBINED_FULFILLMENT.reduce((t, b) => t + (s.buckets[b] || 0), 0);
      rows.push([period, "Subtotal", P.COMBINED_FULFILLMENT_LABEL, m, s.currency, comb.toFixed(2),
                 fxReady(s) ? rateOf(s).toFixed(6) : "", s.fx.source,
                 fxReady(s) ? (comb * rateOf(s)).toFixed(2) : "FX PENDING"]);
    });
    download(`vsg-amazon-fees-${period}.csv`,
      rows.map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv");
  }

  $("backupBtn").onclick = () =>
    download(`vsg-fee-parser-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(STATE, null, 1), "application/json");

  $("restoreInput").addEventListener("change", (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = JSON.parse(String(reader.result));
        let added = 0;
        Object.entries(incoming).forEach(([p, mkts]) => {
          STATE[p] = STATE[p] || {};
          Object.entries(mkts).forEach(([m, s]) => { STATE[p][m] = s; added++; });
        });
        save(); refresh();
        banner(`Restored ${added} market-month${added === 1 ? "" : "s"} from backup.`, false);
      } catch (err) { banner(`That file couldn't be read as a backup: ${err.message}`, true); }
    };
    reader.readAsText(f);
    ev.target.value = "";
  });

  $("clearBtn").onclick = () => {
    const p = $("periodSelect").value;
    if (!p) return;
    if (!confirm(`Remove ${p} from this browser? The original CSVs are untouched.`)) return;
    delete STATE[p];
    save(); refresh();
  };

  load();
  refresh();
})();
