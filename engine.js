'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { AuthKey } = require('telegram/crypto/AuthKey');
const { Logger } = require('telegram/extensions/Logger');
const initSql = require('sql.js');
const { accountJSON } = require('./account-format');
let sql;
async function SQL() { return sql ||= await initSql({ locateFile: f => require.resolve('sql.js/dist/' + f) }); }
function readJSON(file) {
  if (!fs.existsSync(file)) return {};
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('INVALID_JSON');
  return data;
}
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function saveJSON(file, data) { atomic(file, JSON.stringify(data, null, 2)); }
function errorCode(error) {
  const text = error?.errorMessage || error?.message || '';
  return /^[A-Z][A-Z0-9_]{2,90}$/.test(text) ? text : (error?.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'CONNECTION_OR_FILE_ERROR');
}
function twoFA(data) {
  for (const key of ['two_fa', 'twoFA', '2fa', 'password'])
    if (typeof data[key] === 'string' && data[key].trim()) return data[key];
}
function extractLoginCode(message, baseline, startedAt) {
  if (!message || message.out || String(message.senderId) !== '777000') return null;
  if (!Number.isSafeInteger(message.id) || message.id <= baseline) return null;
  if (!Number.isFinite(message.date) || message.date < startedAt - 3) return null;
  const text = message.message || '';
  if (!/(?:login\s*code|log.in\s*code|код[^\n]{0,35}(?:вход|вхід)|(?:вход|вхід)[^\n]{0,35}код)/i.test(text)) return null;
  const codes = [...text.matchAll(/(?<!\d)(\d{5,6})(?!\d)/g)];
  return codes.length === 1 ? codes[0][1] : null;
}
async function deadline(fn, timeout = 5000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('AUTO_CODE_TIMEOUT')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitLoginCode(old, baseline, startedAt, options = {}) {
  const attempts = options.attempts ?? 12;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const messages = await deadline(() => old.getMessages(777000, { limit: 8, minId: baseline }));
    for (const message of [...messages].sort((a, b) => b.id - a.id)) {
      const code = extractLoginCode(message, baseline, startedAt);
      if (code) return code;
    }
    if (attempt < attempts - 1) await sleep(2000);
  }
  return null;
}
async function loadSession(file) {
  if (!fs.existsSync(file)) throw new Error('SESSION_FILE_MISSING');
  if (fs.existsSync(file + '-wal') && fs.statSync(file + '-wal').size) throw new Error('SESSION_IN_USE_CLOSE_OTHER_APPS');
  if (fs.existsSync(file + '-journal') && fs.statSync(file + '-journal').size) throw new Error('SESSION_IN_USE_CLOSE_OTHER_APPS');
  const SQLite = await SQL();
  const db = new SQLite.Database(fs.readFileSync(file));
  try {
    const result = db.exec('SELECT dc_id, server_address, port, auth_key FROM sessions');
    if (result[0]?.values.length !== 1) throw new Error('INVALID_TELETHON_SESSION');
    const [dc, address, port, key] = result[0].values[0];
    if (!key || key.length !== 256) throw new Error('INVALID_AUTH_KEY');
    const session = new StringSession('');
    session.setDC(dc, address, port);
    const auth = new AuthKey();
    await auth.setKey(Buffer.from(key));
    session.authKey = auth;
    return session;
  } finally { db.close(); }
}
async function writeSession(file, session) {
  const key = session.authKey?.getKey();
  if (!key || key.length !== 256) throw new Error('INVALID_NEW_AUTH_KEY');
  const SQLite = await SQL();
  const db = new SQLite.Database();
  try {
    // Telethon SQLite schema v7. No serialized Python objects are used.
    db.run('CREATE TABLE version (version integer primary key); INSERT INTO version VALUES (7);');
    db.run('CREATE TABLE sessions (dc_id integer primary key, server_address text, port integer, auth_key blob, takeout_id integer);');
    db.run('CREATE TABLE entities (id integer primary key, hash integer not null, username text, phone integer, name text, date integer);');
    db.run('CREATE TABLE sent_files (md5_digest blob, file_size integer, type integer, id integer, hash integer, primary key(md5_digest,file_size,type));');
    db.run('CREATE TABLE update_state (id integer primary key, pts integer, qts integer, date integer, seq integer);');
    db.run('INSERT INTO sessions VALUES (?,?,?,?,NULL)', [session.dcId, session.serverAddress, session.port, new Uint8Array(key)]);
    atomic(file, Buffer.from(db.export()));
  } finally { db.close(); }
}
function client(session, config) {
  const logger = new Logger('none');
  return new TelegramClient(session, Number(config.apiId), config.apiHash, {
    deviceModel: config.device || 'Telegram Sessions Desktop', systemVersion: config.sdk || process.platform,
    appVersion: config.app_version || '2.3.0', langCode: config.lang_code || 'en', systemLangCode: config.system_lang_code || 'en',
    connectionRetries: 2, requestRetries: 3, autoReconnect: false,
    floodSleepThreshold: 0, baseLogger: logger, useWSS: false,
  });
}
async function identity(c) {
  try { return await c.getMe(); }
  catch (error) {
    if (['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED'].includes(errorCode(error))) return null;
    throw error;
  }
}
function discover(input, output) {
  if (!fs.existsSync(input)) return [];
  const map = new Map();
  for (const name of fs.readdirSync(input)) {
    if (!name.endsWith('.session')) continue;
    map.set(name, { name, source: path.join(input, name), status: 'idle' });
  }
  for (const journalDir of [output, path.join(output, '.state')]) {
  if (fs.existsSync(journalDir)) for (const file of fs.readdirSync(journalDir)) {
    if (!file.endsWith('.json') || file === 'report.json') continue;
    try {
      const data = readJSON(path.join(journalDir, file));
      if (data.source_session && path.dirname(path.resolve(data.source_session)) === path.resolve(input)) {
        const name = path.basename(data.source_session);
        map.set(name, { name, source: data.source_session, status: data.status === 'complete' ? 'complete' : 'pending', phone: data.phone });
      }
    } catch { /* Per-file failures are reported when that account runs. */ }
  }
  }
  for (const item of map.values()) {
    try { item.phone ||= readJSON(item.source.replace(/\.session$/, '.json')).phone; } catch { /* no preview */ }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function accountLayout(output, stem, data, journal) {
  const phone = String(data.phone || '').replace(/^\+/, '');
  const folderName = /^\d{5,20}$/.test(phone) ? '+' + phone : 'account_' + String(data.expected_user_id || data.user_id || '').replace(/\D/g, '');
  if (folderName === 'account_') throw new Error('ACCOUNT_PHONE_MISSING');
  const folder = path.join(output, folderName);
  fs.mkdirSync(folder, { recursive: true });
  const original = path.resolve(data.session_file);
  const relative = path.relative(output, original);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('INVALID_OUTPUT_PATH');
  fs.mkdirSync(path.join(folder, 'session'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'tdata'), { recursive: true });
  const filename = /^\d{5,20}$/.test(phone) ? '+' + phone + '.session' : path.basename(original);
  let target = path.join(folder, 'session', filename);
  const inside = path.relative(path.join(folder, 'session'), original);
  if (data.account_folder === folder && !inside.startsWith('..') && !path.isAbsolute(inside) && path.basename(original) === filename) target = original;
  else if (target !== original && fs.existsSync(target)) {
    let index = 2;
    while (fs.existsSync(path.join(folder, 'session', String(index), filename))) index++;
    target = path.join(folder, 'session', String(index), filename);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  data.account_folder = folder;
  if (original !== target) {
    data.previous_session_file = original;
    data.session_file = target;
    saveJSON(journal, data); // Persist move intent so interruption can be resumed.
  }
  if (data.previous_session_file) {
    const previous = path.resolve(data.previous_session_file);
    if (!previous.startsWith(output + path.sep)) throw new Error('INVALID_OUTPUT_PATH');
    for (const suffix of ['-wal', '-journal']) if (fs.existsSync(previous + suffix) && fs.statSync(previous + suffix).size) throw new Error('SESSION_IN_USE_CLOSE_OTHER_APPS');
    if (fs.existsSync(previous) && !fs.existsSync(target)) fs.renameSync(previous, target);
    delete data.previous_session_file;
  }
  const companion = target.replace(/\.session$/, '.json');
  data.json_file = companion;
  saveJSON(journal, data);
  saveJSON(companion, accountJSON(data, target));
  const legacy = path.join(output, stem + '.json');
  if (fs.existsSync(legacy) && readJSON(legacy).source_session === data.source_session) {
    const archive = path.join(output, '.state', 'legacy'); fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(legacy, path.join(archive, stem + '_' + crypto.randomUUID() + '.json'));
  }
}
class Engine {
  constructor(config, emit, prompt, overrides = {}) {
    this.config = config; this.emit = emit; this.prompt = prompt; this.stop = false;
    this.makeClient = overrides.makeClient || client;
    this.exportTdata = overrides.exportTdata || ((output, file, metadata) => require('./converter').exportAccountTdata(output, file, metadata));
  }
  event(type, data = {}) {
    if (this.logFile && ['current', 'stage', 'result', 'warning'].includes(type)) {
      const detail = type === 'current' ? `Начало обработки ${data.index}/${data.total}` :
        type === 'result' ? `${data.status}: ${data.error || data.detail || ''}` : data.detail;
      const line = [data.name || '', detail || ''].map(value => String(value).replace(/[\r\n]/g, ' ')).join(' | ');
      fs.appendFileSync(this.logFile, `${new Date().toISOString()} | ${line}\n`);
    }
    this.emit({ type, ...data });
  }
  stage(name, stage, detail) { this.event('stage', { name, stage, detail }); }
  async request(fn, name) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (error) {
        const match = /^FLOOD_WAIT_(\d+)$/.exec(errorCode(error));
        const seconds = error.seconds ?? (match && Number(match[1]));
        if (!match && error.constructor?.name !== 'FloodWaitError') throw error;
        this.stage(name, 'waiting', `Telegram просит подождать ${seconds} сек.`);
        if (!Number.isFinite(seconds) || seconds > this.config.maxWait || attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, (seconds + 1) * 1000));
      }
    }
  }
  async password(name, data, c, verify) {
    let password = twoFA(data);
    for (let attempt = 0; attempt < 3; attempt++) {
      password ||= await this.prompt({ name, kind: 'password', title: 'Двухэтапная аутентификация', description: 'Введите текущий пароль 2FA аккаунта.' });
      try { await verify(password); return password; }
      catch (error) {
        if (errorCode(error) !== 'PASSWORD_HASH_INVALID') throw error;
        password = undefined;
        this.stage(name, 'password', 'Неверный пароль 2FA. Повторите ввод.');
        if (attempt === 2) throw error;
      }
    }
  }
  async rotate(item) {
    const { config } = this;
    const source = path.resolve(item.source);
    const stem = path.basename(source, '.session');
    if (stem.toLowerCase() === 'report') throw new Error('RESERVED_ACCOUNT_NAME');
    const journal = path.join(config.output, '.state', stem + '.json');
    let data = readJSON(journal);
    let additionalSeed = {};
    if (!Object.keys(data).length) data = readJSON(path.join(config.output, stem + '.json'));
    if (data.source_session && path.resolve(data.source_session) !== source) throw new Error('OUTPUT_NAME_COLLISION');
    if (config.forceNew && data.status === 'complete') {
      const history = path.join(config.output, '.state', 'history'); fs.mkdirSync(history, { recursive: true });
      saveJSON(path.join(history, stem + '_' + crypto.randomUUID() + '.json'), data);
      additionalSeed = { additional_source_session: data.session_file, two_fa: data.two_fa, phone: data.phone, expected_user_id: data.expected_user_id };
      data = {};
    }
    if (data.status === 'complete') {
      accountLayout(config.output, stem, data, journal);
      const desktop = await this.exportTdata(config.output, data.session_file, data);
      data.tdata_path = desktop.tdata; saveJSON(journal, data);
      return { status: 'complete', detail: 'Уже обработан · ' + path.basename(data.account_folder) };
    }
    if (!data.source_session) {
      if (Object.keys(data).length) throw new Error('OUTPUT_NAME_COLLISION');
      data = readJSON(source.replace(/\.session$/, '.json'));
      for (const key of ['status', 'session_file', 'source_session', 'expected_user_id', 'account_folder', 'previous_session_file', 'json_file', 'additional_source_session']) delete data[key];
      Object.assign(data, { source_session: source,
        session_file: path.join(config.output, `${stem}_${crypto.randomUUID()}.session`),
        api_id: config.apiId, api_hash: config.apiHash, status: 'created', keep_old: Boolean(config.keepOld) });
      Object.assign(data, additionalSeed);
      saveJSON(journal, data);
    }
    if (!path.resolve(data.session_file).startsWith(config.output + path.sep) || path.resolve(data.session_file) === source) throw new Error('INVALID_OUTPUT_PATH');
    const credentials = { ...config, apiId: data.api_id, apiHash: data.api_hash, device: data.device, sdk: data.sdk, app_version: data.app_version, lang_code: data.lang_code, system_lang_code: data.system_lang_code };
    if (config.keepOld) data.keep_old = true;
    let old, fresh, who;
    const request = fn => this.request(fn, item.name);
    const commit = status => {
      data.status = status; data.updated_at = new Date().toISOString(); saveJSON(journal, data);
      if (data.account_folder) saveJSON(data.session_file.replace(/\.session$/, '.json'), accountJSON(data, data.session_file));
    };
    try {
      this.stage(item.name, 'connecting', 'Проверяем старую авторизацию');
      const loginSource = data.additional_source_session || source;
      if (fs.existsSync(loginSource)) {
        old = this.makeClient(await loadSession(loginSource), credentials);
        await old.connect();
        who = await request(() => identity(old));
      }
      if (who) {
        if (who.bot) throw new Error('BOT_NOT_SUPPORTED');
        if (data.expected_user_id && data.expected_user_id !== String(who.id)) throw new Error('SOURCE_IDENTITY_MISMATCH');
        data.expected_user_id = String(who.id); data.phone = who.phone;
        commit(data.status);
      } else if (!['ready_to_logout', 'old_logged_out'].includes(data.status)) throw new Error('OLD_SESSION_UNAUTHORIZED');
      const alreadyRevoked = !who;
      // Only reset before a fresh login: retrying after login must not revoke the new key.
      if (who && config.revokeOthers !== false && ['created', 'revoking_others'].includes(data.status)) {
        commit('revoking_others');
        this.stage(item.name, 'revoking', 'Завершаем остальные авторизации перед новым входом');
        try {
          const reset = await request(() => old.invoke(new Api.auth.ResetAuthorizations()));
          if (reset !== true) throw new Error('RESET_AUTHORIZATIONS_NOT_CONFIRMED');
          data.revoke_warning = null;
          this.stage(item.name, 'revoked', 'Остальные авторизации завершены. Текущая сохранена для входа');
        } catch (error) {
          data.revoke_warning = errorCode(error);
          this.event('warning', { name: item.name, code: data.revoke_warning,
            detail: data.revoke_warning === 'FRESH_RESET_AUTHORISATION_FORBIDDEN' ? 'Telegram запрещает завершать другие сеансы в первые 24 часа. Продолжаем с предупреждением.' : 'Не удалось завершить остальные сеансы. Продолжаем с предупреждением: ' + data.revoke_warning });
        }
        commit('others_checked');
      }
      accountLayout(config.output, stem, data, journal);
      const session = fs.existsSync(data.session_file) ? await loadSession(data.session_file) : new StringSession('');
      fresh = this.makeClient(session, credentials);
      await fresh.connect();
      if (!(await request(() => identity(fresh)))) {
        if (!who) throw new Error('NEW_SESSION_UNAUTHORIZED');
        let baseline = null;
        if (config.autoCode !== false && typeof old?.getMessages === 'function') {
          try {
            const latest = await deadline(() => old.getMessages(777000, { limit: 1 }));
            baseline = latest.length ? latest[0].id : 0;
          } catch {
            this.stage(item.name, 'code', 'Авточтение недоступно — код можно ввести вручную');
          }
        }
        const startedAt = Math.floor(Date.now() / 1000);
        this.stage(item.name, 'code', 'Ожидаем код входа из Telegram или SMS');
        const sent = await request(() => fresh.sendCode({ apiId: Number(data.api_id), apiHash: data.api_hash }, '+' + who.phone));
        let automaticCode = null;
        if (baseline !== null && sent.isCodeViaApp !== false) {
          this.stage(item.name, 'code', 'Автоматически читаем свежий код из служебного чата Telegram');
          try { automaticCode = await waitLoginCode(old, baseline, startedAt); } catch {}
          this.stage(item.name, 'code', automaticCode ? 'Код получен автоматически. Выполняем вход.' : 'Код не получен автоматически — введите его вручную');
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const code = automaticCode || await this.prompt({ name: item.name, kind: 'code', title: 'Код подтверждения', description: `Введите код входа для +${who.phone}. Он придёт в Telegram или SMS.` });
          automaticCode = null;
          try {
            await request(() => fresh.invoke(new Api.auth.SignIn({ phoneNumber: '+' + who.phone, phoneCodeHash: sent.phoneCodeHash, phoneCode: code })));
            break;
          } catch (error) {
            if (errorCode(error) === 'SESSION_PASSWORD_NEEDED') {
              data.two_fa = await this.password(item.name, data, fresh, password => request(() => fresh.updateTwoFaSettings({ isCheckPassword: true, currentPassword: password })));
              commit(data.status);
              break;
            }
            if (errorCode(error) !== 'PHONE_CODE_INVALID' || attempt === 2) throw error;
            this.stage(item.name, 'code', 'Неверный код. Повторите ввод.');
          }
        }
      }
      const me = await request(() => identity(fresh));
      this.stage(item.name, 'authorized', 'Новая авторизация создана. Проверяем аккаунт');
      if (!me || String(me.id) !== data.expected_user_id) throw new Error('NEW_IDENTITY_MISMATCH');
      if (old?.session.authKey?.getKey()?.equals(fresh.session.authKey?.getKey())) throw new Error('AUTH_KEYS_MUST_DIFFER');
      await writeSession(data.session_file, fresh.session);
      if (!alreadyRevoked) commit('authorized');
      this.stage(item.name, 'password', 'Проверяем двухэтапную аутентификацию');
      const settings = await request(() => fresh.invoke(new Api.account.GetPassword()));
      if (settings.hasPassword) {
        data.two_fa = await this.password(item.name, data, fresh, password => request(() => fresh.updateTwoFaSettings({ isCheckPassword: true, currentPassword: password })));
      } else {
        data.two_fa = twoFA(data) || await this.prompt({ name: item.name, kind: 'new-password', title: 'Установить пароль 2FA', description: '2FA отключена. Придумайте пароль и повторите его для подтверждения.' });
        commit('setting_2fa');
        await request(() => fresh.updateTwoFaSettings({ newPassword: data.two_fa, hint: '' }));
        if (!(await request(() => fresh.invoke(new Api.account.GetPassword()))).hasPassword) throw new Error('TWO_FA_NOT_CONFIRMED');
        await request(() => fresh.updateTwoFaSettings({ isCheckPassword: true, currentPassword: data.two_fa }));
      }
      for (const key of ['twoFA', '2fa', 'password']) if (key in data) data[key] = data.two_fa;
      this.stage(item.name, 'saving', '2FA проверена. Сохраняем новую сессию и JSON');
      Object.assign(data, { user_id: String(me.id), phone: me.phone, dc_id: fresh.session.dcId,
        username: me.username ?? null, first_name: me.firstName || '', last_name: me.lastName || '',
        is_premium: Boolean(me.premium), has_profile_pic: Boolean(me.photo && me.photo.className !== 'UserProfilePhotoEmpty'),
        server_address: fresh.session.serverAddress, port: fresh.session.port, library: 'GramJS', session_format: 'Telethon SQLite v7' });
      await writeSession(data.session_file, fresh.session);
      await fresh.destroy(); fresh = undefined;
      this.stage(item.name, 'verifying', 'Проверяем новую сессию с диска');
      fresh = this.makeClient(await loadSession(data.session_file), credentials);
      await fresh.connect();
      const persisted = await request(() => identity(fresh));
      if (!persisted || String(persisted.id) !== data.expected_user_id) throw new Error('PERSISTED_SESSION_INVALID');
      this.stage(item.name, 'tdata', 'Создаём и проверяем tdata для новой авторизации');
      const desktop = await this.exportTdata(config.output, data.session_file, data);
      data.tdata_path = desktop.tdata;
      commit('ready_to_logout');
      this.stage(item.name, 'verified', 'Новая сессия успешно открыта с диска и проверена');
      if (data.keep_old) {
        commit('complete');
        this.stage(item.name, 'complete', 'Создана отдельная новая авторизация. Исходная сессия сохранена');
        return { status: 'complete', detail: 'Вторая авторизация создана · исходная сохранена' };
      }
      if (who) {
        this.stage(item.name, 'logout', 'Завершаем старую авторизацию');
        const result = await request(() => old.invoke(new Api.auth.LogOut()));
        if (result?.className !== 'auth.LoggedOut') throw new Error('OLD_LOGOUT_NOT_CONFIRMED');
      }
      commit('old_logged_out');
      this.stage(item.name, 'archive', 'Старая авторизация завершена. Архивируем старые файлы');
      if (old) { await old.destroy(); old = undefined; }
      const archive = path.join(path.dirname(source), 'old', 'archive');
      fs.mkdirSync(archive, { recursive: true });
      const suffix = '_' + crypto.randomUUID();
      for (const file of [source, source.replace(/\.session$/, '.json'), source + '-wal', source + '-shm', source + '-journal']) {
        if (fs.existsSync(file)) fs.renameSync(file, path.join(archive, stem + suffix + path.basename(file).slice(stem.length)));
      }
      commit('complete');
      return { status: 'complete', detail: 'Сохранено в ' + path.basename(data.account_folder) + ' · старая сессия завершена' };
    } finally {
      // Preserve a fresh authorization even if an error occurred after login.
      if (fresh) {
        try { if (fresh.session.authKey?.getKey()) await writeSession(data.session_file, fresh.session); } catch {}
      }
      await Promise.allSettled([old?.destroy(), fresh?.destroy()]);
    }
  }
  async run(selected) {
    const { config } = this;
    fs.mkdirSync(config.output, { recursive: true });
    const lock = path.join(config.output, '.manager.lock');
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { if (e.code !== 'ESRCH') throw new Error('OUTPUT_LOCKED'); }
      if (alive) throw new Error('OUTPUT_LOCKED');
      fs.unlinkSync(lock);
    }
    const fd = fs.openSync(lock, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    const results = [];
    this.logFile = path.join(config.output, 'run.log');
    try {
      const accounts = discover(config.input, config.output).filter(a => !selected || selected.includes(a.name));
      for (let i = 0; i < accounts.length && !this.stop; i++) {
        const item = accounts[i];
        this.event('current', { name: item.name, index: i + 1, total: accounts.length });
        let result;
        try { result = { name: item.name, ...await this.rotate(item) }; }
        catch (error) {
          const code = errorCode(error);
          result = { name: item.name, status: code === 'CANCELLED' ? 'cancelled' : 'failed', error: code };
          if (error.seconds) result.retryAfter = error.seconds;
          if (code === 'CANCELLED') this.stop = true;
        }
        let journalData = {};
        try { journalData = readJSON(path.join(config.output, '.state', path.basename(item.source, '.session') + '.json')); } catch { /* Preserve the original per-account error. */ }
        if (journalData.revoke_warning) {
          result.warning = journalData.revoke_warning;
          result.detail = (result.detail || '') + ' · Предупреждение: ' + journalData.revoke_warning;
        }
        results.push(result);
        saveJSON(path.join(config.output, 'report.json'), { accounts: results });
        this.event('result', result);
      }
      return results;
    } finally { this.logFile = null; fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}
module.exports = { Engine, discover, readJSON, saveJSON, loadSession, writeSession, errorCode, twoFA, extractLoginCode, waitLoginCode, client, identity };
