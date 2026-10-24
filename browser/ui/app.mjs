import {native} from './bridge.mjs';
import {createState, editRecord, deleteRecord, recordsOf, safeURL, uid} from './model.mjs';
import {SyncClient} from './sync.mjs';

const $ = id => document.getElementById(id);
let state = createState(), tabs = [], noteId = null, toastTimer;
let saveQueue = Promise.resolve(), naming, generation = 0, unsaved = 0;
function notify(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500);
}
function guard(fn) { return (...args) => { try { return Promise.resolve(fn(...args)).catch(e => notify(e.message)); } catch (e) { notify(e.message); } }; }
function node(tag, text, cls) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  return element;
}
function action(label, fn) {
  const button = node('button', label); button.type = 'button';
  button.addEventListener('click', guard(fn)); return button;
}
function save() {
  const snapshot = structuredClone(state);
  unsaved++;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    snapshot._generation = generation;
    generation = await native('state.save', snapshot);
    state._generation = generation;
  }).finally(() => {unsaved--;});
  return saveQueue;
}
const client = new SyncClient({state, save, secret:{}, saveSecret: secret => native('secret.save',{value:JSON.stringify(secret)})});
async function navigate(value) { await native('navigate', {url:safeURL(value)}); }
function settings() { return recordsOf(state,'settings')[0]?.payload || {decoration:'full',theme:'light',motion:false,focus:false}; }
function applySettings() {
  const options = settings();
  document.body.dataset.decoration = ['full','soft','quiet'].includes(options.decoration) ? options.decoration : 'full';
  document.body.dataset.theme = ['light','dark','system'].includes(options.theme) ? options.theme : 'light';
  document.body.dataset.motion = String(!!options.motion);
  document.body.dataset.focus = String(!!options.focus);
  $('decoration').value = document.body.dataset.decoration;
  $('theme').value = document.body.dataset.theme;
  $('motion').checked = !!options.motion;
}
async function updateSettings(patch) {
  const record = recordsOf(state,'settings')[0];
  editRecord(state,record?.id,'settings',{...settings(),...patch});
  applySettings(); await save();
}
function show(view) {
  if (!document.querySelector('section#' + view)) view = 'home';
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== view);
  document.querySelectorAll('[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
    if (el.dataset.view === view) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  });
  $('location-label').textContent = 'YOUR LITTLE CORNER / ' + view.toUpperCase();
  history.replaceState(null,'','#' + view);
  if (view === 'tabs') guard(refreshTabs)();
  if (view === 'workspaces') renderWorkspaces();
  if (view === 'notes') renderNotes();
  if (view === 'sync') guard(renderSync)();
  if (view === 'bookmarks') guard(renderBookmarks)();
}
function row(title, subtitle) {
  const element = node('div',undefined,'row');
  const copy = node('div',undefined,'row-copy');
  copy.append(node('span',title,'row-title'),node('small',subtitle));
  element.append(copy); return element;
}
function empty(container,text) { container.replaceChildren(node('div',text,'empty')); }
async function refreshTabs() {
  tabs = await native('tabs.list');
  $('tab-count').textContent = String(tabs.length);
  const list = $('tab-list'); list.replaceChildren();
  for (const tab of tabs) {
    const item = row(tab.title || tab.url,tab.url);
    item.draggable = true;
    item.addEventListener('dragstart',e => e.dataTransfer.setData('text/plain',String(tab.index)));
    item.addEventListener('dragover',e => e.preventDefault());
    item.addEventListener('drop',guard(async e => {
      e.preventDefault();
      const index = Number(e.dataTransfer.getData('text/plain'));
      if (!Number.isInteger(index)) return;
      await native('tabs.move',{index,target:tab.index}); await refreshTabs();
    }));
    const select = node('input'); select.type = 'checkbox'; select.dataset.index = tab.index;
    select.setAttribute('aria-label','Select ' + (tab.title || tab.url) + ' for split view');
    item.prepend(select);
    item.append(action('Open', () => native('tabs.activate',{index:tab.index})),
      action(tab.pinned ? 'Unpin' : 'Pin',async () => {await native('tabs.pin',{index:tab.index}); await refreshTabs();}),
      action('×',async () => {await native('tabs.close',{index:tab.index}); await refreshTabs();}));
    item.lastChild.setAttribute('aria-label','Close ' + (tab.title || tab.url));
    list.append(item);
  }
}
function nameDialog(title,initial,callback) {
  naming = callback; $('name-heading').textContent = title; $('new-name').value = initial;
  $('name-dialog').showModal(); $('new-name').focus();
}
async function saveWorkspace() {
  const current = await native('tabs.list');
  const pages = current.filter(t => /^https?:/.test(t.url)).map(t => ({url:t.url,title:t.title,pinned:t.pinned}));
  if (!pages.length) { notify('Open a web page first, then save this window.'); return; }
  nameDialog('A room for these tabs','My rabbit hole',async title => {
    editRecord(state,null,'workspace',{title,pages}); await save(); renderWorkspaces(); notify('Workspace saved.');
  });
}
function renderWorkspaces() {
  const list = $('workspace-list'); list.replaceChildren();
  const records = recordsOf(state,'workspace');
  if (!records.length) return empty(list,'No rooms yet. Save a window full of tabs to begin.');
  for (const record of records) {
    const card = node('article',undefined,'card');
    card.append(node('span',record.payload.conflict ? 'CONFLICT COPY · KEPT BOTH' : 'YOUR OWN LITTLE ROOM','card-label'),
      node('h2',record.payload.title),node('p',record.payload.pages.length + ' saved tabs'));
    card.append(action('Open workspace ↗',async () => {
      for (const page of record.payload.pages.slice(0,100)) await navigate(page.url);
    }),action('Rename',() => nameDialog('Rename workspace',record.payload.title,async title => {
      editRecord(state,record.id,'workspace',{...record.payload,title}); await save(); renderWorkspaces();
    })),action('Delete',async () => {deleteRecord(state,record.id); await save(); renderWorkspaces();}));
    list.append(card);
  }
}
function newNote() {
  nameDialog('A new brain scrap','Untitled thought',async title => {
    const record = editRecord(state,null,'note',{title,text:''}); noteId = record.id;
    await save(); show('notes'); openNote(record.id);
  });
}
function renderNotes() {
  const list = $('note-list'); list.replaceChildren();
  const notes = recordsOf(state,'note');
  if (!notes.length) { $('note-editor').hidden = true; return empty(list,'Nothing here yet. A rare moment of peace.'); }
  for (const record of notes) list.append(action(record.payload.title || 'Untitled thought',() => openNote(record.id)));
  if (!notes.some(n => n.id === noteId)) noteId = notes[0].id;
  openNote(noteId);
}
function openNote(id) {
  const record = state.records.find(r => r.id === id && !r.deleted);
  if (!record) return;
  noteId = id; $('note-editor').hidden = false;
  $('note-title').value = record.payload.title || '';
  $('note-text').value = record.payload.text || '';
}
async function saveNote() {
  const record = state.records.find(r => r.id === noteId);
  if (!record) return;
  editRecord(state,noteId,'note',{...record.payload,title:$('note-title').value,text:$('note-text').value});
  $('note-saved').textContent = 'Saving…';
  await save(); $('note-saved').textContent = 'Saved on this computer';
}
async function renderBookmarks() {
  const bookmarks = await native('bookmarks.list');
  const list = $('bookmark-list'); list.replaceChildren();
  if (!bookmarks.length) return empty(list,'Bookmark a page with the star in your address bar.');
  for (const bookmark of bookmarks) {
    const item = row(bookmark.title,bookmark.url);
    item.append(action('Open ↗',() => navigate(bookmark.url))); list.append(item);
  }
}
function downloadKit(name, value) {
  const blob = new Blob([JSON.stringify(value,null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob); const a = node('a'); a.href = url; a.download = name;
  a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
async function renderSync() {
  const connected = !!client.secret?.token;
  $('enroll-form').hidden = connected; $('connected').hidden = !connected;
  if (!connected) return;
  $('account-label').textContent = client.secret.name || client.secret.server;
  const result = await client.request('devices');
  const list = $('device-list'); list.replaceChildren();
  for (const device of result.devices) {
    const item = row(device.name,device.id === client.secret.device ? 'This computer' : 'Paired device');
    if (device.id !== client.secret.device) item.append(action('Revoke',async () => {
      await client.request('devices/' + device.id,undefined,'DELETE'); await renderSync();
    }));
    list.append(item);
  }
}
async function synchronize() {
  $('sync-status').textContent = '↔ syncing…';
  try {
    await client.run();
    applySettings(); $('sync-status').textContent = '● encrypted sync connected';
    notify('Your corner is up to date.');
    const current = location.hash.slice(1); if (current === 'notes') renderNotes(); if (current === 'workspaces') renderWorkspaces();
  } catch (e) { $('sync-status').textContent = '○ sync needs attention'; throw e; }
}
const commands = [
  ['Your little corner',() => show('home')],['Tab hoard',() => show('tabs')],
  ['Workspaces',() => show('workspaces')],['Brain scraps',() => show('notes')],
  ['Toggle vertical tabs',() => native('command',{name:'vertical'})],
  ['New temporary window',() => native('command',{name:'private'})],
  ['Reopen closed tab',() => native('command',{name:'restore'})],
  ['Save workspace',saveWorkspace],['Write a brain scrap',newNote],
  ['Sync now',synchronize],['Toggle focus mode',() => updateSettings({focus:!settings().focus})],
  ['History',() => native('navigate',{url:'chrome://history/'})],
  ['Downloads',() => native('navigate',{url:'chrome://downloads/'})],
  ['Settings',() => native('navigate',{url:'chrome://settings/'})]
];
function renderCommands() {
  const input = $('command-input').value.toLowerCase(), list = $('command-results'); list.replaceChildren();
  const choices = [...commands,...tabs.map(t => ['Tab: ' + (t.title || t.url),() => native('tabs.activate',{index:t.index})])];
  for (const [title,fn] of choices.filter(([title]) => title.toLowerCase().includes(input)).slice(0,18))
    list.append(action(title,async () => {$('palette').close(); await fn();}));
  if (input.trim()) list.append(action('Search the web for “' + $('command-input').value + '”',async () => {
    const value = $('command-input').value; $('palette').close(); await navigate(value);
  }));
}
function openPalette() { $('palette').showModal(); $('command-input').value = ''; renderCommands(); $('command-input').focus(); }
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click',() => show(button.dataset.view)));
document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click',guard(() => native('command',{name:button.dataset.command}))));
document.querySelectorAll('[data-url]').forEach(button => button.addEventListener('click',guard(() => navigate(button.dataset.url))));
document.querySelectorAll('[data-internal]').forEach(button => button.addEventListener('click',guard(() => native('navigate',{url:'chrome://' + button.dataset.internal}))));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => $(button.dataset.close).close()));
$('search').addEventListener('submit',guard(async e => {e.preventDefault(); await navigate($('address').value);}));
$('name-form').addEventListener('submit',guard(async e => {
  e.preventDefault(); const name = $('new-name').value.trim(); if (!name) return;
  await naming(name); $('name-dialog').close();
}));
for (const id of ['save-workspace','workspace-create']) $(id).addEventListener('click',guard(saveWorkspace));
for (const id of ['new-note','note-create']) $(id).addEventListener('click',newNote);
for (const id of ['note-text','note-title']) $(id).addEventListener('input',guard(saveNote));
$('note-delete').addEventListener('click',guard(async () => {deleteRecord(state,noteId); await save(); noteId = null; renderNotes();}));
$('refresh-tabs').addEventListener('click',guard(refreshTabs));
$('split-tabs').addEventListener('click',guard(async () => {
  const selected = [...$('tab-list').querySelectorAll('input:checked')].map(input => Number(input.dataset.index));
  if (selected.length !== 2) throw new Error('Select exactly two tabs for split view');
  await native('tabs.split',{index:selected[0],target:selected[1]});
}));
$('shields').addEventListener('click',guard(() => native('blocker.open')));
$('private-window').addEventListener('click',guard(() => native('command',{name:'private'})));
$('palette-open').addEventListener('click',openPalette);
$('command-input').addEventListener('input',renderCommands);
$('command-input').addEventListener('keydown',e => {if (e.key === 'Enter') {e.preventDefault(); $('command-results').querySelector('button')?.click();}});
document.addEventListener('keydown',e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {e.preventDefault(); openPalette();}
});
$('decoration').addEventListener('change',guard(() => updateSettings({decoration:$('decoration').value})));
$('theme').addEventListener('change',guard(() => updateSettings({theme:$('theme').value})));
$('motion').addEventListener('change',guard(() => updateSettings({motion:$('motion').checked})));
$('focus-toggle').addEventListener('click',guard(() => updateSettings({focus:!settings().focus})));
$('enroll-form').addEventListener('submit',guard(async e => {
  e.preventDefault();
  await client.enroll($('server').value,$('invitation').value,$('device-name').value);
  $('invitation').value = ''; await renderSync();
  downloadKit('boybrowse-recovery.json',client.recoveryBundle()); await synchronize();
}));
$('sync-now').addEventListener('click',guard(synchronize));
$('pair-device').addEventListener('click',guard(async () => downloadKit('boybrowse-pairing.json',await client.pairingBundle())));
$('export-recovery').addEventListener('click',guard(() => downloadKit('boybrowse-recovery.json',client.recoveryBundle())));
$('disconnect').addEventListener('click',guard(async () => {
  await client.request('devices/' + client.secret.device,undefined,'DELETE');
  await native('secret.clear'); client.secret = {}; $('sync-status').textContent = '● on this computer'; await renderSync();
}));
$('import-kit').addEventListener('change',guard(async () => {
  const file = $('import-kit').files[0]; if (!file) return;
  if (file.size > 16384) throw new Error('Kit file is too large');
  const bundle = JSON.parse(await file.text());
  if (bundle.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(bundle.key)) throw new Error('Invalid kit');
  if (bundle.invitation) await client.enroll(bundle.server,bundle.invitation,$('device-name').value,bundle.key);
  else {await client.recover(bundle,$('device-name').value); downloadKit('boybrowse-recovery.json',client.recoveryBundle());}
  $('import-kit').value = ''; await renderSync(); await synchronize();
}));
async function boot() {
  const stored = await native('state.read');
  if (stored.version === 1 && Array.isArray(stored.records)) state = stored;
  client.state = state; generation = state._generation || 0;
  try {
    const secret = await native('secret.read');
    if (secret) client.secret = JSON.parse(secret);
  } catch (error) {notify(error.message);}
  applySettings(); show(location.hash.slice(1) || 'home');
  await refreshTabs();
  if (client.secret?.token) $('sync-status').textContent = '● encrypted sync connected';
}
window.addEventListener('beforeunload',event => {if (unsaved) {event.preventDefault();event.returnValue = '';}});
guard(boot)();
