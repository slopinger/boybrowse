import test from 'node:test';
import assert from 'node:assert/strict';
import {captureNativeData,applyNativeData} from '../browser/ui/native-sync.mjs';
import {createState,editRecord,recordsOf} from '../browser/ui/model.mjs';

test('native capture preserves bookmark identity, detects local deletion, and excludes browser-internal tabs',async () => {
  const state = createState(), device = {device:'this-device',name:'laptop'};
  let bookmarks = [{guid:'fe0fdf9b-e64c-4e85-ae16-e16f9d4e91c1',title:'kept',url:'https://example.org/'}];
  const native = async op => op === 'bookmarks.list' ? bookmarks : [
    {title:'web',url:'https://example.org/'},{title:'settings',url:'chrome://settings/'}
  ];
  await captureNativeData(state,device,native);
  const bookmark = recordsOf(state,'bookmark')[0], snapshot = recordsOf(state,'tabs')[0];
  assert.equal(bookmark.id,'fe0fdf9be64c4e85ae16e16f9d4e91c1');
  assert.equal(snapshot.payload.pages.length,1);
  bookmark.dirty = false;
  await captureNativeData(state,device,native);
  assert(!bookmark.dirty,'unchanged bookmark does not become a new write');
  assert.equal(recordsOf(state,'tabs').length,1,'same device updates its own snapshot');
  // A remote bookmark that has not yet been applied must not look locally deleted.
  const remote = editRecord(state,null,'bookmark',{title:'remote',url:'https://remote.example/'});
  remote.dirty = false;
  bookmarks = [];
  await captureNativeData(state,device,native);
  assert(bookmark.deleted && bookmark.dirty);
  assert(!remote.deleted);
});
test('bookmark edits and removals during a network exchange preserve concurrent remote changes',async () => {
  for (const remove of [false,true]) {
    const state = createState(), id = 'fe0fdf9be64c4e85ae16e16f9d4e91c1';
    let bookmarks = [{guid:'fe0fdf9b-e64c-4e85-ae16-e16f9d4e91c1',title:'before',url:'https://example.org/'}];
    let applied;
    const native = async (op,data) => {
      if (op === 'bookmarks.list') return structuredClone(bookmarks);
      if (op === 'tabs.list') return [];
      applied = data.records;
    };
    const baseline = await captureNativeData(state,{device:'laptop'},native);
    const remote = editRecord(state,id,'bookmark',{title:'remote edit',url:'https://remote.example/'});
    remote.dirty = false; remote.revision = 8;
    bookmarks = remove ? [] : [{...bookmarks[0],title:'local edit',url:'https://local.example/'}];
    await applyNativeData(state,native,baseline);
    assert.equal(remote.deleted,remove);
    assert(remote.dirty);
    if (!remove) assert.equal(remote.payload.title,'local edit');
    const copy = recordsOf(state,'bookmark').find(r => r.id !== id);
    assert.equal(copy.payload.url,'https://remote.example/');
    assert(copy.payload.conflict);
    assert(copy.dirty);
    assert.equal(applied.length,2);
  }
});
test('native apply uses distinct IDs for conflict copies and carries deletions into the browser',async () => {
  const state = createState();
  const live = editRecord(state,null,'bookmark',{title:'hello',url:'https://example.org/'});
  const deleted = editRecord(state,null,'bookmark',{title:'old',url:'https://old.example/'});
  deleted.deleted = true;
  let called;
  await applyNativeData(state,async (op,data) => called = {op,data});
  assert.equal(called.op,'bookmarks.apply');
  assert.equal(called.data.records.length,2);
  assert(called.data.records[1].deleted);
  assert.equal(called.data.records[0].guid.replaceAll('-',''),live.id);
  assert.deepEqual(state.nativeBookmarks,[live.id]);
});
