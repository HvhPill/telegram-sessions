const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { StringSession } = require('telegram/sessions');
const { AuthKey } = require('telegram/crypto/AuthKey');
const { loadSession, writeSession, readJSON, saveJSON } = require('../engine');
const { Converter, sessionToTdata, tdataToSessions, openTdata, extractZip, cleanup, tdataFolders, cryptoProvider, fileSystem } = require('../converter');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'converter-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = new StringSession(''); s.setDC(5, '91.108.56.179', 443); s.authKey = new AuthKey(); await s.authKey.setKey(Buffer.alloc(256, 55));
  const file = path.join(root, 'test.session'); await writeSession(file, s);
  return { root, file, session: s };
}
test('session to tdata to session preserves authorization, user ID and companion JSON', async t => {
  const f = await fixture(t); const before = fs.readFileSync(f.file);
  const result = await sessionToTdata(f.file, path.join(f.root, 'desktop'), '123456789', { two_fa: 'test-password', phone: '10000000000' });
  assert.ok(fs.existsSync(path.join(result.folder, 'key_datas')));
  const files = await tdataToSessions(result.folder, path.join(f.root, 'back'));
  assert.equal(files.length, 1); assert.equal(path.basename(path.dirname(files[0])), '+10000000000');
  assert.deepEqual((await loadSession(files[0])).authKey.getKey(), f.session.authKey.getKey());
  const json = readJSON(files[0].replace(/\.session$/, '.json'));
  assert.equal(json.user_id, '123456789'); assert.equal(json.two_fa, 'test-password'); assert.equal(json.session_file, files[0]);
  assert.deepEqual(fs.readFileSync(f.file), before);
});
test('session export needs an account user ID and never overwrites an existing destination', async t => {
  const f = await fixture(t); const dest = path.join(f.root, 'out');
  await assert.rejects(() => sessionToTdata(f.file, dest, '0'), /USER_ID_REQUIRED/);
  fs.mkdirSync(dest); await assert.rejects(() => sessionToTdata(f.file, dest, '123'), /CONVERSION_OUTPUT_EXISTS/);
});
test('passcode-protected tdata decrypts with the correct local passcode', async t => {
  const f = await fixture(t); const { Tdata } = await import('@mtcute/convert'); const { Long } = await import('@mtcute/core');
  const folder = path.join(f.root, 'protected');
  const td = await Tdata.create({ path: folder, passcode: 'local-secret', crypto: cryptoProvider, fs: fileSystem, keyData: { count: 1, order: [0], active: 0 } });
  await td.writeMtpAuthorization({ userId: Long.fromNumber(123), mainDcId: 5, authKeys: [{ dcId: 5, key: f.session.authKey.getKey() }], authKeysToDestroy: [] }, 0);
  await assert.rejects(() => openTdata(folder), /Failed to decrypt/);
  const files = await tdataToSessions(folder, path.join(f.root, 'unlocked'), 'local-secret');
  assert.deepEqual((await loadSession(files[0])).authKey.getKey(), f.session.authKey.getKey());
});
test('ZIP reads auth files and ignores executable and media files', async t => {
  const f = await fixture(t); const result = await sessionToTdata(f.file, path.join(f.root, 'desktop'), '123');
  const zip = new AdmZip(); zip.addLocalFolder(result.folder, 'account/tdata'); zip.addFile('account/tdata/cache.exe', Buffer.from('ignored'));
  const zipPath = path.join(f.root, 'data.zip'); zip.writeZip(zipPath);
  const temp = extractZip(zipPath);
  try {
    const folders = tdataFolders(temp); assert.equal(folders.length, 1);
    assert.equal(fs.existsSync(path.join(folders[0], 'cache.exe')), false);
    const files = await tdataToSessions(folders[0], path.join(f.root, 'zip-out'));
    assert.equal(files.length, 1);
  } finally { cleanup(temp); }
});
test('conversion batch continues after an invalid file, with private logs', async t => {
  const f = await fixture(t); saveJSON(f.file.replace('.session', '.json'), { user_id: '123', phone: '10000000000', two_fa: 'not-for-logs' });
  const bad = path.join(f.root, 'invalid.session'); fs.writeFileSync(bad, 'invalid');
  const output = path.join(f.root, 'output'), events = [];
  const c = new Converter({ output }, e => events.push(e), async () => { throw Error('UNEXPECTED_PROMPT'); }, async () => '123');
  const results = await c.run('session-to-tdata', [bad, f.file]);
  assert.deepEqual(results.map(r => r.status), ['failed', 'complete']);
  assert.ok(!fs.readFileSync(path.join(output, 'run.log'), 'utf8').includes('not-for-logs'));
});
test('converter requests local passcode separately and preserves it only in memory', async t => {
  const f = await fixture(t); const { Tdata } = await import('@mtcute/convert'); const { Long } = await import('@mtcute/core');
  const folder = path.join(f.root, 'tdata'); const td = await Tdata.create({ path: folder, passcode: 'private-code', crypto: cryptoProvider, fs: fileSystem, keyData: { count: 1, order: [0], active: 0 } });
  await td.writeMtpAuthorization({ userId: Long.fromNumber(123), mainDcId: 5, authKeys: [{ dcId: 5, key: f.session.authKey.getKey() }], authKeysToDestroy: [] }, 0);
  const output = path.join(f.root, 'output'); let asked = 0;
  const c = new Converter({ output }, () => {}, async p => { assert.equal(p.kind, 'local-passcode'); asked++; return 'private-code'; }, async () => { throw Error('UNEXPECTED'); }, async () => '10000000000');
  const results = await c.run('tdata-to-session', [folder]); assert.equal(results[0].status, 'complete'); assert.equal(asked, 1);
  assert.ok(!fs.readFileSync(path.join(output, 'run.log'), 'utf8').includes('private-code'));
});
test('multi-account tdata exports each account to its own directory', async t => {
  const f = await fixture(t); const { Tdata } = await import('@mtcute/convert'); const { Long } = await import('@mtcute/core');
  const folder = path.join(f.root, 'multi'); const td = await Tdata.create({ path: folder, crypto: cryptoProvider, fs: fileSystem, keyData: { count: 2, order: [0, 1], active: 0 } });
  for (const index of [0, 1]) await td.writeMtpAuthorization({ userId: Long.fromNumber(123 + index), mainDcId: 5, authKeys: [{ dcId: 5, key: f.session.authKey.getKey() }], authKeysToDestroy: [] }, index);
  const files = await tdataToSessions(folder, path.join(f.root, 'out')); assert.equal(files.length, 2);
  assert.notEqual(path.dirname(files[0]), path.dirname(files[1]));
});
test('both conversion directions publish session and tdata in one phone directory', async t => {
  const f = await fixture(t); saveJSON(f.file.replace('.session', '.json'), { user_id: '123', phone: '+10000000000' });
  const output = path.join(f.root, 'canonical');
  const c = new Converter({ output }, () => {}, async () => { throw Error('NO_PROMPT_EXPECTED'); }, async () => '123');
  const exported = await c.run('session-to-tdata', [f.file]); assert.equal(exported[0].status, 'complete');
  const account = path.join(output, '+10000000000');
  assert.ok(fs.existsSync(path.join(account, 'session', 'test.session')));
  assert.ok(fs.existsSync(path.join(account, 'tdata', 'key_datas')));
  assert.equal(fs.existsSync(path.join(output, 'conversions')), false);
  // Import from tdata with no embedded phone and resolve the actual account phone.
  const c2 = new Converter({ output }, () => {}, async () => { throw Error('NO_PROMPT_EXPECTED'); }, async () => '123', async () => '10000000000');
  const imported = await c2.run('tdata-to-session', [path.join(account, 'tdata')]);
  assert.equal(imported[0].status, 'complete');
  for (const file of imported[0].files.filter(f => f.endsWith('.session'))) assert.equal(path.dirname(file), path.join(account, 'session'));
  assert.equal(fs.readdirSync(output).filter(n => n.startsWith('+')).length, 1);
});

