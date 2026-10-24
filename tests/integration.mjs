import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {SyncClient} from '../browser/ui/sync.mjs';
import {createState,editRecord} from '../browser/ui/model.mjs';

const packagePath = process.argv[2];
const directory = await mkdtemp(join(tmpdir(),'boybrowse-e2e-'));
const env = {...process.env,BOYBROWSE_DB:join(directory,'state.sqlite3'),MOJO_MODE:'production'};
const port = 20000 + Math.floor(Math.random()*30000);
const origin = 'http://127.0.0.1:' + port;
const server = spawn(packagePath + '/bin/boybrowse-sync',['daemon','-l',origin],{env,stdio:['ignore','ignore','pipe']});
let serverError = '';
server.stderr.on('data',chunk => {serverError += chunk;});
try {
  let ready = false;
  for (let attempt=0;attempt<80;attempt++) {
    try {const r = await fetch(origin + '/healthz'); if (r.ok) {ready = true; break;}} catch {}
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert(ready,'Perl server did not become healthy: ' + serverError);
  const invitation = execFileSync(packagePath + '/bin/boybrowse-syncctl',['invite'],{env,encoding:'utf8'}).trim();
  const makeDevice = () => {const state = createState();return new SyncClient({state,save:async()=>{},secret:{},saveSecret:async()=>{}});};
  const a = makeDevice(), b = makeDevice(), outsider = makeDevice();
  await a.enroll(origin,invitation,'First test computer');
  const kit = a.recoveryBundle();
  const pair = await a.pairingBundle();
  await b.enroll(origin,pair.invitation,'Second test computer',pair.key);
  const note = editRecord(a.state,null,'note',{title:'private test title',text:'distinctive-plaintext-never-in-server-0193'});
  await a.run(); await b.run();
  assert.equal(b.state.records[0].payload.text,'distinctive-plaintext-never-in-server-0193');
  editRecord(a.state,note.id,'note',{title:'first edit',text:'A'});
  editRecord(b.state,note.id,'note',{title:'second edit',text:'B'});
  await a.run(); await b.run(); await a.run();
  assert.deepEqual(new Set(a.state.records.map(r=>r.payload.text)),new Set(['A','B']));
  const secondInvitation = execFileSync(packagePath + '/bin/boybrowse-syncctl',['invite'],{env,encoding:'utf8'}).trim();
  await outsider.enroll(origin,secondInvitation,'Different account');
  await outsider.run(); assert.equal(outsider.state.records.length,0);
  await a.request('devices/' + b.secret.device,undefined,'DELETE');
  await assert.rejects(b.run(),error => error.status === 401);
  const recovered = makeDevice();
  await recovered.recover(kit,'Recovered computer');
  await recovered.run();
  assert.equal(recovered.state.records.length,2);
  await assert.rejects(a.run(),error => error.status === 401);
  const backup = join(directory,'backup.sqlite3');
  execFileSync(packagePath + '/bin/boybrowse-syncctl',['backup',backup],{env,stdio:'pipe'});
  for (const name of await readdir(directory)) {
    const data = await readFile(join(directory,name));
    assert(!data.includes(Buffer.from('distinctive-plaintext-never-in-server-0193')),'plaintext leaked into server storage');
    assert(!data.includes(Buffer.from(a.secret.key)),'encryption key leaked into server storage');
  }
  console.log('PASS: real Perl HTTP server, two clients, encrypted offline conflicts, isolated accounts, revocation, recovery, and verified backup');
} finally {
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit',resolve));
  await rm(directory,{recursive:true,force:true});
}
