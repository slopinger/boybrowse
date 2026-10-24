import test from 'node:test';
import assert from 'node:assert/strict';
import {newKey, encrypt, decrypt} from '../browser/ui/crypto.mjs';

test('authenticated records round trip and reject tampering or relocation', async () => {
  const key = newKey();
  const record = {kind:'note',text:'a private note: never on the server'};
  const id = 'a'.repeat(32);
  const ciphertext = await encrypt(key, id, record);
  assert(!ciphertext.includes('private'));
  assert.deepEqual(await decrypt(key, id, ciphertext), record);
  await assert.rejects(decrypt(key, 'b'.repeat(32), ciphertext));
  await assert.rejects(decrypt(newKey(), id, ciphertext));
  const corrupted = ciphertext.slice(0,20) + (ciphertext[20] === 'A' ? 'B' : 'A') + ciphertext.slice(21);
  await assert.rejects(decrypt(key, id, corrupted));
  assert.notEqual(ciphertext, await encrypt(key, id, record));
});
