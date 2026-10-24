const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringSession } = require('telegram/sessions');
const { AuthKey } = require('telegram/crypto/AuthKey');
const { Engine, loadSession, writeSession, readJSON, saveJSON, twoFA, errorCode, extractLoginCode, waitLoginCode } = require('../engine');

async function session(byte) {
  const s = new StringSession(''); s.setDC(2, '149.154.167.51', 443);
  s.authKey = new AuthKey(); await s.authKey.setKey(Buffer.alloc(256, byte)); return s;
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-manager-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input'), output = path.join(dir, 'output');
  fs.mkdirSync(input); fs.mkdirSync(output);
  const source = path.join(input, 'account.session');
  await writeSession(source, await session(1));
  saveJSON(path.join(input, 'account.json'), { two_fa: options.missingPassword ? '' : 'correct' });
  const events = [], calls = [], prompts = [];
  let clientCount = 0, hasPassword = !options.no2fa, sentCode = false;
  const user = { id: 123456, phone: '10000000000', bot: false };
  const config = { input, output, apiId: 123, apiHash: 'a'.repeat(32), maxWait: 0 };
  const engine = new Engine(config, e => events.push(e), async p => {
    prompts.push(p); if (options.cancelPrompt) throw new Error('CANCELLED');
    return p.kind === 'code' ? '12345' : 'correct';
  }, { makeClient(s) {
    const index = clientCount++;
    let authorized = index !== 1 || options.preauthorized;
    const c = {
      session: s,
      async connect() { if (!s.authKey) { const fresh = await session(2 + Math.floor(index / 3)); s.setDC(fresh.dcId, fresh.serverAddress, fresh.port); s.authKey = fresh.authKey; } },
      async destroy() { calls.push('destroy:' + index); },
      async getMe() {
        if (options.badReopen && index === 2) throw new Error('AUTH_KEY_UNREGISTERED');
        if (!authorized) throw new Error('AUTH_KEY_UNREGISTERED');
        return options.wrongIdentity && index === 1 ? { ...user, id: 444 } : user;
      },
      async sendCode() { sentCode = true; calls.push('sendCode'); return { phoneCodeHash: 'hash', isCodeViaApp: true }; },
      async invoke(request) {
        if (request.className === 'auth.SignIn') {
          if (options.badAutoCode && request.phoneCode === '84521') throw new Error('PHONE_CODE_INVALID');
          if (options.login2fa) throw new Error('SESSION_PASSWORD_NEEDED');
          authorized = true; return {};
        }
        if (request.className === 'auth.ResetAuthorizations') {
          calls.push('resetOthers');
          if (options.resetDenied) throw new Error('FRESH_RESET_AUTHORISATION_FORBIDDEN');
          return true;
        }
        if (request.className === 'account.GetPassword') return { hasPassword };
        if (request.className === 'auth.LogOut') {
          const currentName = events.filter(e => e.type === 'current').at(-1).name;
          assert.equal(readJSON(path.join(output, '.state', currentName.replace(/\.session$/, '.json'))).status, 'ready_to_logout');
          assert.ok(clientCount >= 3, 'must reopen new session before logout');
          calls.push('logout');
          if (options.failedLogout) throw new Error('TEST_LOGOUT_ERROR');
          return { className: 'auth.LoggedOut' };
        }
        throw new Error('UNEXPECTED_REQUEST');
      },
      async updateTwoFaSettings(params) {
        if (params.isCheckPassword) {
          if (options.wrongPassword || params.currentPassword !== 'correct') throw new Error('PASSWORD_HASH_INVALID');
          authorized = true;
        } else { hasPassword = true; calls.push('set2fa'); }
      },
    };
    if (options.autoCode && index === 0) c.getMessages = async () => sentCode ?
      [{ id: 101, senderId: 777000, date: Math.floor(Date.now() / 1000), message: 'Login code: 84521. Do not share this code.' }] :
      [{ id: 100, senderId: 777000, date: 1, message: 'Login code: 00000.' }];
    return c;
  } });
  return { engine, source, output, input, events, calls, prompts };
}

test('SQLite round-trip retains DC and key, distinct from old key', async t => {
  const f = await fixture(t); const result = await loadSession(f.source);
  assert.equal(result.dcId, 2); assert.deepEqual(result.authKey.getKey(), Buffer.alloc(256, 1));
});
test('successful rotation verifies disk, logs out old and archives source', async t => {
  const f = await fixture(t); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'complete'); assert.ok(f.calls.includes('logout'));
  assert.equal(fs.existsSync(f.source), false);
  const data = readJSON(path.join(f.output, '.state', 'account.json'));
  assert.equal(path.basename(path.dirname(path.dirname(data.session_file))), '+10000000000');
  assert.equal(readJSON(data.json_file).session_file, '+10000000000');
  assert.equal(path.basename(data.session_file), '+10000000000.session');
  assert.equal(readJSON(data.json_file).twoFA, 'correct');
  assert.equal(path.basename(data.json_file, '.json'), path.basename(data.session_file, '.session'));
  assert.ok(!fs.readdirSync(f.output).some(name => name.endsWith('.session')));
  assert.equal(data.two_fa, 'correct'); assert.equal(data.status, 'complete');
  assert.deepEqual((await loadSession(data.session_file)).authKey.getKey(), Buffer.alloc(256, 2));
  assert.equal(f.prompts[0].kind, 'code');
});
test('invalid persisted session leaves old untouched', async t => {
  const f = await fixture(t, { badReopen: true }); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'failed'); assert.ok(fs.existsSync(f.source)); assert.ok(!f.calls.includes('logout'));
});
test('wrong identity never logs old out', async t => {
  const f = await fixture(t, { wrongIdentity: true }); const result = await f.engine.run(null);
  assert.equal(result[0].error, 'NEW_IDENTITY_MISMATCH'); assert.ok(!f.calls.includes('logout'));
});
test('unconfirmed logout is not complete and retains source', async t => {
  const f = await fixture(t, { failedLogout: true }); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'failed'); assert.ok(fs.existsSync(f.source));
  assert.equal(readJSON(path.join(f.output, '.state', 'account.json')).status, 'ready_to_logout');
});
test('2FA is installed when disabled', async t => {
  const f = await fixture(t, { no2fa: true, missingPassword: true }); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'complete'); assert.ok(f.calls.includes('set2fa'));
  assert.ok(f.prompts.some(p => p.kind === 'new-password'));
});
test('missing current 2FA is requested, including login challenge', async t => {
  const f = await fixture(t, { login2fa: true, missingPassword: true }); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'complete'); assert.ok(f.prompts.some(p => p.kind === 'password'));
});
test('invalid 2FA never logs old out', async t => {
  const f = await fixture(t, { wrongPassword: true }); const result = await f.engine.run(null);
  assert.equal(result[0].error, 'PASSWORD_HASH_INVALID'); assert.ok(!f.calls.includes('logout'));
});
test('cancelled code prompt retains old and stops queue', async t => {
  const f = await fixture(t, { cancelPrompt: true }); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'cancelled'); assert.ok(f.engine.stop); assert.ok(fs.existsSync(f.source));
});
test('selected account filter excludes unselected files', async t => {
  const f = await fixture(t); assert.deepEqual(await f.engine.run(['other.session']), []); assert.equal(f.calls.length, 0);
});
test('completed rotation is idempotent', async t => {
  const f = await fixture(t); await f.engine.run(null); const count = f.calls.length;
  const second = await f.engine.run(null); assert.equal(second[0].status, 'complete'); assert.equal(f.calls.length, count);
});
test('long floodwait returns immediately and does not retry', async t => {
  const f = await fixture(t); let count = 0;
  await assert.rejects(() => f.engine.request(() => { count++; const e = new Error('FLOOD_WAIT_500'); e.seconds = 500; throw e; }, 'account'), /FLOOD_WAIT/);
  assert.equal(count, 1);
});
test('password aliases and error sanitizer', () => {
  assert.equal(twoFA({ two_fa: '', twoFA: 'pass' }), 'pass');
  assert.equal(errorCode(new Error('secret password=123')), 'CONNECTION_OR_FILE_ERROR');
});
test('failed metadata commit prevents logout', async t => {
  const f = await fixture(t); const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.output, '.state', 'account.json') && JSON.parse(fs.readFileSync(from, 'utf8')).status === 'ready_to_logout') throw new Error('TEST_DISK_FULL');
    return original(from, to);
  };
  try {
    const result = await f.engine.run(null);
    assert.equal(result[0].status, 'failed'); assert.ok(!f.calls.includes('logout')); assert.ok(fs.existsSync(f.source));
  } finally { fs.renameSync = original; }
});
test('automatically reads fresh Telegram code without a code prompt', async t => {
  const f = await fixture(t, { autoCode: true }); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'complete'); assert.ok(!f.prompts.some(p => p.kind === 'code'));
  assert.ok(!JSON.stringify(f.events).includes('84521'));
  assert.ok(!fs.readFileSync(path.join(f.output, 'run.log'), 'utf8').includes('84521'));
  assert.ok(!fs.readFileSync(path.join(f.output, '.state', 'account.json'), 'utf8').includes('84521'));
});
test('rejected automatic code falls back to manual input', async t => {
  const f = await fixture(t, { autoCode: true, badAutoCode: true }); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'complete'); assert.equal(f.prompts.filter(p => p.kind === 'code').length, 1);
});
const loginMessage = { id: 10, date: 100, senderId: 777000, message: 'Login code: **12345**. Do not share it.' };
test('extracts English and localized codes', () => {
  assert.equal(extractLoginCode(loginMessage, 9, 100), '12345');
  assert.equal(extractLoginCode({ ...loginMessage, message: 'Код входа: 54321.' }, 9, 100), '54321');
  assert.equal(extractLoginCode({ ...loginMessage, message: 'Код для входу: 54321.' }, 9, 100), '54321');
});
test('rejects stale, outgoing, wrong sender and ambiguous messages', () => {
  assert.equal(extractLoginCode(loginMessage, 10, 100), null);
  assert.equal(extractLoginCode(loginMessage, 9, 110), null);
  assert.equal(extractLoginCode({ ...loginMessage, out: true }, 9, 100), null);
  assert.equal(extractLoginCode({ ...loginMessage, senderId: 123 }, 9, 100), null);
  assert.equal(extractLoginCode({ ...loginMessage, message: 'Login code 12345 54321' }, 9, 100), null);
  assert.equal(extractLoginCode({ ...loginMessage, message: 'Password changed 12345' }, 9, 100), null);
});
test('poll timeout returns null for manual fallback', async () => {
  let calls = 0;
  const c = { getMessages: async () => { calls++; return []; } };
  assert.equal(await waitLoginCode(c, 9, 100, { attempts: 2, sleep: async () => {} }), null);
  assert.equal(calls, 2);
});
test('poll only accepts newer incoming Telegram service messages', async () => {
  const c = { getMessages: async () => [{ ...loginMessage, id: 9 }, loginMessage] };
  assert.equal(await waitLoginCode(c, 9, 100, { attempts: 1 }), '12345');
});
test('selected batch completes multiple accounts and skips unselected files', async t => {
  const f = await fixture(t);
  await writeSession(path.join(f.input, 'b.session'), await session(1));
  saveJSON(path.join(f.input, 'b.json'), { two_fa: 'correct' });
  await writeSession(path.join(f.input, 'unselected.session'), await session(1));
  const results = await f.engine.run(['account.session', 'b.session']);
  assert.deepEqual(results.map(r => r.name), ['account.session', 'b.session']);
  assert.ok(results.every(r => r.status === 'complete'));
  assert.equal(f.calls.filter(c => c === 'logout').length, 2);
  assert.ok(fs.existsSync(path.join(f.input, 'unselected.session')));
});
test('batch continues after one account fails', async t => {
  const f = await fixture(t, { badReopen: true });
  await writeSession(path.join(f.input, 'b.session'), await session(1));
  saveJSON(path.join(f.input, 'b.json'), { two_fa: 'correct' });
  const results = await f.engine.run(['account.session', 'b.session']);
  assert.deepEqual(results.map(r => r.status), ['failed', 'complete']);
});
test('automatic code can be disabled in settings', async t => {
  const f = await fixture(t, { autoCode: true }); f.engine.config.autoCode = false;
  const results = await f.engine.run(null);
  assert.equal(results[0].status, 'complete'); assert.ok(f.prompts.some(p => p.kind === 'code'));
});
test('legacy completed files migrate to a phone folder without network requests', async t => {
  const f = await fixture(t); const legacy = path.join(f.output, 'legacy.session');
  await writeSession(legacy, await session(2));
  saveJSON(path.join(f.output, 'account.json'), { source_session: f.source, session_file: legacy, status: 'complete', phone: '10000000000', user_id: '123456' });
  fs.unlinkSync(f.source);
  const results = await f.engine.run(null); assert.equal(results[0].status, 'complete');
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(legacy), false);
  const data = readJSON(path.join(f.output, '.state', 'account.json'));
  assert.equal(path.dirname(data.session_file), path.join(f.output, '+10000000000', 'session'));
  assert.ok(fs.existsSync(data.json_file)); assert.equal(fs.existsSync(path.join(f.output, 'account.json')), false);
});
test('additional session creates a fresh key and keeps original authorization', async t => {
  const f = await fixture(t); f.engine.config.keepOld = true; f.engine.config.forceNew = true;
  const original = fs.readFileSync(f.source);
  const first = await f.engine.run(['account.session']); assert.equal(first[0].status, 'complete');
  const data1 = readJSON(path.join(f.output, '.state', 'account.json'));
  assert.equal(data1.keep_old, true); assert.ok(!f.calls.includes('logout'));
  assert.deepEqual(fs.readFileSync(f.source), original);
  assert.ok(!(await loadSession(data1.session_file)).authKey.getKey().equals((await loadSession(f.source)).authKey.getKey()));
  const second = await f.engine.run(['account.session']); assert.equal(second[0].status, 'complete');
  const data2 = readJSON(path.join(f.output, '.state', 'account.json'));
  assert.notEqual(data1.session_file, data2.session_file);
  assert.ok(!(await loadSession(data1.session_file)).authKey.getKey().equals((await loadSession(data2.session_file)).authKey.getKey()));
  assert.ok(fs.existsSync(data1.session_file)); assert.ok(fs.existsSync(f.source)); assert.ok(!f.calls.includes('logout'));
});
test('additional login uses valid saved session after original was logged out', async t => {
  const f = await fixture(t); await f.engine.run(['account.session']);
  const saved = readJSON(path.join(f.output, '.state', 'account.json')).session_file;
  assert.equal(fs.existsSync(f.source), false);
  const logoutCount = f.calls.filter(c => c === 'logout').length;
  f.engine.config.keepOld = true; f.engine.config.forceNew = true;
  const results = await f.engine.run(['account.session']); assert.equal(results[0].status, 'complete');
  const next = readJSON(path.join(f.output, '.state', 'account.json'));
  assert.equal(next.additional_source_session, saved); assert.notEqual(next.session_file, saved);
  assert.equal(f.calls.filter(c => c === 'logout').length, logoutCount); assert.ok(fs.existsSync(saved));
});



test('other authorizations are terminated before requesting the new login code', async t => {
  const f = await fixture(t); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'complete');
  assert.ok(f.calls.indexOf('resetOthers') < f.calls.indexOf('sendCode'));
});
test('Telegram reset restriction warns and continues without hiding failure', async t => {
  const f = await fixture(t, { resetDenied:true }); const result = await f.engine.run(null);
  assert.equal(result[0].status, 'complete');
  assert.ok(f.events.some(e => e.type === 'warning' && e.code === 'FRESH_RESET_AUTHORISATION_FORBIDDEN'));
  assert.equal(readJSON(path.join(f.output,'.state','account.json')).revoke_warning, 'FRESH_RESET_AUTHORISATION_FORBIDDEN');
});
test('resetting other authorizations can be disabled', async t => {
  const f = await fixture(t); f.engine.config.revokeOthers = false;
  await f.engine.run(null); assert.ok(!f.calls.includes('resetOthers'));
});

test('additional sessions keep phone-only names in numbered subfolders', async t => {
  const f = await fixture(t); f.engine.config.keepOld = true; f.engine.config.forceNew = true; f.engine.config.revokeOthers = false;
  await f.engine.run(['account.session']);
  const first = readJSON(path.join(f.output, '.state', 'account.json')).session_file;
  await f.engine.run(['account.session']);
  const second = readJSON(path.join(f.output, '.state', 'account.json')).session_file;
  assert.equal(path.basename(first), '+10000000000.session'); assert.equal(path.basename(second), '+10000000000.session');
  assert.equal(path.dirname(second), path.join(f.output, '+10000000000', 'session', '2'));
  assert.ok(fs.existsSync(first)); assert.equal(readJSON(second.replace('.session','.json')).session_file, '+10000000000');
});

test('resuming after failed source logout does not reset the new authorization', async t => {
  const f = await fixture(t, { failedLogout: true });
  await f.engine.run(null); assert.equal(f.calls.filter(c => c === 'resetOthers').length, 1);
  await f.engine.run(null); assert.equal(f.calls.filter(c => c === 'resetOthers').length, 1);
});
