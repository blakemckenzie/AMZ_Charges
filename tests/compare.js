const fs=require('fs'), P=require('../parser.js');
const F={US:'US - Amazon - August.csv',CA:'CA - Amazon - August.csv',UK:'UK - Amazon - August.csv'};
const dir='/home/claude/vsg-fee-parser/tests/fixtures/';
const out={};
for(const [m,f] of Object.entries(F)){
  const r=P.parseReport(fs.readFileSync(dir+f,'utf8'),f);
  const agg={};
  for(const a of r.allocations) agg[a.bucket]=(agg[a.bucket]||0)+a.amount;
  const ch={};
  for(const a of r.allocations) if(a.bucket==='fulfillment') ch[a.channel]=(ch[a.channel]||0)+a.amount;
  out[m]={market:r.market,currency:r.currency,period:r.period,rows:r.row_count,
    deferred:r.deferred_rows,delta:r.reconciliation_delta,
    buckets:Object.fromEntries(Object.entries(agg).map(([k,v])=>[k,+v.toFixed(2)])),
    channels:Object.fromEntries(Object.entries(ch).map(([k,v])=>[k,+v.toFixed(2)])),
    unmapped:r.unmapped, warnings:r.warnings, posted:[r.posted_min,r.posted_max]};
}
fs.writeFileSync('/tmp/js_out.json',JSON.stringify(out,null,1));
console.log('js done');
