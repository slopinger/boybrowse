import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncClient} from '../browser/ui/sync.mjs';
import {createState,editRecord,deleteRecord,uid} from '../browser/ui/model.mjs';
import {newKey} from '../browser/ui/crypto.mjs';

function server() {
  let revision = 0, drop = false;
  const records = new Map(), operations = new Map();
  return {
    records,
    dropNextResponse() {drop = true;},
    fetcher: async (url,options) => {
      assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit');
      const data = options.body ? JSON.parse(options.body) : null;
      if (options.method === 'GET') return Response.json({records:[...records.values()].filter(r => r.revision > Number(new URL(url).searchParams.get('cursor'))),cursor:revision,more:0});
      if (operations.has(data.operation)) return Response.json(operations.get(data.operation));
      if (data.records.some(r => (records.get(r.id)?.revision || 0) !== r.base)) return Response.json({error:'conflict'},{status:409});
      const written = [];
      for (const record of data.records) {
        records.set(record.id,{...record,revision:++revision});
        written.push({id:record.id,revision});
      }
      const result = {records:written,revision}; operations.set(data.operation,result);
      if (drop) {drop = false; throw new Error('connection lost after write');}
      return Response.json(result);
    }
  };
}
function device(host,key) {
  const state = createState(), durable = [];
  const client = new SyncClient({state, save:async () => durable.push(structuredClone(state)),
    secret:{server:'https://sync.example',token:'test',key}, saveSecret:async () => {}, fetcher:host.fetcher});
  return {client,state,durable};
}
test('two devices sync encrypted records, offline conflicts, and authenticated tombstones',async () => {
  const host = server(), key = newKey(), a = device(host,key), b = device(host,key);
  const original = editRecord(a.state,null,'note',{title:'private title',text:'distinctive private content'});
  await a.client.run(); await b.client.run();
  assert.equal(b.state.records[0].payload.text,'distinctive private content');
  assert(!JSON.stringify([...host.records.values()]).includes('private'));
  editRecord(a.state,original.id,'note',{title:'changed',text:'from A'});
  editRecord(b.state,original.id,'note',{title:'changed',text:'from B'});
  await a.client.run(); await b.client.run(); await a.client.run();
  assert.equal(a.state.records.length,2); assert.equal(b.state.records.length,2);
  assert.deepEqual(new Set(a.state.records.map(r => r.payload.text)),new Set(['from A','from B']));
  deleteRecord(a.state,original.id);
  await a.client.run(); await b.client.run();
  assert(b.state.records.find(r => r.id === original.id).deleted);
  assert(host.records.get(original.id).ciphertext.length > 38);
});
test('durable outbox retries an ambiguous write without duplicating or losing data',async () => {
  const host = server(), a = device(host,newKey());
  editRecord(a.state,null,'workspace',{title:'work',pages:[]});
  host.dropNextResponse();
  await assert.rejects(a.client.run(),/connection lost/);
  assert(a.state.pending); assert(a.durable.some(s => s.pending));
  await a.client.run();
  assert.equal(host.records.size,1); assert.equal(a.state.pending,null); assert(!a.state.records[0].dirty);
});
test('ciphertext or deletion-bit tampering cannot advance the local cursor',async () => {
  const host = server(), key = newKey(), a = device(host,key), b = device(host,key);
  const note = editRecord(a.state,null,'note',{text:'protected'}); await a.client.run();
  host.records.get(note.id).deleted = 1;
  await assert.rejects(b.client.run(),/authentication/);
  assert.equal(b.state.cursor,0); assert.equal(b.state.records.length,0);
});
test('custom sync origins require HTTPS and never accept credential-bearing URLs',() => {
  const a = device(server(),newKey());
  for (const url of ['http://example.org','https://name:password@example.org','https://example.org/path','https://example.org?key=secret']) assert.throws(() => a.client.endpoint(url));
  assert.equal(a.client.endpoint('https://example.org'),'https://example.org');
});
