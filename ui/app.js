'use strict';
const $ = selector => document.querySelector(selector);
const bridge = window.manager;
const state = { config: null, accounts: [], selected: new Set(), busy: false, current: null, total: 0, finished: 0, modal: null, lastFocus: null };
const conversion = { direction: 'session-to-tdata', inputs: [], results: new Map(), running: false };
window.__errors = [];
window.addEventListener('error', e => window.__errors.push(e.message));
const paths = {
  plane:'<path d="m21 3-7 18-4-7-7-4 18-7Z"/><path d="m10 14 6-6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', settings:'<path d="m9 3-.6 2.2-2 .9-2-.6-2 3.5 1.7 1.6v2.3L2.5 15l2 3.5 2.2-.5 2 .9.6 2.1h4l.6-2.2 2-.9 2 .6 2-3.5-1.7-1.6v-2.3l1.7-1.6-2-3.5-2.2.5-2-.9L13 3H9Z"/><circle cx="11.3" cy="12" r="3"/>',
  minus:'<path d="M5 12h14"/>', square:'<rect x="5" y="5" width="14" height="14" rx="1"/>', close:'<path d="m6 6 12 12M18 6 6 18"/>',
  layers:'<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  activity:'<path d="M2 12h4l3-8 6 16 3-8h4"/>', search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 8a7 7 0 0 1 11.6-3L20 8M4 16l2.9 3a7 7 0 0 0 11.6-3"/>',
  play:'<path d="m8 5 11 7-11 7V5Z"/>', stop:'<rect x="6" y="6" width="12" height="12" rx="1"/>',
  folder:'<path d="M3 7V5h6l2 2h10v13H3V7Z"/><path d="M3 10h18"/>', arrow:'<path d="M7 17 17 7M7 7h10v10"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  file:'<path d="M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 13h8M8 17h5"/>',
  check:'<path d="m5 12 4 4L19 6"/>', eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  alert:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
function icons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = { idle: 'Остановлен', pending: 'Продолжить', complete: 'Готово', failed: 'Ошибка', cancelled: 'Отменено', running: 'В работе' };
const errors = {
  INVALID_API_CREDENTIALS: 'Укажите API ID и API hash из my.telegram.org в настройках.', INVALID_WAIT: 'Введите время ожидания от 0 до 86400 секунд.',
  INPUT_EQUALS_OUTPUT: 'Папки аккаунтов и результатов должны отличаться.', INPUT_FOLDER_MISSING: 'Папка аккаунтов не найдена.',
  OUTPUT_LOCKED: 'Папка результатов используется другим процессом.', BUSY: 'Дождитесь завершения текущей обработки.',
  SESSION_IN_USE_CLOSE_OTHER_APPS: 'Закройте другие программы, использующие эту сессию, и повторите попытку.',
  OLD_SESSION_UNAUTHORIZED: 'Старая сессия недействительна или уже завершена.', PASSWORD_HASH_INVALID: 'Неверный пароль 2FA.',
  PHONE_CODE_INVALID: 'Неверный код подтверждения.', PHONE_CODE_EXPIRED: 'Код истёк. Запустите аккаунт ещё раз.',
  INVALID_TELETHON_SESSION: 'Этот файл не является поддерживаемой сессией Telethon.', INVALID_AUTH_KEY: 'В файле нет корректного ключа авторизации.',
  CANCELLED: 'Ввод отменён. Состояние сохранено для продолжения.', OUTPUT_NAME_COLLISION: 'В папке результатов уже есть файл с таким именем.',
  TDATA_FOLDER_NOT_FOUND: 'Папка tdata не найдена. Выберите папку с key_datas или архив с tdata.',
  TDATA_PASSCODE_INVALID: 'Неверный локальный код блокировки Telegram Desktop или повреждённые данные.',
  USER_ID_REQUIRED: 'Нужен числовой ID этого Telegram-аккаунта. Это не API ID и не номер телефона.',
  ACCOUNT_PHONE_REQUIRED: 'Введите корректный номер аккаунта с кодом страны.',
  ACCOUNT_FOLDER_IDENTITY_MISMATCH: 'В папке этого номера уже есть другой аккаунт. Проверьте номер.',
  INVALID_CONVERSION_INPUT: 'Выберите файлы для конвертации ещё раз.',
  UNSAFE_ZIP_PATH: 'Архив содержит недопустимые пути. Выберите исходную папку tdata.',
  TDATA_ARCHIVE_TOO_LARGE: 'Слишком много данных авторизации в архиве. Выберите папку tdata.',
  CONNECTION_OR_FILE_ERROR: 'Не удалось подключиться или прочитать файл. Проверьте сеть и доступ к папкам.',
};
function explain(code) { return errors[code] || (/^FLOOD_WAIT_/.test(code || '') ? 'Лимит Telegram: повторите позже (' + code + ').' : code || 'Неизвестная ошибка'); }
async function call(fn, ...args) {
  const reply = await fn(...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
function toast(text, error = false) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = icon(error ? 'alert' : 'check');
  const span = document.createElement('span'); span.textContent = text; el.append(span);
  $('#toasts').append(el);
  setTimeout(() => { el.animate([{opacity:1},{opacity:0,transform:'translateY(8px)'}],{duration:200}).finished.then(() => el.remove()); }, 5000);
}
function failure(error) { toast(explain(error.message), true); }
function status(text) { $('#footer-text').textContent = text; }
function log(text, type = '') {
  $('.log-empty')?.remove();
  const row = document.createElement('div'); row.className = 'log-row ' + type;
  const time = document.createElement('time'); time.textContent = new Date().toLocaleTimeString('ru-RU', {hour12:false});
  const label = document.createElement('span'); label.textContent = text;
  row.append(time, label); $('#log').append(row);
  if ($('#log').children.length > 500) $('#log').firstElementChild.remove();
  $('#log-count').textContent = $('#log').children.length;
  if ($('#log-autoscroll').checked) $('#log').scrollTop = $('#log').scrollHeight;
  if (!$('#logs-panel').classList.contains('active')) {
    const badge = $('#log-unread');
    badge.textContent = Math.min(Number(badge.textContent) + 1, 999);
    badge.hidden = false;
  }
}
function setBusy(value) {
  state.busy = value;
  for (const id of ['import', 'empty-import', 'settings', 'refresh', 'start-all']) $('#' + id).disabled = value;
  $('#stop').disabled = !value;
  $('#task-dot').hidden = !value;
  $('.footer-status').classList.toggle('running', value);
  render();
  renderConversion();
}
function renderConversion() {
  const toTdata = conversion.direction === 'session-to-tdata';
  document.querySelectorAll('[data-direction]').forEach(button => {
    button.classList.toggle('active', button.dataset.direction === conversion.direction); button.disabled = state.busy;
  });
  $('#conversion-pick-label').textContent = toTdata ? 'Выбрать .session' : 'Выбрать папку tdata';
  $('#conversion-zip').hidden = toTdata;
  for (const id of ['conversion-pick','conversion-zip','conversion-clear']) $('#' + id).disabled = state.busy;
  $('#conversion-start').disabled = state.busy || !conversion.inputs.length;
  $('#conversion-empty').hidden = conversion.inputs.length > 0;
  $('#conversion-hint').textContent = toTdata ? 'Можно добавить несколько .session. ID аккаунта берётся из JSON или определяется через API.' : 'Выберите tdata, папку с несколькими аккаунтами или ZIP. Локальный код блокировки запросится при необходимости.';
  $('#conversion-queue').innerHTML = conversion.inputs.map(input => {
    const result = conversion.results.get(input.name);
    return `<div class="conversion-item"><i>${icon(toTdata ? 'file' : 'folder')}</i><div><strong>${escape(input.name)}</strong><small>${escape(result?.detail || 'Ожидает конвертации')}</small></div><span class="badge ${result?.status === 'complete' ? 'success' : result?.status === 'failed' ? 'error' : ''}">${escape(labels[result?.status] || 'В очереди')}</span></div>`;
  }).join('');
}
async function pickConversion(kind) {
  try {
    const inputs = await call(bridge.convertPick, { direction: conversion.direction, kind });
    for (const input of inputs) if (!conversion.inputs.some(item => item.path === input.path)) conversion.inputs.push(input);
    renderConversion();
  } catch (error) { failure(error); }
}
async function startConversion() {
  if (state.busy || !conversion.inputs.length) return;
  try {
    await call(bridge.convertStart, { direction: conversion.direction, inputs: conversion.inputs.map(input => input.path) });
    conversion.results.clear(); conversion.running = true; setBusy(true); status('Конвертация запущена');
    log('Конвертация · ' + (conversion.direction === 'session-to-tdata' ? '.session → tdata' : 'tdata → .session'));
  } catch (error) { failure(error); }
}
function render() {
  const query = $('#search').value.toLowerCase();
  const visible = state.accounts.filter(a => `${a.name} ${a.phone || ''}`.toLowerCase().includes(query));
  const available = new Set(state.accounts.map(a => a.name));
  for (const name of state.selected) if (!available.has(name)) state.selected.delete(name);
  const selectedVisible = visible.filter(a => state.selected.has(a.name)).length;
  $('#select-all').checked = visible.length > 0 && selectedVisible === visible.length;
  $('#select-all').indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  $('#select-all').disabled = state.busy || !visible.length;
  $('#selection-count').textContent = state.selected.size ? `· ВЫБРАНО ${state.selected.size}` : '';
  $('#selected-label').textContent = state.selected.size ? `Запустить выбранные (${state.selected.size})` : 'Запустить выбранные';
  $('#start-selected').disabled = state.busy || !state.selected.size;
  $('#delete-selected').disabled = state.busy || !state.selected.size;
  $('#nav-count').textContent = state.accounts.length; $('#total').textContent = state.accounts.length;
  $('#completed').textContent = state.accounts.filter(a => a.status === 'complete').length;
  $('#empty').hidden = state.accounts.length > 0;
  $('.list-caption').hidden = state.accounts.length === 0;
  $('#no-results').hidden = !state.accounts.length || visible.length > 0;
  const list = $('#cards');
  const names = new Set(visible.map(a => a.name));
  for (const card of [...list.children]) if (!names.has(card.dataset.name)) card.remove();
  for (let i = 0; i < visible.length; i++) {
    const account = visible[i];
    let card = [...list.children].find(el => el.dataset.name === account.name);
    const isNew = !card;
    if (isNew) { card = document.createElement('article'); card.dataset.name = account.name; list.append(card); }
    card.className = 'account-card ' + account.status + (state.selected.has(account.name) ? ' selected' : '');
    if (isNew) card.animate([{opacity:0,transform:'translateY(9px)'},{opacity:1,transform:'translateY(0)'}], {duration:350,delay:Math.min(i*40,320),fill:'backwards',easing:'cubic-bezier(.22,1,.36,1)'});
    const name = account.phone ? '+' + String(account.phone).replace(/^\+/, '') : account.name.replace(/\.session$/, '');
    const badge = account.status === 'running' ? 'processing' : account.status === 'complete' ? 'success' : account.status === 'failed' ? 'error' : '';
    card.innerHTML = `<input class="account-select" type="checkbox" aria-label="Выбрать ${escape(name)}" ${state.selected.has(account.name) ? 'checked' : ''} ${state.busy ? 'disabled' : ''}><span class="card-accent"></span><div class="avatar" title="Последние два символа номера или имени файла">${escape(name.slice(-2))}</div><div class="account-info"><div class="account-name">${escape(name)}</div><div class="account-meta"><i>${icon('file')}</i><span class="filename" title="${escape(account.detail || account.name)}">${escape(account.detail || account.name)}</span><span class="meta-divider">·</span><span>Telethon</span></div></div><span class="badge ${badge}"><span class="status-dot"></span>${escape(labels[account.status] || 'Остановлен')}</span><div class="card-actions"><button class="button primary" data-action="start" ${state.busy ? 'disabled' : ''}>${icon('play')}Запуск</button><button class="button icon-button" data-action="additional" title="Создать вторую новую авторизацию, сохранив исходную" aria-label="Создать вторую сессию" ${state.busy ? 'disabled' : ''}>${icon('plus')}</button><button class="button icon-button" data-action="stop" aria-label="Остановить очередь после аккаунта" title="Остановить после текущего аккаунта" ${!state.busy || state.current !== account.name ? 'disabled' : ''}>${icon('stop')}</button><button class="button" data-action="folder">${icon('folder')}<span class="folder-label">Папка</span></button><button class="button icon-button danger" data-action="delete" title="Удалить аккаунт из списка" aria-label="Удалить аккаунт" ${state.busy ? 'disabled' : ''}>${icon('trash')}</button><button class="button icon-button" data-action="results" title="Открыть результаты" aria-label="Открыть результаты">${icon('arrow')}</button></div>`;
  }
}
function openModal(html, kind) {
  if (state.modal) return;
  state.lastFocus = document.activeElement;
  state.modal = kind;
  $('#modal-root').innerHTML = `<div class="overlay"><section class="modal ${kind}" role="dialog" aria-modal="true" aria-labelledby="modal-title">${html}</section></div>`;
  icons($('#modal-root'));
  setTimeout(() => $('#modal-root input, #modal-root button')?.focus(), 60);
}
async function dismiss() {
  const el = $('.overlay');
  if (!el) return;
  await el.animate([{opacity:1},{opacity:0}], {duration:140}).finished;
  $('#modal-root').replaceChildren(); state.modal = null; state.lastFocus?.focus();
}
function settings() {
  if (state.busy) return;
  const c = state.config;
  openModal(`<div class="modal-heading"><h2 id="modal-title">Настройки</h2><button class="modal-close" id="cancel-settings" aria-label="Закрыть"><i data-icon="close"></i></button></div><p class="description">Подключение к Telegram и расположение файлов.</p><div class="modal-columns"><div><label for="api-id">API ID</label><input id="api-id" inputmode="numeric" placeholder="Например, 12345678" value="${escape(c.apiId)}"></div><div><label for="wait">Максимальный FloodWait, сек.</label><input id="wait" type="number" min="0" max="86400" value="${escape(c.maxWait)}"></div></div><label for="api-hash">API hash</label><div class="secret-row"><input id="api-hash" type="password" autocomplete="off" placeholder="32 символа из my.telegram.org" value="${escape(c.apiHash)}"><button id="show-hash" aria-label="Показать или скрыть API hash"><i data-icon="eye"></i></button></div><label for="input-folder">Папка аккаунтов</label><div class="input-row"><input id="input-folder" value="${escape(c.input)}"><button class="button" data-folder="input-folder"><i data-icon="folder"></i></button></div><label for="output-folder">Папка результатов</label><div class="input-row"><input id="output-folder" value="${escape(c.output)}"><button class="button" data-folder="output-folder"><i data-icon="folder"></i></button></div><div class="info-box">API ID и API hash выдаются в разделе API development tools на my.telegram.org. Коды входа и пароли вводятся отдельно.</div><div class="modal-error" id="settings-error" role="alert"></div><div class="modal-footer"><button class="button" id="cancel-settings-bottom">Отмена</button><button class="button primary" id="save-settings">Сохранить настройки</button></div>`, 'settings');
  $('#cancel-settings').onclick = dismiss; $('#cancel-settings-bottom').onclick = dismiss;
  const autoCode = document.createElement('label');
  autoCode.className = 'auto-code-setting';
  autoCode.innerHTML = '<input id="auto-code" type="checkbox"><span>Автоматически читать код входа из Telegram<small>Через старую сессию. Если не получится — ручной ввод.</small></span>';
  $('.modal .info-box').before(autoCode);
  $('#auto-code').checked = c.autoCode !== false;
  const revoke = document.createElement('label'); revoke.className = 'auto-code-setting';
  revoke.innerHTML = '<input id="revoke-others" type="checkbox"><span>Завершать остальные сеансы перед новым входом<small>Отключит другие устройства и ранее созданные сессии. При отказе Telegram появится предупреждение.</small></span>';
  $('.modal .info-box').before(revoke); $('#revoke-others').checked = c.revokeOthers !== false;
  $('#show-hash').onclick = () => { $('#api-hash').type = $('#api-hash').type === 'password' ? 'text' : 'password'; };
  document.querySelectorAll('[data-folder]').forEach(button => button.onclick = async () => { try { const folder = await call(bridge.chooseFolder); if (folder) $('#' + button.dataset.folder).value = folder; } catch (e) { $('#settings-error').textContent = explain(e.message); } });
  $('#save-settings').onclick = async () => {
    const button = $('#save-settings'); button.disabled = true;
    try {
      const result = await call(bridge.saveSettings, { apiId: $('#api-id').value.trim(), apiHash: $('#api-hash').value.trim(), maxWait: Number($('#wait').value), language: window.interfaceI18n?.language || 'ru', autoCode: $('#auto-code').checked, revokeOthers: $('#revoke-others').checked, input: $('#input-folder').value.trim(), output: $('#output-folder').value.trim() });
      state.config = result.config; state.accounts = result.accounts; render(); await dismiss(); toast('Настройки сохранены');
    } catch (e) { $('#settings-error').textContent = explain(e.message); button.disabled = false; }
  };
}
async function importAccounts() {
  try { const data = await call(bridge.importAccounts); state.accounts = data.accounts; render(); if (data.imported) toast(`Добавлено аккаунтов: ${data.imported}`); if (data.skipped) toast(`Пропущено: ${data.skipped}. Совпадает имя или файл используется.`, true); }
  catch (e) { failure(e); }
}
async function start(selected = null, additional = false) {
  if (state.busy) return;
  if (!state.config.apiId || !state.config.apiHash) { settings(); toast('Сначала укажите API ID и API hash'); return; }
  if (!state.accounts.length) { await importAccounts(); return; }
  try {
    await call(additional ? bridge.startAdditional : bridge.start, selected);
    state.finished = 0; state.total = selected ? selected.length : state.accounts.length;
    $('#progress-fill').style.width = '0%'; setBusy(true); status('Начинаем обработку…');
    log(selected ? `Запуск аккаунта: ${selected.join(', ')}` : 'Запуск очереди аккаунтов');
  } catch (e) { failure(e); }
}
async function stop() { try { await call(bridge.stop); $('#stop').disabled = true; status('Остановка после текущего аккаунта'); toast('Очередь остановится после текущего аккаунта'); } catch (e) { failure(e); } }
function prompt(data) {
  const secret = !['code','user-id','phone-number'].includes(data.kind);
  const confirm = data.kind === 'new-password';
  const label = data.kind === 'phone-number' ? 'Номер с кодом страны' : data.kind === 'user-id' ? 'Числовой ID Telegram-аккаунта' : data.kind === 'local-passcode' ? 'Локальный код блокировки' : secret ? 'Пароль 2FA' : 'Код входа';
  openModal(`<div class="modal-heading"><h2 id="modal-title">${escape(data.title)}</h2><span class="badge">${escape(data.name)}</span></div><p class="description">${escape(data.description)}</p><label for="prompt-value">${secret ? 'Пароль 2FA' : 'Код входа'}</label><input id="prompt-value" class="${secret ? '' : 'code'}" type="${secret ? 'password' : 'text'}" autocomplete="off" ${secret ? '' : 'inputmode="numeric"'}>${confirm ? '<label for="prompt-confirm">Повторите пароль</label><input id="prompt-confirm" type="password" autocomplete="off">' : ''}<div class="modal-error" id="prompt-error" role="alert"></div><div class="info-box">${secret ? 'Пароль будет сохранён в JSON аккаунта.' : 'Код используется только для входа и не записывается в журнал.'} Отмена остановит очередь и сохранит текущее состояние.</div><div class="modal-footer"><button class="button" id="cancel-prompt">Отмена</button><button class="button primary" id="submit-prompt">Продолжить<i data-icon="arrow"></i></button></div>`, 'prompt');
  $('#cancel-prompt').onclick = async () => { try { await call(bridge.reply, {id:data.id,value:null}); await dismiss(); } catch (e) { failure(e); } };
  $('.modal label[for="prompt-value"]').textContent = label;
  if (data.kind === 'local-passcode') $('.modal .info-box').textContent = 'Локальный код используется только для чтения tdata и не сохраняется. Это не пароль 2FA.';
  if (data.kind === 'phone-number') { $('#prompt-value').classList.remove('code'); $('.modal .info-box').textContent = 'Например, +380123456789. Номер нужен для имени папки аккаунта.'; }
  if (data.kind === 'user-id') {
    $('#prompt-value').classList.remove('code');
    $('.modal .info-box').textContent = 'Нужен ID самого аккаунта, а не API ID приложения и не номер телефона.';
  }
  const submit = async () => {
    const value = $('#prompt-value').value;
    if (!value || (confirm && value !== $('#prompt-confirm').value)) { $('#prompt-error').textContent = confirm ? 'Введите пароль и повторите его без изменений.' : 'Поле не должно быть пустым.'; return; }
    $('#submit-prompt').disabled = true;
    try { await call(bridge.reply, {id:data.id,value}); await dismiss(); status('Продолжаем обработку…'); }
    catch (e) { $('#prompt-error').textContent = explain(e.message); $('#submit-prompt').disabled = false; }
  };
  $('#submit-prompt').onclick = submit;
  $('.modal').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (!$('#submit-prompt').disabled) submit(); } });
}
async function event(data) {
  switch (data.type) {
    case 'current':
      state.current = data.name; state.total = data.total;
      { const account = state.accounts.find(a => a.name === data.name); if (account) { account.status = 'running'; account.detail = 'Подключение…'; } }
      $('#task-title').textContent = data.name; $('#task-fraction').textContent = `${data.index} / ${data.total}`;
      status(`Обработка ${data.index} из ${data.total}`); log(`${data.name} · Начало обработки (${data.index} из ${data.total})`); render(); break;
    case 'stage':
      { const account = state.accounts.find(a => a.name === data.name); if (account) account.detail = data.detail; }
      $('#task-description').textContent = data.detail; log(`${data.name} · ${data.detail}`); render(); break;
    case 'prompt':
      // Closing the preceding modal is animated; serialize subsequent requests.
      if (state.modal) setTimeout(() => event(data), 180); else { status('Ожидаем ввод · ' + data.name); log(`${data.name} · Ожидаем ${data.kind === 'code' ? 'ручной ввод кода' : data.kind === 'user-id' ? 'ID аккаунта' : data.kind === 'local-passcode' ? 'локальный код tdata' : 'ввод пароля 2FA'}`); prompt(data); } break;
    case 'warning':
      log(`${data.name} · ${data.detail}`, 'error'); toast(data.detail, true); $('#task-description').textContent = data.detail; break;
    case 'result':
      { const account = state.accounts.find(a => a.name === data.name); if (account) { account.status = data.status; account.detail = data.error ? explain(data.error) : data.detail; } }
      state.finished++; $('#progress-fill').style.width = `${100 * state.finished / Math.max(state.total,1)}%`;
      log(`${data.name} · ${data.error ? explain(data.error) : data.detail}`, data.status === 'complete' ? 'success' : 'error'); render(); break;
    case 'done':
      setBusy(false); state.current = null;
      { const failed = data.results.filter(a => a.status === 'failed').length;
        const text = data.stopped ? 'Очередь остановлена. Можно продолжить.' : failed ? `Завершено с ошибками: ${failed}` : 'Обработка завершена';
        status(text); $('#task-title').textContent = text; $('#task-description').textContent = 'Результаты сохранены в папке новых сессий.'; toast(text, failed > 0); log(text); }
      break;
    case 'fatal': setBusy(false); status('Не удалось запустить обработку'); log(explain(data.error), 'error'); toast(explain(data.error), true); break;
    case 'notice': toast(data.message); break;
    case 'conversion':
      conversion.results.set(data.name, { status: data.status, detail: data.status === 'failed' ? explain(data.detail) : data.detail });
      log(`Конвертация · ${data.name} · ${data.status === 'failed' ? explain(data.detail) : data.detail}`, data.status === 'complete' ? 'success' : data.status === 'failed' ? 'error' : '');
      status(data.detail); renderConversion(); break;
    case 'conversion-done':
      conversion.running = false; setBusy(false);
      { const failed = data.results.filter(item => item.status === 'failed').length;
        const text = data.stopped ? 'Конвертация остановлена' : failed ? `Конвертация завершена. Ошибок: ${failed}` : 'Конвертация завершена';
        status(text); toast(text, failed > 0); log(text); }
      break;
    case 'conversion-fatal': conversion.running = false; setBusy(false); status('Ошибка конвертации'); failure(new Error(data.error)); log(explain(data.error), 'error'); break;
  }
}
icons();
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el === button));
  document.querySelectorAll('main>.panel').forEach(el => el.classList.toggle('active', el.id === button.dataset.tab + '-panel'));
  if (button.dataset.tab === 'logs') {
    $('#log-unread').textContent = '0'; $('#log-unread').hidden = true;
    if ($('#log-autoscroll').checked) $('#log').scrollTop = $('#log').scrollHeight;
  }
});
$('#cards').onclick = e => {
  const button = e.target.closest('[data-action]'); if (!button || button.disabled) return;
  const name = button.closest('.account-card').dataset.name;
  if (button.dataset.action === 'start') start([name]);
  if (button.dataset.action === 'additional') start([name], true);
  if (button.dataset.action === 'delete') deleteAccounts([name]);
  if (button.dataset.action === 'stop') stop();
  if (button.dataset.action === 'folder') call(bridge.openAccountFolder, name).catch(failure);
  if (button.dataset.action === 'results') call(bridge.openFolder, 'output').catch(failure);
};
$('#search').oninput = render;
$('#cards').addEventListener('change', e => {
  if (!e.target.matches('.account-select') || state.busy) return;
  const name = e.target.closest('.account-card').dataset.name;
  if (e.target.checked) state.selected.add(name); else state.selected.delete(name);
  render();
});
$('#select-all').onchange = () => {
  if (state.busy) return;
  const query = $('#search').value.toLowerCase();
  for (const account of state.accounts.filter(a => `${a.name} ${a.phone || ''}`.toLowerCase().includes(query))) {
    if ($('#select-all').checked) state.selected.add(account.name); else state.selected.delete(account.name);
  }
  render();
};
$('#import').onclick = importAccounts; $('#empty-import').onclick = importAccounts; $('#settings').onclick = settings;
$('#start-all').onclick = () => start(); $('#stop').onclick = stop;
$('#start-selected').onclick = () => start([...state.selected]);
$('#delete-selected').onclick = () => deleteAccounts([...state.selected]);
async function deleteAccounts(names) { if(state.busy) return; try { const result=await call(bridge.deleteAccounts,names); if(!result.cancelled) {state.accounts=result.accounts;names.forEach(n=>state.selected.delete(n));render();toast('Аккаунты убраны из списка. Исходные файлы в корзине.');} } catch(e){failure(e)} }
$('#refresh').onclick = async () => { $('#refresh').classList.add('spin'); try { state.accounts = await call(bridge.scan); render(); } catch (e) { failure(e); } finally { setTimeout(() => $('#refresh').classList.remove('spin'), 350); } };
$('#open-results').onclick = () => call(bridge.openFolder, 'output').catch(failure);
$('#clear-log').onclick = () => {
  $('#log').innerHTML = '<div class="log-empty">Экран очищен. История сохранена в файле run.log.</div>';
  $('#log-count').textContent = '0'; $('#log-unread').textContent = '0'; $('#log-unread').hidden = true;
};
$('#show-logs').onclick = () => $('[data-tab="logs"]').click();
document.querySelectorAll('[data-direction]').forEach(button => button.onclick = () => {
  if (state.busy || conversion.direction === button.dataset.direction) return;
  conversion.direction = button.dataset.direction; conversion.inputs = []; conversion.results.clear(); renderConversion();
});
$('#conversion-pick').onclick = () => pickConversion(conversion.direction === 'tdata-to-session' ? 'folder' : 'files');
$('#conversion-zip').onclick = () => pickConversion('zip');
$('#conversion-clear').onclick = () => { conversion.inputs = []; conversion.results.clear(); renderConversion(); };
$('#conversion-start').onclick = startConversion;
$('#conversion-results').onclick = () => call(bridge.openFolder, 'conversions').catch(failure);
$('#contact').onclick = () => call(bridge.openContact).catch(failure);
$('#about').onclick = () => {
  if (state.modal) return;
  openModal('<div class="modal-heading"><h2 id="modal-title">Telegram Sessions</h2><button class="modal-close" id="close-about" aria-label="Закрыть"><i data-icon="close"></i></button></div><p class="description">Версия 2.2.0 · Windows x64</p><div class="info-box">Управление авторизациями Telegram, пакетная обработка аккаунтов и конвертация .session ↔ tdata.</div><p class="description">Данные обрабатываются на вашем компьютере. Рабочие папки и параметры подключения доступны в настройках.</p><div class="modal-footer"><button class="button primary" id="done-about">Готово</button></div>', 'about');
  $('#close-about').onclick = dismiss; $('#done-about').onclick = dismiss;
};
for (const action of ['minimize','maximize','close']) $('#' + action).onclick = () => call(bridge.window, action).catch(failure);
document.addEventListener('keydown', e => {
  if (!state.modal) return;
  if (e.key === 'Escape') { if (['settings', 'about'].includes(state.modal)) dismiss(); else $('#cancel-prompt')?.click(); }
  if (e.key === 'Tab') {
    const items = [...$('.modal').querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
bridge.onEvent(data => event(data).catch(e => { window.__errors.push(e.message); failure(e); }));
call(bridge.init).then(data => { state.config = data.config; state.accounts = data.accounts; render(); renderConversion(); }).catch(failure);

