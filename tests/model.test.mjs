import test from 'node:test';
import assert from 'node:assert/strict';
import {safeURL,createState,editRecord,deleteRecord,recordsOf,mergeRemote} from '../browser/ui/model.mjs';
test('URL input searches or normalizes web addresses and rejects privileged schemes', () => {
  assert.equal(safeURL('example.org/test'),'https://example.org/test');
  assert.equal(safeURL('https://example.org/'),'https://example.org/');
  assert.equal(new URL(safeURL('a very specific thought')).hostname,'duckduckgo.com');
  for (const value of ['javascript:alert(1)','file:///etc/passwd','data:text/html,hi','chrome://settings','https://user:secret@example.org/','']) assert.throws(() => safeURL(value));
});
test('records survive serialization, delete with tombstones, and preserve concurrent edits', () => {
  const state = createState();
  const note = editRecord(state,null,'note',{title:'hello',text:'local'});
  assert.equal(recordsOf(state,'note').length,1);
  mergeRemote(state,{id:note.id,revision:2,deleted:0},{kind:'note',payload:{title:'remote',text:'remote'}});
  assert.equal(recordsOf(state,'note').length,2);
  const copy = state.records.find(r => r.id !== note.id);
  assert.equal(copy.payload.text,'local'); assert(copy.dirty); assert(copy.payload.conflict);
  assert.equal(state.records[0].payload.text,'remote'); assert(!state.records[0].dirty);
  mergeRemote(state,{id:note.id,revision:1,deleted:0},{kind:'note',payload:{text:'stale'}});
  assert.equal(state.records[0].payload.text,'remote');
  deleteRecord(state,note.id); assert.equal(recordsOf(state,'note').length,1);
  assert.deepEqual(note.payload,{},'deleted note contents are dropped from current profile state');
  assert.deepEqual(JSON.parse(JSON.stringify(state)),state);
});
test('remote deletion preserves an unsent edit as a conflict copy', () => {
  const state = createState(), note = editRecord(state,null,'note',{title:'work',text:'do not lose me'});
  mergeRemote(state,{id:note.id,revision:3,deleted:1},null);
  assert.equal(recordsOf(state,'note')[0].payload.text,'do not lose me');
  assert(state.records[0].deleted);
});
