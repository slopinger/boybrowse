import {editRecord,deleteRecord,recordsOf} from './model.mjs';
const payloadFor = bookmark => bookmark ? {title:bookmark.title,url:bookmark.url} : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const guidFor = id => id.slice(0,8) + '-' + id.slice(8,12) + '-' + id.slice(12,16) + '-' + id.slice(16,20) + '-' + id.slice(20);
export async function captureNativeData(state, device, native) {
  if (!device?.device) throw new Error('Connect a sync account first');
  const bookmarks = (await native('bookmarks.list')).filter(b => /^https?:/.test(b.url));
  const present = new Set();
  for (const bookmark of bookmarks) {
    const id = bookmark.guid.replaceAll('-',''); present.add(id);
    const previous = state.records.find(r => r.id === id);
    const payload = {title:bookmark.title,url:bookmark.url};
    if (!previous || previous.deleted || JSON.stringify(previous.payload) !== JSON.stringify(payload)) editRecord(state,id,'bookmark',payload);
  }
  for (const id of state.nativeBookmarks || []) if (!present.has(id)) deleteRecord(state,id);
  state.nativeBookmarks = [...present];
  const pages = (await native('tabs.list')).filter(t => /^https?:/.test(t.url)).map(t => ({title:t.title,url:t.url}));
  const snapshot = recordsOf(state,'tabs').find(r => r.payload.device === device.device);
  editRecord(state,snapshot?.id,'tabs',{title:'Tabs from ' + (device.name || 'another computer'),device:device.device,pages});
  return new Map(bookmarks.map(b => [b.guid.replaceAll('-',''),payloadFor(b)]));
}
export async function applyNativeData(state, native, baseline) {
  if (baseline) {
    const current = new Map((await native('bookmarks.list')).filter(b => /^https?:/.test(b.url))
      .map(b => [b.guid.replaceAll('-',''),payloadFor(b)]));
    // A user can edit bookmarks while the network request is pending. Preserve
    // both changes instead of overwriting those edits with the pulled snapshot.
    for (const id of new Set([...baseline.keys(),...current.keys()])) {
      const before = baseline.get(id) || null, now = current.get(id) || null;
      if (same(before,now)) continue;
      const remote = state.records.find(r => r.id === id);
      const pulled = remote && !remote.deleted ? payloadFor(remote.payload) : null;
      if (same(pulled,now)) continue;
      if (pulled && !same(pulled,before)) editRecord(state,null,'bookmark',{
        ...pulled,title:pulled.title + ' (conflict copy)',conflict:true
      });
      if (now) editRecord(state,id,'bookmark',now);
      else deleteRecord(state,id);
    }
  }
  await native('bookmarks.apply',{records:state.records.filter(r => r.kind === 'bookmark').map(r => ({
    guid:guidFor(r.id),title:r.payload.title || '',url:r.payload.url || '',deleted:r.deleted
  }))});
  state.nativeBookmarks = recordsOf(state,'bookmark').map(r => r.id);
}
