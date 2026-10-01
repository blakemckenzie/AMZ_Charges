# VSG Amazon Fee Parser

Drop each month's Amazon transaction reports in, get every charge categorised,
converted to USD and reconciled against the report's own totals.

Built because Amazon's summary line names don't map to a chart of accounts —
`FBA Transaction Fees` is fulfillment *and* storage *and* inbound logistics in
one number, and treating it as "fulfillment" overstates fulfillment by roughly
2.5x.

**This is a static site.** No server, no database, no build step. The whole app
is four files served as-is, and every CSV is parsed in your browser.

---

## What it does

- **Drag and drop** the US / CA / UK / EU transaction CSVs together. Market,
  currency and month are read from each file.
- **Classifies every monetary cell** into one of ~30 buckets, then **proves the
  work**: allocations must equal the sum of the report's own `total` column.
  A non-zero residual is surfaced as a blocking flag, not swallowed.
- **Rolls referral into fulfillment** as the headline number, keeping both
  components as their own lines underneath.
- **Splits by channel** — Amazon retail vs MCF (Amazon shipping orders sold on
  Shopify, or Kickstarter backer fulfillment) — with units and $/unit.
- **Breaks inbound cost down by shipment ID**, so each container's freight,
  duties, partnered carrier and placement fees can be costed on its own.
- **Remembers months** in this browser, so a month-over-month table appears
  once there's more than one. Back up and restore as JSON.
- **Exports a mapped CSV** for the accountant.

## Where your data lives

Files are read with the browser's `FileReader` and parsed in the page. Nothing
is uploaded — there is no server to upload to.

Months you drop in are kept in this browser's **localStorage**, which means:

- they survive closing the tab and redeploys of the site
- they do **not** follow you to another browser, another laptop, or your phone
- a private window, cleared site data, or storage being blocked will lose them
- nobody else can see them, including anyone else who opens the same URL

It's a convenience, not a system of record. **Back up** writes a JSON file you
can keep or restore anywhere; the app tells you if storage isn't working.

## The three rules it enforces

**1. Period comes from the posted date, never the release date.**
Reports dated Jan 1 2025 or later are indexed by posted date and include both
`Released` and `Deferred` rows. Filtering on release date silently drops real
transactions — for August 2026 US that was 1,177 rows carrying $7,506.77 of
fulfillment fees. Deferred amounts are provisional until they release, so a
report pulled 10–14 days after month end is effectively final.

**2. FX is stored one way only: USD per 1 unit of local currency.**
The direction is the whole point. A pound buys more than a dollar, so GBP→USD
is above 1. A Canadian dollar buys less, so CAD→USD is below 1. Applying a
`local-per-USD` rate as if it were `USD-per-local` overstates CAD by ~90% and
understates GBP by ~45%. The UI labels the direction on every input and
range-checks what you type.

The settled rate is *not* derivable from the transaction report — `Transfer`
rows are denominated in local currency with no USD counterpart. To capture the
real rate, take the disbursement from Seller Central → Payments → Disbursements
and enter the pair (local disbursed, USD received); the app derives the
effective rate and marks it `settled`.

**3. MCF cost belongs to the channel that made the sale.**
`*.stores.amazon.*` marketplaces are Multi-Channel Fulfillment. They carry
fulfillment cost against **zero** Amazon revenue and pay no referral fee, so any
fee-as-%-of-sales ratio that includes them is broken by construction.

## Bucket taxonomy

| Group | Buckets |
|---|---|
| Revenue | product sales (ex-tax), promotional rebates, shipping/postage credits, gift wrap, regulatory fee, product refunds |
| Variable selling cost | referral/selling fees, fulfillment (Amazon + MCF), other per-order txn fees, **subtotal: fulfillment incl. referral** |
| Inventory carrying | FBA storage, FBA long-term storage, storage corrections, AWD storage, AWD processing/transport, removals & disposal, inventory reimbursements |
| Inbound logistics | international freight, duties & tariffs, inbound placement, partnered carrier |
| Operating | advertising, seller subscription, other service fees, retrocharges, chargebacks, liquidations |
| Pass-through | tax collected & withheld |
| Cash movement | debt recovery, bank transfers |

### Nothing escapes

Three layers, in order of how sneaky the problem is:

1. **Unknown description on a known column** — a new FBA fee or service fee
   lands in `unclassified` / `service_fee_other`.
2. **Unknown column entirely** — if Amazon adds a column, it is probed for
   numbers. If it holds money it is pulled into the allocation run as unmapped
   rather than ignored, because ignoring it would drop the charge from every
   bucket.
3. **The reconciliation guard** — allocations must equal the sum of the
   report's own `total` column. Anything the first two layers somehow miss
   shows up here as a non-zero delta and a blocking flag.

Whatever lands in a catch-all is listed on screen with **exactly what Amazon
called it** (`<type> | <description>`), which column it came from, how many rows
and how much — so a new fee type can be named and given a rule on sight. Add the
rule to `classifyFbaFee` / `classifyServiceFee` in `parser.js`, re-drop the
month, and it moves to its proper bucket.

## Traps it catches automatically

- **Correction/reversal pairs.** August 2026 had a `-23,123.11` storage fee
  correction and a `+23,125.03` reversal at the same timestamp, netting `+1.92`.
  Any filter that catches one side invents a $23k charge.
- **AWD Storage Fee vs FBA storage.** "AWD Storage Fee" also matches the string
  "storage fee"; the AWD rule is tested first. There's a regression test for it.
- **Long-term storage spikes.** Flagged when LTSF exceeds half of total
  fulfillment — that's aged inventory, not a fulfillment problem.
- **Locale drift.** UK says "postage credits" and "Fulfilment"; CA lowercases
  the storage descriptions; the status column changes case between markets;
  three different date formats. All normalised.

## Files

```
index.html     markup
style.css      VSG brand: aqua #8DDAE2, yellow #F1C71B, ink #121212
parser.js      CSV parsing, classification, reconciliation (no dependencies)
app.js         UI, localStorage, CSV export
render.yaml    Render static site blueprint
tests/test.js  regression suite, runs under Node
```

`parser.js` has no dependencies and works in the browser or under Node, which
is what lets the test suite run the real classification logic rather than a
copy of it.

## Local development

No build step. Any static server works:

```bash
python3 -m http.server 8000
# or: npx serve .
```

Opening `index.html` directly as a `file://` URL works too.

## Tests

```bash
node tests/test.js
```

21 tests: reconciliation on three real August 2026 markets, known bucket
figures, channel splits, locale variants, date formats, CSV quoting, and a
mutation test that injects a fake fee type, a fake description and a brand-new
column to prove none of them can escape.

Put the CSVs in `tests/fixtures/` (git-ignored — they hold real financial data)
or set `FIXTURE_DIR`. Tests skip cleanly if absent.

## Deploy to Render

Same shape as the other VSG dashboards — a Static Site from GitHub, free tier.

1. Push this repo to GitHub.
2. Render → **New → Static Site**, connect the repo.
   - Build command: *(leave empty)*
   - Publish directory: `.`
3. Deploy.

`render.yaml` is included if you'd rather use a Blueprint. Every push to the
default branch redeploys.

Because state lives in the browser rather than on the server, redeploying never
touches your data.

## Known limits

- **MCF doesn't tag its origin.** Kickstarter backer fulfillment and ordinary
  Shopify DTC both arrive as MCF orders. Splitting them needs an order-ID match
  against the pledge manager.
- **Storage isn't SKU-attributable.** Amazon posts it as a handful of aggregate
  rows per market, so per-title storage would need cubic-foot-month allocation
  from the inventory age report.
- **Refund admin fees are netted** inside the refund row's `selling fees`
  figure; the CSV doesn't expose them separately the way the summary PDF does.
- **History is per-browser.** See "Where your data lives" above.
