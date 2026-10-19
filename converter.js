'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const AdmZip = require('adm-zip');
const { IGE } = require('telegram/crypto/IGE');
const { StringSession } = require('telegram/sessions');
const { AuthKey } = require('telegram/crypto/AuthKey');
const { loadSession, writeSession, readJSON, saveJSON, errorCode } = require('./engine');
const pbkdf2 = promisify(crypto.pbkdf2);
// Use the same MTProto AES-IGE implementation as the existing GramJS client.
const cryptoProvider = {
  randomBytes: n => crypto.randomBytes(n),
  sha1: bytes => crypto.createHash('sha1').update(bytes).digest(),
  sha256: bytes => crypto.createHash('sha256').update(bytes).digest(),
  pbkdf2: (password, salt, iterations, size, algorithm) => pbkdf2(password, salt, iterations, size, algorithm),
  createHash(algorithm) {
    const hash = crypto.createHash(algorithm);
    return { update: bytes => { hash.update(bytes); }, digest: () => hash.digest() };
  },
  createAesIge(key, iv) {
    return { encrypt: data => new IGE(Buffer.from(key), Buffer.from(iv)).encryptIge(Buffer.from(data)),
      decrypt: data => new IGE(Buffer.from(key), Buffer.from(iv)).decryptIge(Buffer.from(data)) };
  },
};
const fileSystem = {
  readFile: file => fs.promises.readFile(file),
  writeFile: (file, data) => fs.promises.writeFile(file, data, { mode: 0o600 }),
  mkdir: (folder, options) => fs.promises.mkdir(folder, options),
  async stat(file) {
    try { const stat = await fs.promises.stat(file); return { size: stat.size, lastModified: stat.mtimeMs }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  },
};
async function openTdata(folder, passcode = '') {
  const { Tdata } = await import('@mtcute/convert');
  return Tdata.open({ path: folder, crypto: cryptoProvider, fs: fileSystem, passcode, ignoreVersion: true });
}
function userIdFrom(data) {
  for (const field of ['user_id', 'expected_user_id']) if (/^[1-9]\d{0,17}$/.test(String(data[field] || ''))) return String(data[field]);
  return null;
}
function safeName(value) { return String(value).replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 90) || 'account'; }
function tdataFolders(root, depth = 0) {
  if (depth > 3) return [];
  const files = fs.readdirSync(root, { withFileTypes: true });
  if (files.some(e => !e.isDirectory() && /^key_data[s01]$/.test(e.name))) return [root];
  return files.filter(e => e.isDirectory() && !e.isSymbolicLink()).flatMap(e => tdataFolders(path.join(root, e.name), depth + 1));
}
function extractZip(input) {
  const zip = new AdmZip(input);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-convert-'));
  try {
    let total = 0, count = 0;
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, '/');
      if (name.startsWith('/') || name.includes('\0') || name.split('/').includes('..') || /^[a-z]:/i.test(name)) throw new Error('UNSAFE_ZIP_PATH');
      // Read only authorization files, not media caches, executables or symlinks.
      if (entry.isDirectory || !/^(?:key_data[s01]|[A-F0-9]{16}[s01]|account\.json)$/i.test(path.posix.basename(name))) continue;
      total += entry.header.size; count++;
      if (total > 32 * 1024 * 1024 || count > 200) throw new Error('TDATA_ARCHIVE_TOO_LARGE');
      const target = path.resolve(temp, name);
      if (!target.startsWith(temp + path.sep)) throw new Error('UNSAFE_ZIP_PATH');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData(), { mode: 0o600 });
    }
    return temp;
  } catch (error) { cleanup(temp); throw error; }
}
function cleanup(temp) {
  const full = path.resolve(temp), parent = path.resolve(os.tmpdir());
  if (path.dirname(full) !== parent || !path.basename(full).startsWith('telegram-convert-')) throw new Error('INVALID_TEMP_PATH');
  fs.rmSync(full, { recursive: true, force: true });
}
async function sessionToTdata(input, output, userId, metadata = {}) {
  if (!/^[1-9]\d{0,17}$/.test(String(userId))) throw new Error('USER_ID_REQUIRED');
  const session = await loadSession(input);
  const { Tdata } = await import('@mtcute/convert');
  const { Long } = await import('@mtcute/core');
  if (fs.existsSync(output)) throw new Error('CONVERSION_OUTPUT_EXISTS');
  fs.mkdirSync(output, { recursive: true });
  const td = await Tdata.create({ path: path.join(output, 'tdata'), crypto: cryptoProvider, fs: fileSystem,
    keyData: { count: 1, order: [0], active: 0 } });
  await td.writeMtpAuthorization({ userId: Long.fromString(String(userId)), mainDcId: session.dcId,
    authKeys: [{ dcId: session.dcId, key: session.authKey.getKey() }], authKeysToDestroy: [] }, 0);
  await td.writeEmptyMapFile(0);
  // Re-open and decrypt the generated files before reporting success.
  const reopened = await openTdata(path.join(output, 'tdata'));
  const auth = await reopened.readMtpAuthorization(0);
  const key = auth.authKeys.find(k => k.dcId === auth.mainDcId)?.key;
  if (!key || !Buffer.from(key).equals(session.authKey.getKey()) || auth.userId.toString() !== String(userId)) throw new Error('TDATA_VERIFICATION_FAILED');
  const json = { ...metadata, user_id: String(userId), conversion: 'session-to-tdata', tdata_path: path.join(output, 'tdata'),
    conversion_source: input, converted_at: new Date().toISOString() };
  for (const field of ['source_session','session_file','status','expected_user_id']) delete json[field];
  saveJSON(path.join(output, 'account.json'), json);
  return { folder: path.join(output, 'tdata'), userId: String(userId) };
}
async function tdataToSessions(input, output, passcode = '') {
  const td = await openTdata(input, passcode);
  const { convertFromTdata } = await import('@mtcute/convert');
  fs.mkdirSync(output, { recursive: true });
  const files = [];
  let metadata = {};
  try { metadata = readJSON(path.join(path.dirname(input), 'account.json')); } catch {}
  if (!Number.isInteger(td.keyData.count) || td.keyData.count < 1 || td.keyData.count > 10 || td.keyData.order.length !== td.keyData.count) throw new Error('INVALID_TDATA_ACCOUNTS');
  for (const index of td.keyData.order) {
    const auth = await td.readMtpAuthorization(index);
    const data = await convertFromTdata(td, index);
    const dc = data.primaryDcs?.main;
    if (!dc || data.authKey?.length !== 256) throw new Error('UNSUPPORTED_TDATA_DC');
    const session = new StringSession(''); session.setDC(dc.id, dc.ipAddress, dc.port);
    session.authKey = new AuthKey(); await session.authKey.setKey(Buffer.from(data.authKey));
    const accountMetadata = userIdFrom(metadata) === auth.userId.toString() ? metadata : {};
    const phone = String(accountMetadata.phone || '').replace(/^\+/, '');
    const accountDir = path.join(output, /^\d{5,20}$/.test(phone) ? '+' + phone : 'account_' + auth.userId.toString());
    fs.mkdirSync(accountDir, { recursive: true });
    const file = path.join(accountDir, `${safeName(auth.userId.toString())}_${index}_${crypto.randomUUID().slice(0, 8)}.session`);
    await writeSession(file, session);
    const reopened = await loadSession(file);
    if (!reopened.authKey.getKey().equals(session.authKey.getKey())) throw new Error('SESSION_VERIFICATION_FAILED');
    const json = { ...accountMetadata, user_id: auth.userId.toString(), session_file: file, dc_id: dc.id,
      server_address: dc.ipAddress, port: dc.port, library: 'GramJS', session_format: 'Telethon SQLite v7',
      conversion: 'tdata-to-session', conversion_source: input, converted_at: new Date().toISOString() };
    for (const field of ['source_session','status','expected_user_id','tdata_path']) delete json[field];
    saveJSON(file.replace(/\.session$/, '.json'), json);
    files.push(file);
  }
  return files;
}
class Converter {
  constructor(config, emit, prompt, resolveUserId) { this.config = config; this.emit = emit; this.prompt = prompt; this.resolveUserId = resolveUserId; this.stop = false; }
  event(name, detail, status = 'running') {
    this.emit({ type: 'conversion', name, detail, status });
    fs.appendFileSync(path.join(this.config.output, 'run.log'), `${new Date().toISOString()} | Конвертация | ${String(name).replace(/[\r\n]/g, ' ')} | ${detail}\n`);
  }
  async run(direction, inputs) {
    const output = path.join(this.config.output, 'conversions');
    fs.mkdirSync(output, { recursive: true });
    const results = [];
    for (const input of inputs) {
      if (this.stop) break;
      const name = path.basename(input);
      let temp;
      try {
        this.event(name, 'Читаем исходные файлы');
        let target = path.join(output, safeName(path.basename(input, path.extname(input))) + '_' + crypto.randomUUID().slice(0, 8));
        let files;
        if (direction === 'session-to-tdata') {
          const metadata = readJSON(input.replace(/\.session$/i, '.json'));
          let id = userIdFrom(metadata);
          if (!id) {
            this.event(name, 'Определяем ID аккаунта для Telegram Desktop');
            id = await this.resolveUserId(input, name);
          }
          const phone = String(metadata.phone || '').replace(/^\+/, '');
          target = path.join(output, /^\d{5,20}$/.test(phone) ? '+' + phone : 'account_' + id, path.basename(target));
          this.event(name, 'Создаём и проверяем файлы tdata');
          const result = await sessionToTdata(input, target, id, metadata); files = [result.folder];
        } else {
          const root = path.extname(input).toLowerCase() === '.zip' ? (temp = extractZip(input)) : input;
          const folders = tdataFolders(root);
          if (!folders.length) throw new Error('TDATA_FOLDER_NOT_FOUND');
          files = [];
          for (const folder of folders) {
            if (this.stop) break;
            let passcode = '';
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                this.event(name, 'Расшифровываем tdata и сохраняем .session');
                files.push(...await tdataToSessions(folder, target, passcode)); break;
              } catch (error) {
                if (!/Failed to decrypt/.test(error.message) || attempt === 2) throw error;
                passcode = await this.prompt({ name, kind: 'local-passcode', title: 'Локальный код Telegram Desktop', description: 'Эта папка tdata защищена локальным кодом блокировки Telegram Desktop. Это не облачный пароль 2FA.' });
              }
            }
          }
        }
        if (direction === 'tdata-to-session') for (const file of files) {
          const jsonPath = file.replace(/\.session$/, '.json');
          const json = readJSON(jsonPath); json.conversion_source = input; saveJSON(jsonPath, json);
        }
        this.event(name, `Готово. Создано: ${files.length}`, 'complete');
        results.push({ name, status: 'complete', files });
      } catch (error) {
        const code = /Failed to decrypt/.test(error.message) ? 'TDATA_PASSCODE_INVALID' : errorCode(error);
        this.event(name, code, code === 'CANCELLED' ? 'cancelled' : 'failed');
        results.push({ name, status: code === 'CANCELLED' ? 'cancelled' : 'failed', error: code });
        if (code === 'CANCELLED') this.stop = true;
      } finally { if (temp) cleanup(temp); }
    }
    saveJSON(path.join(output, 'conversion-report.json'), { direction, results });
    return results;
  }
}
module.exports = { Converter, sessionToTdata, tdataToSessions, openTdata, tdataFolders, extractZip, cleanup, userIdFrom, cryptoProvider, fileSystem };
