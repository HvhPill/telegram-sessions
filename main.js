const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Engine, discover, readJSON, saveJSON, errorCode, client, identity, loadSession } = require('./engine');
const { Converter } = require('./converter');
const conversionInputs = new Set();
let win, engine, pending;
let config;
const dataRoot = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const configPath = path.join(dataRoot, 'data', 'settings.json');
function loadConfig() {
  let data = {};
  try { data = readJSON(configPath); } catch {}
  let apiHash = '';
  try { if (data.encryptedHash && safeStorage.isEncryptionAvailable()) apiHash = safeStorage.decryptString(Buffer.from(data.encryptedHash, 'base64')); } catch {}
  return { input: data.input || path.join(dataRoot, 'data', 'accounts'), output: data.output || path.join(dataRoot, 'data', 'new_sessions'), apiId: data.apiId || '', apiHash, maxWait: data.maxWait ?? 60, autoCode: data.autoCode !== false, revokeOthers: data.revokeOthers !== false, language: data.language === 'en' ? 'en' : 'ru' };
}
function send(event) { if (win && !win.isDestroyed()) win.webContents.send('event', event); }
function prompt(data) {
  if (pending) throw new Error('PROMPT_ALREADY_OPEN');
  return new Promise((resolve, reject) => {
    const id = require('node:crypto').randomUUID();
    pending = { id, resolve, reject };
    send({ type: 'prompt', id, ...data });
  });
}
function validate(data) {
  if (!data || !Number.isSafeInteger(Number(data.apiId)) || Number(data.apiId) <= 0 || !/^[a-f0-9]{32}$/i.test(data.apiHash || '')) throw new Error('INVALID_API_CREDENTIALS');
  if (!Number.isInteger(Number(data.maxWait)) || data.maxWait < 0 || data.maxWait > 86400) throw new Error('INVALID_WAIT');
  if (typeof data.input !== 'string' || typeof data.output !== 'string') throw new Error('INVALID_FOLDERS');
  const input = path.resolve(data.input), output = path.resolve(data.output);
  if (input.toLowerCase() === output.toLowerCase()) throw new Error('INPUT_EQUALS_OUTPUT');
  if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) throw new Error('INPUT_FOLDER_MISSING');
  return { input, output, apiId: Number(data.apiId), apiHash: data.apiHash, maxWait: Number(data.maxWait), autoCode: data.autoCode !== false, revokeOthers: data.revokeOthers !== false, language: data.language === 'en' ? 'en' : 'ru' };
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== win?.webContents) return { ok: false, error: 'INVALID_SENDER' };
    try { return { ok: true, data: await fn(...args) }; }
    catch (error) { return { ok: false, error: errorCode(error) }; }
  });
}
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('TelegramSessions.Desktop');
    config = loadConfig();
    fs.mkdirSync(config.input, { recursive: true });
    win = new BrowserWindow({ width: 1160, height: 790, minWidth: 920, minHeight: 580,
      backgroundColor: '#09090b', title: 'Telegram-сессии', titleBarStyle: 'hidden',
      icon: path.join(__dirname, 'assets', 'app.ico'),
      show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (process.argv.includes('--smoke')) win.webContents.on('console-message', (_event, ...details) => {
      fs.appendFileSync(path.join(dataRoot, 'smoke-console.log'), JSON.stringify(details) + '\n');
    });
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    win.on('close', event => {
      if (engine) { event.preventDefault(); engine.stop = true; send({ type: 'notice', message: 'Очередь остановится после текущего аккаунта. Затем закройте окно.' }); }
    });
    handle('init', () => ({ config, accounts: discover(config.input, config.output), version: app.getVersion() }));
    handle('set-language', language => {
      if (!['ru','en'].includes(language)) throw new Error('INVALID_LANGUAGE');
      config.language = language;
      const stored = readJSON(configPath); stored.language = language; saveJSON(configPath, stored);
      return language;
    });
    handle('scan', () => discover(config.input, config.output));
    handle('open-contact', () => shell.openExternal('https://t.me/Kenjee132'));
    handle('account-folder', async name => {
      if (typeof name !== 'string' || path.basename(name) !== name) throw new Error('INVALID_SELECTION');
      const stem = name.replace(/\.session$/, '');
      const data = readJSON(path.join(config.output, '.state', stem + '.json'));
      const folder = data.account_folder ? path.resolve(data.account_folder) : config.input;
      if (data.account_folder && !folder.startsWith(path.resolve(config.output) + path.sep)) throw new Error('INVALID_OUTPUT_PATH');
      const error = await shell.openPath(folder); if (error) throw new Error('CANNOT_OPEN_FOLDER');
    });
    handle('choose-folder', async () => {
      if (engine) throw new Error('BUSY');
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    handle('save-settings', data => {
      if (engine) throw new Error('BUSY');
      config = validate(data);
      const saved = { ...config }; delete saved.apiHash;
      if (safeStorage.isEncryptionAvailable()) saved.encryptedHash = safeStorage.encryptString(config.apiHash).toString('base64');
      saveJSON(configPath, saved);
      return { config, accounts: discover(config.input, config.output) };
    });
    handle('import', async () => {
      if (engine) throw new Error('BUSY');
      const result = await dialog.showOpenDialog(win, { title: config.language === 'en' ? 'Add accounts' : 'Добавить аккаунты', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Telethon session', extensions: ['session'] }] });
      if (result.canceled) return { accounts: discover(config.input, config.output), imported: 0, skipped: 0 };
      fs.mkdirSync(config.input, { recursive: true });
      let imported = 0, skipped = 0;
      for (const file of result.filePaths) {
        const dest = path.join(config.input, path.basename(file));
        if (path.resolve(file).toLowerCase() === path.resolve(dest).toLowerCase()) continue;
        if (fs.existsSync(dest) || (fs.existsSync(file + '-wal') && fs.statSync(file + '-wal').size)) { skipped++; continue; }
        fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
        const json = file.replace(/\.session$/i, '.json');
        if (fs.existsSync(json) && !fs.existsSync(dest.replace(/\.session$/i, '.json'))) fs.copyFileSync(json, dest.replace(/\.session$/i, '.json'), fs.constants.COPYFILE_EXCL);
        imported++;
      }
      return { accounts: discover(config.input, config.output), imported, skipped };
    });
    handle('open-folder', async which => {
      const target = which === 'input' ? config.input : config.output;
      fs.mkdirSync(target, { recursive: true });
      const error = await shell.openPath(target);
      if (error) throw new Error('CANNOT_OPEN_FOLDER');
    });
    handle('convert-pick', async ({ direction, kind }) => {
      if (engine) throw new Error('BUSY');
      if (!['session-to-tdata', 'tdata-to-session'].includes(direction)) throw new Error('INVALID_DIRECTION');
      const folder = direction === 'tdata-to-session' && kind === 'folder';
      const result = await dialog.showOpenDialog(win, { title: config.language === 'en' ? (folder ? 'Select tdata or an accounts folder' : 'Select conversion files') : (folder ? 'Выберите tdata или папку с аккаунтами' : 'Выберите файлы для конвертации'),
        properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
        filters: folder ? undefined : [{ name: direction === 'session-to-tdata' ? 'Telethon sessions' : 'tdata ZIP', extensions: direction === 'session-to-tdata' ? ['session'] : ['zip'] }] });
      const files = result.canceled ? [] : result.filePaths;
      files.forEach(file => conversionInputs.add(path.resolve(file)));
      return files.map(file => ({ path: path.resolve(file), name: path.basename(file) }));
    });
    handle('convert-start', async ({ direction, inputs }) => {
      if (engine) throw new Error('BUSY');
      if (!['session-to-tdata', 'tdata-to-session'].includes(direction) || !Array.isArray(inputs) || !inputs.length || inputs.some(file => typeof file !== 'string' || !conversionInputs.has(path.resolve(file)))) throw new Error('INVALID_CONVERSION_INPUT');
      const resolveUserId = async (file, name) => {
        if (Number(config.apiId) > 0 && /^[a-f0-9]{32}$/i.test(config.apiHash)) {
          const existing = client(await loadSession(file), config);
          try {
            await existing.connect(); const me = await identity(existing);
            if (!me || me.bot) throw new Error('OLD_SESSION_UNAUTHORIZED');
            return String(me.id);
          } finally { await existing.destroy(); }
        }
        const value = await prompt({ name, kind: 'user-id', title: 'ID аккаунта для tdata', description: 'В JSON нет user_id. Введите числовой Telegram ID аккаунта либо отмените и укажите API ID/hash в настройках — тогда программа определит ID через существующую сессию.' });
        if (!/^[1-9]\d{0,17}$/.test(value)) throw new Error('USER_ID_REQUIRED');
        return value;
      };
      const resolvePhone = async (file, metadata, name) => {
        if (Number(config.apiId) > 0 && /^[a-f0-9]{32}$/i.test(config.apiHash)) {
          const existing = client(await loadSession(file), config);
          try {
            await existing.connect(); const me = await identity(existing);
            if (me?.phone && (!metadata.user_id || String(me.id) === String(metadata.user_id))) return me.phone;
          } finally { await existing.destroy(); }
        }
        return prompt({ name, kind: 'phone-number', title: 'Номер аккаунта', description: 'Номер отсутствует в данных tdata. Введите номер этого аккаунта с кодом страны — он будет названием единой папки.' });
      };
      const instance = new Converter({ ...config, output: path.resolve(config.output) }, send, prompt, resolveUserId, resolvePhone);
      engine = instance;
      setImmediate(async () => {
        try { const results = await instance.run(direction, [...new Set(inputs)]); send({ type: 'conversion-done', results, stopped: instance.stop }); }
        catch (error) { send({ type: 'conversion-fatal', error: errorCode(error) }); }
        finally { engine = null; }
      });
      return true;
    });
    const startEngine = async (selected, additional = false) => {
      if (engine) throw new Error('BUSY');
      config = validate(config);
      if (selected !== null && (!Array.isArray(selected) || !selected.every(n => typeof n === 'string' && path.basename(n) === n))) throw new Error('INVALID_SELECTION');
      const instance = new Engine({ ...config, keepOld: additional, forceNew: additional }, send, prompt);
      engine = instance;
      // Start only after the IPC response so the UI reliably enters running state.
      setImmediate(async () => {
        try { const results = await instance.run(selected); send({ type: 'done', results, stopped: instance.stop }); }
        catch (error) { send({ type: 'fatal', error: errorCode(error) }); }
        finally { engine = null; }
      });
      return true;
    };
    handle('start', selected => startEngine(selected));
    handle('start-additional', selected => startEngine(selected, true));
    handle('delete-accounts', async names => {
      if (engine) throw new Error('BUSY');
      if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || path.basename(n) !== n)) throw new Error('INVALID_SELECTION');
      const known = discover(config.input, config.output);
      const accounts = names.map(name => known.find(a => a.name === name));
      if (accounts.some(a => !a)) throw new Error('INVALID_SELECTION');
      const answer = await dialog.showMessageBox(win, { type: 'warning', title: config.language === 'en' ? 'Remove accounts' : 'Удалить аккаунты', message: config.language === 'en' ? `Remove selected accounts? (${accounts.length})` : `Убрать выбранные аккаунты из списка? (${accounts.length})`, detail: config.language === 'en' ? 'Source files will be moved to the Recycle Bin. Generated results and Telegram authorizations are preserved.' : 'Исходные файлы будут перемещены в корзину. Готовые результаты сохранятся. Авторизации в Telegram не завершаются.', buttons: config.language === 'en' ? ['Cancel', 'Recycle'] : ['Отмена', 'В корзину'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return { cancelled: true };
      for (const account of accounts) {
        const stem = account.name.replace(/\.session$/, '');
        const journal = path.join(config.output, '.state', stem + '.json');
        const legacy = path.join(config.output, stem + '.json');
        const paths = [account.source, account.source.replace(/\.session$/, '.json')];
        paths.push(journal, legacy);
        for (const file of [...new Set(paths)]) if (fs.existsSync(file)) await shell.trashItem(file);
      }
      return { accounts: discover(config.input, config.output) };
    });
    handle('stop', () => { if (engine) engine.stop = true; return true; });
    handle('reply', ({ id, value }) => {
      if (!pending || pending.id !== id) throw new Error('PROMPT_EXPIRED');
      const task = pending; pending = null;
      if (value === null) { if (engine) engine.stop = true; task.reject(new Error('CANCELLED')); }
      else if (typeof value === 'string' && value.length > 0 && value.length <= 4096) task.resolve(value);
      else { pending = task; throw new Error('EMPTY_INPUT'); }
      return true;
    });
    handle('window', action => { if (action === 'minimize') win.minimize(); else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); else if (action === 'close') win.close(); });
    win.loadFile(path.join(__dirname, 'ui', 'index.html')).then(() => {
      win.show();
      win.focus();
    }).catch(error => {
      dialog.showErrorBox('Не удалось открыть приложение', errorCode(error));
      app.quit();
    });
    // Test-only capture of this app's own rendered window, no account operations.
    if (process.argv.includes('--smoke')) win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const png = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dataRoot, 'preview.png'), png.toPNG());
        fs.writeFileSync(path.join(dataRoot, 'smoke.json'), JSON.stringify(await win.webContents.executeJavaScript(`({title:document.title,cards:document.querySelectorAll('.account-card').length,bridge:typeof window.manager,errors:window.__errors||[],script:typeof state,icons:document.querySelectorAll('svg').length})`)));
        const selectionTest = await win.webContents.executeJavaScript(`(async()=>{await document.fonts.ready;state.accounts=[{name:'demo-account-01.session',phone:'10000000001',status:'complete',detail:'Новая сессия проверена · старая завершена'},{name:'demo-account-02.session',phone:'10000000002',status:'idle'},{name:'demo-account-03.session',phone:'10000000003',status:'running',detail:'Проверяем новую сессию с диска'}];render();document.getElementById('select-all').click();const all=state.selected.size===3;document.querySelector('.account-select').click();const two=state.selected.size===2&&document.getElementById('select-all').indeterminate;let chosen=[];const original=start;start=async a=>{chosen=a};document.getElementById('start-selected').click();start=original;state.current='demo-account-03.session';setBusy(true);return{all,two,selectedBatch:chosen.length===2,busyLocksSelection:document.getElementById('select-all').disabled,font:document.fonts.check('12px Inter'),errors:window.__errors}})()`);
        fs.writeFileSync(path.join(dataRoot, 'smoke-selection.json'), JSON.stringify(selectionTest));
        await new Promise(resolve => setTimeout(resolve, 600));
        fs.writeFileSync(path.join(dataRoot, 'preview-cards.png'), (await win.webContents.capturePage()).toPNG());
        const logsTest = await win.webContents.executeJavaScript(`(async()=>{await event({type:'stage',name:'demo-account-03.session',detail:'Подключаемся к Telegram'});await event({type:'stage',name:'demo-account-03.session',detail:'Код получен автоматически. Выполняем вход.'});const unread=!document.getElementById('log-unread').hidden;document.querySelector('[data-tab=logs]').click();await new Promise(r=>setTimeout(r,350));return{tab:document.getElementById('logs-panel').classList.contains('active'),rows:document.querySelectorAll('.log-row').length,unread,cleared:document.getElementById('log-unread').hidden,count:document.getElementById('log-count').textContent,errors:window.__errors}})()`);
        fs.writeFileSync(path.join(dataRoot, 'smoke-logs.json'), JSON.stringify(logsTest));
        fs.writeFileSync(path.join(dataRoot, 'preview-logs.png'), (await win.webContents.capturePage()).toPNG());
        const conversionTest = await win.webContents.executeJavaScript(`(async()=>{setBusy(false);document.querySelector('[data-tab=convert]').click();const first=conversion.direction==='session-to-tdata';document.querySelector('[data-direction=tdata-to-session]').click();const second=conversion.direction==='tdata-to-session'&&!document.getElementById('conversion-zip').hidden;await new Promise(r=>setTimeout(r,350));return{first,second,disabledWithoutFiles:document.getElementById('conversion-start').disabled,bridge:typeof window.manager.convertStart,errors:window.__errors}})()`);
        fs.writeFileSync(path.join(dataRoot, 'smoke-conversion.json'), JSON.stringify(conversionTest));
        fs.writeFileSync(path.join(dataRoot, 'preview-conversion.png'), (await win.webContents.capturePage()).toPNG());
        const uiTest = await win.webContents.executeJavaScript(`(async()=>{setBusy(false);settings();await new Promise(r=>setTimeout(r,350));const a={dialog:!!document.querySelector('[role=dialog]'),masked:document.getElementById('api-hash').type==='password',autoCode:document.getElementById('auto-code').checked,errors:window.__errors};return a})()`);
        fs.writeFileSync(path.join(dataRoot, 'smoke-ui.json'), JSON.stringify(uiTest));
        fs.writeFileSync(path.join(dataRoot, 'preview-settings.png'), (await win.webContents.capturePage()).toPNG());
        const external = shell.openExternal; let contactUrl = null;
        try {
          shell.openExternal = async url => { contactUrl = url; };
          await win.webContents.executeJavaScript(`(async()=>{await dismiss();document.getElementById('contact').click();document.getElementById('about').click();await new Promise(r=>setTimeout(r,150))})()`);
          await new Promise(resolve => setTimeout(resolve, 150));
          fs.writeFileSync(path.join(dataRoot, 'smoke-product.json'), JSON.stringify({ appPath: app.getAppPath(), contactUrl,
            ...await win.webContents.executeJavaScript(`({contactIcon:!!document.querySelector('#contact svg'),contactText:document.getElementById('contact').textContent.trim(),about:document.querySelector('#modal-title')?.textContent,errors:window.__errors})`) }));
        } finally { shell.openExternal = external; }
        const languageTest = await win.webContents.executeJavaScript(`(async()=>{
          await dismiss(); const select=document.getElementById('language');
          select.value='en'; select.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,150));
          settings(); await new Promise(r=>setTimeout(r,150));
          const settingsEnglish=document.getElementById('modal-title').textContent==='Settings';
          const revokeDefault=document.getElementById('revoke-others').checked;
          await dismiss(); event({type:'stage',name:'demo-account-03.session',detail:'Проверяем старую авторизацию'});
          await new Promise(r=>setTimeout(r,150));
          const dynamicEnglish=document.getElementById('task-description').textContent==='Checking source authorization';
          const english=document.documentElement.lang==='en'&&document.getElementById('settings').textContent.trim()==='Settings';
          select.value='ru';select.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,150));
          return {english,settingsEnglish,dynamicEnglish,revokeDefault,roundTrip:document.getElementById('settings').textContent.trim()==='Настройки',errors:window.__errors};
        })()`);
        fs.writeFileSync(path.join(dataRoot, 'smoke-language.json'), JSON.stringify(languageTest));
        const testRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'telegram-runtime-check-'));
        try {
          const { StringSession } = require('telegram/sessions'); const { AuthKey } = require('telegram/crypto/AuthKey');
          const testSession = new StringSession(''); testSession.setDC(2, '149.154.167.51', 443);
          testSession.authKey = new AuthKey(); await testSession.authKey.setKey(Buffer.alloc(256, 31));
          const testFile = path.join(testRoot, 'test.session'); await require('./engine').writeSession(testFile, testSession);
          const converter = require('./converter');
          const desktop = await converter.sessionToTdata(testFile, path.join(testRoot, 'desktop'), '123456');
          const files = await converter.tdataToSessions(desktop.folder, path.join(testRoot, 'back'));
          fs.writeFileSync(path.join(dataRoot, 'smoke-converter-runtime.json'), JSON.stringify({ sameKey: (await loadSession(files[0])).authKey.getKey().equals(testSession.authKey.getKey()), networkUsed: false }));
        } finally {
          if (path.dirname(testRoot) === path.resolve(app.getPath('temp')) && path.basename(testRoot).startsWith('telegram-runtime-check-')) fs.rmSync(testRoot, { recursive: true, force: true });
        }
      } finally { app.quit(); }
    }, 1800));
  });
}
app.on('window-all-closed', () => app.quit());
