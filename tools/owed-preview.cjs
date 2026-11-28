const {chromium}=require('/tmp/preview/node_modules/playwright'), QR=require('/tmp/preview/node_modules/qrcode'), assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
(async()=>{const browser=await chromium.launch({args:process.env.EMULATOR?['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessPermissionPrompt,PrivateNetworkAccessSendPreflights']:[]});let owner;try{
const email='finai-qa-'+crypto.randomUUID()+'@example.invalid',pw=crypto.randomUUID(),pass=crypto.randomUUID();
async function device(first){const ctx=await browser.newContext({serviceWorkers:'block'});const p=await ctx.newPage();p.on('requestfailed',r=>console.log('Request failed',new URL(r.url()).origin,r.failure()?.errorText));if(process.env.EMULATOR)await ctx.grantPermissions(['local-network-access'],{origin:'https://jblagana.github.io'});
await ctx.addInitScript(pass=>localStorage.setItem('fin.cloud.v1',JSON.stringify({pass,on:1})),pass);
if(process.env.CANDIDATE)await ctx.route('**/app.js*',r=>r.fulfill({path:'app.js',contentType:'application/javascript'}));
if(process.env.EMULATOR)await ctx.route('**/firebase-firestore-compat.js',async r=>{const resp=await r.fetch();await r.fulfill({response:resp,body:(await resp.text())+"\n;{const init=firebase.initializeApp.bind(firebase);firebase.initializeApp=(cfg,...args)=>{const app=init({...cfg,projectId:'demo-finai'},...args);app.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});app.firestore().useEmulator('127.0.0.1',8080);return app;};}"});});
await p.goto('https://jblagana.github.io/finance-app/');await p.waitForFunction(()=>window.firebase?.apps?.length && window.FinApp && document.querySelector('#boot.off'));
if(!process.env.CANDIDATE)assert.equal(await p.evaluate(()=>FinApp.shellVersion),'75.65');
await p.evaluate(async({email,pw,first})=>{const auth=firebase.auth(); if(first)await auth.createUserWithEmailAndPassword(email,pw);else await auth.signInWithEmailAndPassword(email,pw);},{email,pw,first});
await p.locator('.tab[data-tab=owed]').click();await p.locator('#myPaymentQRs').click();return p}
owner=await device(true);const other=await device(false);
const data=await QR.toBuffer('demo-owner-sync');
await owner.locator('#paymentQRBody input[type=file]').setInputFiles({name:'demo.png',mimeType:'image/png',buffer:data});await owner.locator('#qrReview input[maxlength]').fill('Owner test wallet');await owner.getByRole('button',{name:'Save QR',exact:true}).click();
await owner.locator('#paymentQRBody summary').click();const expected=await owner.locator('#paymentQRBody img').getAttribute('src');
await other.locator('#paymentQRBody summary').waitFor({timeout:90000});await other.locator('#paymentQRBody summary').click();assert.equal(await other.locator('#paymentQRBody img').getAttribute('src'),expected);
fs.mkdirSync('snips',{recursive:true});await other.screenshot({path:'snips/device-two.png'});console.log('PASS same owner QR bytes on independent device');
await other.locator('[data-qr-remove]').click();await other.locator('#confirmYes').click();await owner.locator('#paymentQRBody summary').waitFor({state:'detached',timeout:90000});console.log('PASS deletion synchronized back to first device');
}finally{if(owner)await owner.evaluate(async()=>{const u=firebase.auth().currentUser;if(u){await firebase.firestore().collection('finai').doc(u.uid).delete();await u.delete();}}).catch(()=>{});await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});