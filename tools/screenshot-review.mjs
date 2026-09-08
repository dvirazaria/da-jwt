// Headless Chrome screenshot harness for design review (CDP over Node 22+ built-in WebSocket). No deps.
// usage: python3 build.py && python3 -m http.server 8765 --bind 127.0.0.1 &  then:
//   node tools/screenshot-review.mjs docs/design-review http://localhost:8765/index.html tools/fixtures/design-review-state.json
// Captures 21 screens x dark/light at 390px (full-page where useful) into the output dir.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [outDir, baseUrl, seedPath] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const seed = readFileSync(seedPath, "utf8");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), "kupa-shoot-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=390,844", "--lang=he", "about:blank"], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); }
}
if (!wsUrl) { chrome.kill(); throw new Error("chrome did not start"); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const events = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const msgId = ++id; pending.set(msgId, { res, rej }); ws.send(JSON.stringify({ id: msgId, method, params, sessionId })); });
const waitEvent = async (method, sessionId, timeout = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const i = events.findIndex(e => e.method === method && e.sessionId === sessionId); if (i >= 0) { events.splice(i, 1); return; } await sleep(30); }
};
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: S } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, S); await send("Runtime.enable", {}, S);
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
const evaluate = async (expr) => { const r = await send("Runtime.evaluate", { expression: "(async () => { " + expr + " })()", awaitPromise: true, returnByValue: true }, S); if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
const goto = async (url) => { events.length = 0; await send("Page.navigate", { url }, S); await waitEvent("Page.loadEventFired", S); await sleep(250); };
const shot = async (name, fullPage = true) => {
  let clip;
  if (fullPage) { const { contentSize } = await send("Page.getLayoutMetrics", {}, S); clip = { x: 0, y: 0, width: 390, height: Math.min(Math.max(844, Math.ceil(contentSize.height)), 4000), scale: 1 }; }
  const { data } = await send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true }, S);
  writeFileSync(join(outDir, name + ".png"), Buffer.from(data, "base64")); console.log("shot", name, clip ? clip.height : 844);
};
const prep = async (theme, opts = {}) => {
  await goto(baseUrl + "?shoot=1");
  await evaluate(`localStorage.clear(); localStorage.setItem('poker-settle-v1', ${JSON.stringify(seed)}); ${opts.noMe ? "" : "localStorage.setItem('poker-settle-me','דביר');"} localStorage.setItem('poker-settle-theme','${theme}'); 'ok'`);
  await goto(baseUrl + (opts.query || "?shoot=2"));
};
const W = "const wait=ms=>new Promise(r=>setTimeout(r,ms)); const home=()=>document.getElementById('gamesHome'); const btn=(root,t)=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===t); const has=(root,t)=>[...root.querySelectorAll('button')].find(b=>b.textContent.includes(t));";
const openGroup = `${W} document.getElementById('modeGames').click(); await wait(100); [...document.querySelectorAll('.games-group-head')].find(h=>h.textContent.includes('פוקר יום שלישי')).click(); await wait(200); 'ok'`;

for (const theme of ["dark", "light"]) {
  const t = theme === "dark" ? "d" : "l";
  await prep(theme, { noMe: true }); await shot(`01-login-${t}`, false);
  await prep(theme); await shot(`02-dashboard-${t}`);
  await evaluate(`${W} [...home().querySelectorAll('.games-quick-action')].find(b=>b.textContent.includes('צור קבוצה')).click(); await wait(200); const i=home().querySelector('.games-create-panel input[type=text]'); i.value='ערב פוקר'; i.dispatchEvent(new Event('input',{bubbles:true})); await wait(100); 'ok'`);
  await shot(`03-dashboard-create-panel-${t}`);
  await evaluate(`${W} has(home(),'ארכיון')?.click(); await wait(200); [...home().querySelectorAll('.games-card-toggle')].forEach(b=>b.click()); await wait(200); 'ok'`);
  await shot(`04-dashboard-expanded-archive-${t}`);
  await evaluate(openGroup); await shot(`05-group-page-${t}`);
  await evaluate(`${W} [...home().querySelectorAll('.games-history-head')].slice(0,1).forEach(h=>h.click()); has(home(),'לשעבר')?.click(); await wait(200); 'ok'`);
  await shot(`06-group-page-history-expanded-${t}`);
  await evaluate(`${W} btn(home(),'התחל משחק').click(); await wait(200); const p=home().querySelector('.group-start-panel'); const gi=p.querySelector('input'); gi.value='אורח חדש'; gi.dispatchEvent(new Event('input',{bubbles:true})); [...p.querySelectorAll('button')].find(b=>b.textContent.trim()==='הוסף').click(); await wait(200); 'ok'`);
  await shot(`07-group-start-panel-${t}`);
  await evaluate(`${W} btn(home(),'ביטול')?.click(); await wait(100); has(home(),'הוסף חבר')?.click(); await wait(200); 'ok'`);
  await shot(`08-group-add-member-${t}`);
  await evaluate(`${W} has(home(),'הגדרות').click(); await wait(200); 'ok'`);
  await shot(`09-group-settings-${t}`, false);
  // archived group page
  await evaluate(`${W} document.querySelector('#groupSettings .back-arrow')?.click(); document.getElementById('modeGames').click(); await wait(100); has(home(),'ארכיון')?.click(); await wait(150); [...document.querySelectorAll('.games-group-head')].find(h=>h.textContent.includes('חבורת חמישי')).click(); await wait(200); 'ok'`);
  await shot(`10-group-archived-${t}`);
  // table: start game with דביר + רון + guest, rebuy, exit רון
  await evaluate(openGroup);
  await evaluate(`${W} btn(home(),'התחל משחק').click(); await wait(200); [...home().querySelectorAll('.group-start-panel [role=checkbox]')].filter(r=>r.getAttribute('aria-checked')!=='true' && r.textContent.includes('רון')).forEach(r=>r.click()); const p=home().querySelector('.group-start-panel'); const gi=p.querySelector('input'); gi.value='יוסי'; gi.dispatchEvent(new Event('input',{bubbles:true})); [...p.querySelectorAll('button')].find(b=>b.textContent.trim()==='הוסף').click(); await wait(100); btn(home(),'פתח שולחן').click(); await wait(300); 'ok'`);
  await evaluate(`${W} const row=[...document.querySelectorAll('.prow')].find(r=>r.querySelector('.pname')?.textContent==='יוסי'); row.querySelector('.btn-plus').click(); await wait(250); const r2=[...document.querySelectorAll('.prow')].find(r=>r.querySelector('.pname')?.textContent==='יוסי'); const c=[...r2.querySelectorAll('.chip')].find(x=>x.textContent.includes('100')); c.click(); await wait(50); c.click(); await wait(500); 'ok'`);
  await shot(`11-table-${t}`);
  await evaluate(`${W} const row=[...document.querySelectorAll('.prow')].find(r=>r.querySelector('.pname')?.textContent==='רון'); [...row.querySelectorAll('button')].find(b=>b.textContent.trim()==='יציאה').click(); await wait(250); const r2=[...document.querySelectorAll('.prow')].find(r=>r.querySelector('.pname')?.textContent==='רון'); r2.querySelector('.exit-cashout-input').value='20'; 'ok'`);
  await shot(`12-table-exit-panel-${t}`);
  await evaluate(`${W} const r2=[...document.querySelectorAll('.prow')].find(r=>r.querySelector('.pname')?.textContent==='רון'); r2.querySelector('.exit-cashout-input').dispatchEvent(new Event('input',{bubbles:true})); r2.querySelector('.exit-confirm').click(); await wait(300); const r3=[...document.querySelectorAll('.prow')].find(r=>r.querySelector('.pname')?.textContent==='דביר'); [...r3.querySelectorAll('button')].find(b=>b.textContent.includes('פירוט כניסות')).click(); await wait(200); 'ok'`);
  await shot(`13-table-exited-entries-${t}`);
  await evaluate(`${W} document.getElementById('finishGameBtn').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,bubbles:true})); await wait(1200); for (const r of document.querySelectorAll('.prow')){ const n=r.querySelector('.pname').textContent.trim(); const i=r.querySelector('.srow-input'); if(n==='דביר'){i.value='130'; i.dispatchEvent(new Event('input',{bubbles:true}));} if(n==='יוסי'){i.value='100'; i.dispatchEvent(new Event('input',{bubbles:true}));} } await wait(200); 'ok'`);
  await shot(`14-settlement-${t}`);
  await evaluate(`${W} const r=[...document.querySelectorAll('.prow')].find(r=>r.querySelector('.pname').textContent.trim()==='יוסי'); const i=r.querySelector('.srow-input'); i.value='80'; i.dispatchEvent(new Event('input',{bubbles:true})); await wait(200); 'ok'`);
  await shot(`15-settlement-unbalanced-${t}`);
  await evaluate(`${W} document.getElementById('modeProfile').click(); await wait(200); 'ok'`);
  await shot(`16-profile-balance-${t}`);
  await evaluate(`${W} [...document.querySelectorAll('.profile-tab')].find(x=>x.textContent.includes('חובות')).click(); await wait(200); 'ok'`);
  await shot(`17-profile-debts-${t}`);
  await evaluate(`${W} [...document.querySelectorAll('.debt-tab')].find(x=>x.textContent.includes('חייבים לי')).click(); await wait(200); 'ok'`);
  await shot(`18-profile-debts-owed-to-me-${t}`);
  await evaluate(`${W} [...document.querySelectorAll('.profile-tab')].find(x=>x.textContent.includes('חברים')).click(); await wait(200); 'ok'`);
  await shot(`19-profile-friends-${t}`);
  await evaluate(`${W} document.getElementById('settingsBtn').click(); await wait(200); 'ok'`);
  await shot(`20-settings-${t}`, false);
  await prep(theme, { query: "?join=VGL4EFH7" }); await shot(`21-join-notice-${t}`, false);
}
ws.close(); chrome.kill(); console.log("done");
