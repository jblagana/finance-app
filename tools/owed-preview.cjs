const {chromium}=require('/tmp/preview/node_modules/playwright');
const QR=require('/tmp/preview/node_modules/qrcode'), fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch();try{
async function device(){const ctx=await browser.newContext({viewport:{width:390,height:844}});await ctx.route('**/app.js*',r=>r.fulfill({path:'app.js',contentType:'application/javascript'}));const p=await ctx.newPage();await p.goto('https://jblagana.github.io/finance-app/');await p.waitForFunction(()=>window.FinApp && document.querySelector('#boot.off'));console.log('Deployed shell',await p.evaluate(()=>FinApp.shellVersion));await p.locator('.tab[data-tab=owed]').click();return p}
const a=await device(),b=await device(); fs.mkdirSync('snips',{recursive:true});
await a.locator('#owedName').fill('Demo B');await a.locator('#owedForm button').click();
const aid=await a.locator('[data-ow-pid]').first().getAttribute('data-ow-pid');
const link=await a.evaluate(async id=>{const c=await FinApp.connCreateInvite(id,'Demo A');return FinApp.connInviteLink(c,id)},aid);
const bid=await b.evaluate(async link=>{const j=FinApp.connParseJoin(new URL(link).hash);let inv;for(let i=0;i<15&&!inv;i++){inv=await FinApp.connReadInvite(j);if(!inv)await new Promise(r=>setTimeout(r,2000));}if(!inv)throw Error('Invite not delivered');return (await FinApp.connJoin(j,inv,null,true)).id},link);
await a.evaluate(id=>FinApp.connSync(id),aid);
async function upload(p,label){await p.locator('#myPaymentQRs').click();await p.locator('#paymentQRBody input[type=file]').setInputFiles({name:'demo.png',mimeType:'image/png',buffer:await QR.toBuffer('Demo only '+label)});await p.locator('#qrReview input[maxlength]').fill(label);await p.getByRole('button',{name:'Save QR',exact:true}).click();await p.locator('#paymentQRBody summary').click();const src=await p.locator('#paymentQRBody img').getAttribute('src');await p.locator('#paymentQRClose').click();return src}
async function openPeer(page,id){const card=page.locator('[data-ow-pid="'+id+'"]');if(!(await card.locator('.owed-person-menu').isVisible()))await card.locator('[data-ow-open]').click();await card.locator('.owed-person-menu summary').click();await card.locator('[data-ow-qr]').click();}
await openPeer(b,bid);assert.equal(await b.locator('#paymentQRBody img').count(),0);
const expected=await upload(a,'Demo bank');async function check(){const img=b.locator('#paymentQRBody img');await img.waitFor({timeout:140000});assert.equal(await img.getAttribute('src'),expected);}
await check();console.log('PASS already-open peer sheet updated');
await b.locator('#paymentQRClose').click();await b.evaluate(async id=>{const c=FinApp.state.owed.people.find(p=>p.id===id).conn;delete c.qrCodes;delete c.qrRevision;await FinApp.saveOwed();},bid);
await b.reload();await b.waitForFunction(()=>window.FinApp && document.querySelector('#boot.off'));await b.locator('.tab[data-tab=owed]').click();await openPeer(b,bid);await check();console.log('PASS restored existing link recovered missing QR without re-upload or re-pair');await b.screenshot({path:'snips/recovered-qr.png'});
await a.evaluate(id=>FinApp.connDisconnect(id),aid);
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});