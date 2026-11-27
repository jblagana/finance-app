const {chromium}=require('/tmp/preview/node_modules/playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
 await page.goto('http://localhost:8734/');
 await page.waitForFunction(()=>window.FinApp && document.querySelector('#boot.off'));
 await page.evaluate(()=>{const f=FinApp;f.state.owed.people=[{id:'m',name:'Mika',entries:[]},{id:'v',name:'Vhal',entries:[]}];f.emit('owed');});
 await page.locator('.tab[data-tab=owed]').evaluate(el=>el.click());
 const card=page.locator('[data-ow-pid=m]');
 assert.equal(await card.locator('summary').first().isVisible(),false);
 await card.locator('[data-ow-open]').click();
 await card.locator('.owed-person-menu summary').click();
 for (const width of [320,375,390,430]) {
   await page.setViewportSize({width,height:844});
   const entry=await card.locator('[data-ow-toggle]').boundingBox();
   const menu=await card.locator('.owed-person-menu>div').boundingBox();
   assert(entry.width<140 && menu.x>=0 && menu.x+menu.width<=width, JSON.stringify({width,entry,menu}));
 }
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('#myPaymentQRs svg').count(),1);
 fs.mkdirSync('snips',{recursive:true});
 await page.screenshot({path:'snips/01-expanded-menu.png'});
 await card.locator('.owed-person-menu summary').click();
 await page.locator('#myPaymentQRs').click();
 const sample=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=320;c.height=480;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,320,480);x.fillStyle='black';x.font='bold 24px sans-serif';x.fillText('Demo bank',65,65);for(let i=0;i<21;i++)for(let j=0;j<21;j++)if((i*7+j*3+i*j)%5<2)x.fillRect(55+i*10,125+j*10,10,10);return c.toDataURL().split(',')[1]});
 await page.locator('#paymentQRBody input[type=file]').setInputFiles({name:'demo.png',mimeType:'image/png',buffer:Buffer.from(sample,'base64')});
 await page.locator('#qrReview input[maxlength]').fill('Demo bank');
 await page.getByRole('button',{name:'Square',exact:true}).click();
 await page.screenshot({path:'snips/02-square-crop.png'});
 await page.getByRole('button',{name:'Save QR',exact:true}).click();
 await page.locator('#paymentQRBody summary').click();
 await page.screenshot({path:'snips/03-saved-qr.png'});
 assert(await page.locator('#paymentQRBody img').evaluate(el=>el.naturalWidth===el.naturalHeight && el.naturalWidth>0));
 }finally{await browser.close();}
})().catch(err=>{console.error(err);process.exitCode=1});