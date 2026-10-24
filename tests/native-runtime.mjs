// Exercise the actual patched Chromium binary through its DevTools protocol.
// No downloaded test framework or external sites are involved.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';

const binary = process.argv[2], output = process.argv[3];
if (!binary || !output) throw new Error('Usage: node native-runtime.mjs BROWSER OUTPUT_DIRECTORY');
await mkdir(output,{recursive:true});
const directory = await mkdtemp(join(tmpdir(),'boybrowse-runtime-'));
const profile = join(directory,'profile');
let browser, cdp, browserExit;
let blocked = 0, allowed = 0;
const http = createServer((request,response) => {
  response.setHeader('Content-Type','text/html; charset=utf-8');
  if (request.url === '/blocked.js' || request.url === '/allowed.js') {
    const rejected = request.url === '/blocked.js';
    if (rejected) blocked++; else allowed++;
    response.setHeader('Content-Type','application/javascript');
    response.end('globalThis.' + (rejected ? 'blocked' : 'allowed') + 'TrackerLoaded = true;');
    return;
  }
  const port = http.address().port;
  response.end('<!doctype html><title>Boybrowse local fixture</title><h1>Local browser fixture</h1>' +
    (request.url === '/shields' ? '<script src="http://ad.doubleclick.net:' + port + '/blocked.js"></script>' +
      '<script src="http://allowed.boybrowse.test:' + port + '/allowed.js"></script>' : ''));
});
http.listen(0,'127.0.0.1');
await once(http,'listening');
const origin = 'http://127.0.0.1:' + http.address().port;

async function until(fn,description,timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {const result = await fn(); if (result) return result;} catch (error) {last = error;}
    await pause(100);
  }
  throw new Error('Timed out: ' + description + (last ? ': ' + last.message : ''));
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map();
    socket.addEventListener('message',event => {
      const result = JSON.parse(event.data);
      if (!result.id) return;
      const pending = this.pending.get(result.id);
      if (!pending) return;
      this.pending.delete(result.id); clearTimeout(pending.timer);
      result.error ? pending.reject(new Error(JSON.stringify(result.error))) : pending.resolve(result.result);
    });
    socket.addEventListener('close',() => {
      for (const pending of this.pending.values()) {clearTimeout(pending.timer);pending.reject(new Error('Browser disconnected'));}
      this.pending.clear();
    });
  }
  send(method,params = {},sessionId) {
    return new Promise((resolve,reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {this.pending.delete(id);reject(new Error('DevTools timeout: ' + method));},30000);
      this.pending.set(id,{resolve,reject,timer});
      this.socket.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})}));
    });
  }
  async evaluate(session,expression) {
    const result = await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:20000},session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async page(url,context) {
    const {targetId} = await this.send('Target.createTarget',{url,...(context ? {browserContextId:context} : {})});
    const {sessionId} = await this.send('Target.attachToTarget',{targetId,flatten:true});
    await this.send('Page.enable',{},sessionId);
    await until(() => this.evaluate(sessionId,'location.href !== "about:blank" && document.readyState === "complete"'),'page load: ' + url);
    return {id:targetId,session:sessionId};
  }
  async native(page,operation,data = {}) {
    return this.evaluate(page.session,'(async () => (await import("chrome://boybrowse/bridge.js")).native(' +
      JSON.stringify(operation) + ',' + JSON.stringify(data) + '))()');
  }
}
async function start() {
  let log = '';
  browser = spawn(binary,[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--no-first-run','--no-default-browser-check','--disable-background-networking','--window-size=1440,1000',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-proxy-server',
    '--host-resolver-rules=MAP ad.doubleclick.net 127.0.0.1, MAP allowed.boybrowse.test 127.0.0.1',
    '--user-data-dir=' + profile,'chrome://boybrowse/'
  ],{stdio:['ignore','ignore','pipe']});
  browser.stderr.on('data',data => {log += data;});
  browserExit = once(browser,'exit');
  browser.on('error',error => {log += error.message;});
  const address = await until(async () => {
    if (browser.exitCode !== null) throw new Error('Browser exited: ' + log.slice(-2000));
    const lines = (await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');
    const response = await fetch('http://127.0.0.1:' + lines[0] + '/json/version');
    return (await response.json()).webSocketDebuggerUrl;
  },'DevTools endpoint',60000);
  const socket = new WebSocket(address);
  await once(socket,'open');
  cdp = new CDP(socket);
  return async () => {await writeFile(join(output,'browser.log'),log);};
}
async function stop() {
  if (!browser || browser.exitCode !== null) return;
  const child = browser, exited = browserExit;
  const timer = setTimeout(() => child.kill('SIGKILL'),10000);
  timer.unref();
  try {try {await cdp.send('Browser.close');} catch {} await exited;}
  finally {clearTimeout(timer);}
}
const bookmarkId = 'fe0fdf9b-e64c-4e85-ae16-e16f9d4e91c1';
const note = {id:'bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb',revision:0,kind:'note',deleted:false,dirty:true,
  payload:{title:'Native persistence fixture',text:'<img src=x onerror="globalThis.unwantedScript=1">'}};
let saveLog;
try {
  saveLog = await start();
  const home = await cdp.page('chrome://boybrowse/');
  await until(() => cdp.evaluate(home.session,'document.body.dataset.decoration === "full"'),'dashboard bridge initialization');
  assert.match(await cdp.evaluate(home.session,'document.title'),/Boybrowse/);
  assert.match(await cdp.evaluate(home.session,'(async () => (await fetch("app.js")).headers.get("content-type"))()'),/(java|ecma)script/);
  assert.equal(await cdp.evaluate(home.session,'(async () => (await fetch("chrome://boybrowse/icon.svg")).ok)()'),true);
  assert.equal(await cdp.evaluate(home.session,'document.querySelector("h1").textContent.includes("sloppier")'),true);

  const before = await cdp.native(home,'state.read');
  const generation = await cdp.native(home,'state.save',{...before,version:1,records:[note],cursor:0,pending:null});
  assert.equal(generation,(before._generation || 0) + 1);
  await assert.rejects(cdp.native(home,'state.save',{...before,version:1,records:[]}),/Another Boybrowse page/);
  await cdp.send('Page.reload',{},home.session);
  await until(() => cdp.evaluate(home.session,'document.body.dataset.decoration === "full"'),'dashboard reload');
  assert.equal((await cdp.native(home,'state.read')).records[0].payload.title,note.payload.title);
  await cdp.evaluate(home.session,'document.querySelector("[data-view=notes]").click()');
  assert.equal(await cdp.evaluate(home.session,'globalThis.unwantedScript'),undefined);
  assert.match(await cdp.evaluate(home.session,'document.getElementById("note-list").textContent'),/Native persistence fixture/);

  // Native model operations, including validation before any batch mutation.
  await cdp.native(home,'bookmarks.apply',{records:[{guid:bookmarkId,title:'Fixture bookmark',url:origin + '/a',deleted:false}]});
  assert((await cdp.native(home,'bookmarks.list')).some(b => b.guid === bookmarkId && b.title === 'Fixture bookmark'));
  const untouched = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await assert.rejects(cdp.native(home,'bookmarks.apply',{records:[
    {guid:untouched,title:'Must stay absent',url:origin + '/a'},
    {guid:bookmarkId,title:'Unsafe',url:'javascript:alert(1)'}
  ]}),/Invalid bookmark/);
  assert(!(await cdp.native(home,'bookmarks.list')).some(b => b.guid === untouched));
  await cdp.native(home,'bookmarks.apply',{records:[{guid:bookmarkId,title:'Changed',url:origin + '/b',deleted:false}]});
  assert((await cdp.native(home,'bookmarks.list')).some(b => b.guid === bookmarkId && b.url === origin + '/b'));
  await cdp.native(home,'bookmarks.apply',{records:[{guid:bookmarkId,title:'',url:'',deleted:true}]});
  assert(!(await cdp.native(home,'bookmarks.list')).some(b => b.guid === bookmarkId));
  await assert.rejects(cdp.native(home,'navigate',{url:'file:///etc/passwd'}),/scheme not allowed/);

  await cdp.native(home,'navigate',{url:origin + '/a'});
  await cdp.native(home,'navigate',{url:origin + '/b'});
  const tabs = await until(async () => {
    const list = await cdp.native(home,'tabs.list');
    return list.some(t => t.url === origin + '/a') && list.some(t => t.url === origin + '/b') ? list : false;
  },'native tab navigation');
  const a = tabs.find(t => t.url === origin + '/a'), b = tabs.find(t => t.url === origin + '/b');
  assert(a.id !== b.id && Number.isInteger(a.id));
  await cdp.native(home,'tabs.pin',{tab:a.id});
  assert((await cdp.native(home,'tabs.list')).find(t => t.id === a.id).pinned);
  await cdp.native(home,'tabs.pin',{tab:a.id});
  await cdp.native(home,'tabs.move',{tab:a.id,targetTab:b.id});
  const moved = await cdp.native(home,'tabs.list');
  assert(moved.find(t => t.id === a.id).index > moved.find(t => t.id === b.id).index);
  await assert.rejects(cdp.native(home,'tabs.close',{tab:-12345}),/no longer exists/);
  await cdp.native(home,'tabs.split',{tab:a.id,targetTab:b.id});
  assert((await cdp.native(home,'tabs.list')).filter(t => [a.id,b.id].includes(t.id)).every(t => t.split));
  await assert.rejects(cdp.native(home,'tabs.split',{tab:a.id,targetTab:b.id}),/same pin and group/);
  await cdp.native(home,'tabs.close',{tab:b.id});
  await cdp.native(home,'command',{name:'restore'});
  await until(async () => (await cdp.native(home,'tabs.list')).some(t => t.url === origin + '/b'),'restore closed tab');

  const privateContext = await cdp.send('Target.createBrowserContext');
  const privatePage = await cdp.page('chrome://boybrowse/',privateContext.browserContextId);
  assert.notEqual(await cdp.evaluate(privatePage.session,'document.body?.dataset.decoration'),'full');
  assert.equal(await cdp.evaluate(privatePage.session,'typeof globalThis.chrome?.send'),'undefined');
  await cdp.send('Target.disposeBrowserContext',{browserContextId:privateContext.browserContextId});

  const shields = await cdp.page('chrome-extension://dcahalgkkhldgcodlieblmhfkjmggehp/options.html');
  assert((await cdp.evaluate(shields.session,'chrome.declarativeNetRequest.getEnabledRulesets()')).includes('starter'));
  const fixture = await cdp.page(origin + '/shields');
  await until(() => cdp.evaluate(fixture.session,'globalThis.allowedTrackerLoaded === true'),'unblocked positive control');
  assert.equal(await cdp.evaluate(fixture.session,'globalThis.blockedTrackerLoaded'),undefined);
  assert.equal(blocked,0,'tracker request must be blocked before reaching the fixture server');
  assert.equal(allowed,1,'the positive control must actually use the network');

  await cdp.send('Page.bringToFront',{},home.session);
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',windowsVirtualKeyCode:75,modifiers},home.session);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'k',code:'KeyK',windowsVirtualKeyCode:75,modifiers},home.session);
  assert.equal(await cdp.evaluate(home.session,'document.getElementById("palette").open'),true);
  await cdp.send('Accessibility.enable',{},home.session);
  const accessibility = await cdp.send('Accessibility.getFullAXTree',{},home.session);
  assert(accessibility.nodes.some(n => n.role?.value === 'dialog' && n.name?.value === 'Where to?'));
  await cdp.evaluate(home.session,'document.getElementById("palette").close()');
  const screenshot = await cdp.send('Page.captureScreenshot',{format:'png'},home.session);
  await writeFile(join(output,'dashboard.png'),Buffer.from(screenshot.data,'base64'));
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},home.session);
  assert(await cdp.evaluate(home.session,'document.documentElement.scrollWidth <= 390'),'mobile layout must fit the viewport');
  const mobile = await cdp.send('Page.captureScreenshot',{format:'png'},home.session);
  await writeFile(join(output,'dashboard-mobile.png'),Buffer.from(mobile.data,'base64'));

  // No plaintext fallback is permitted when the test environment lacks a keyring.
  const sentinel = 'Boybrowse-OSCrypt-test-only-' + crypto.randomUUID();
  let protectedSecret = false;
  try {
    await cdp.native(home,'secret.save',{value:sentinel});
    assert.equal(await cdp.native(home,'secret.read'),sentinel);
    protectedSecret = true;
  } catch (error) {assert.match(error.message,/OS credential protection unavailable|Encryption failed/);}
  await stop(); await saveLog();
  const preferences = await readFile(join(profile,'Default','Preferences'),'utf8');
  assert(!preferences.includes(sentinel),'credentials must never be stored as plaintext preferences');

  saveLog = await start();
  const restarted = await cdp.page('chrome://boybrowse/');
  await until(() => cdp.evaluate(restarted.session,'!!document.body.dataset.decoration'),'browser restart');
  assert.equal((await cdp.native(restarted,'state.read')).records[0].payload.title,note.payload.title);
  if (protectedSecret) assert.equal(await cdp.native(restarted,'secret.read'),sentinel);
  await cdp.native(restarted,'secret.clear');
  assert.equal(await cdp.native(restarted,'secret.read'),'');
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,protectedSecret,
    checks:['WebUI resources','persistent state','stale-write rejection','safe note rendering','native bookmarks',
      'stable tab IDs','pin/move/split/restore','private isolation','real network blocking','command accessibility','credential protection','restart']},null,2));
  console.log('PASS: native browser UI, persistence, bookmarks, tabs, privacy isolation, Shields, and restart');
} finally {
  await stop();
  if (saveLog) await saveLog();
  await new Promise(resolve => http.close(resolve));
}
