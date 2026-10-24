'use strict';
const path = require('node:path');
function accountJSON(data, file) {
  const id = data.user_id ?? data.expected_user_id ?? data.id ?? null;
  return {
    app_id: data.api_id ?? data.app_id ?? null,
    app_hash: data.api_hash ?? data.app_hash ?? '',
    device: data.device || 'Telegram Sessions Desktop',
    sdk: data.sdk || process.platform,
    app_version: data.app_version || '2.3.0',
    system_lang_pack: data.system_lang_pack || '',
    system_lang_code: data.system_lang_code || 'en',
    lang_pack: data.lang_pack || '', lang_code: data.lang_code || 'en',
    twoFA: data.two_fa ?? data.twoFA ?? data['2fa'] ?? data.password ?? '',
    role: data.role ?? '', id: id === null ? null : (Number.isSafeInteger(Number(id)) ? Number(id) : String(id)),
    phone: data.phone ? '+' + String(data.phone).replace(/^\+/, '') : null,
    username: data.username ?? null, date_of_birth: data.date_of_birth ?? null,
    date_of_birth_integrity: data.date_of_birth_integrity ?? null,
    is_premium: Boolean(data.is_premium), has_profile_pic: Boolean(data.has_profile_pic),
    spamblock: data.spamblock ?? null, register_time: data.register_time ?? null,
    last_check_time: Math.floor(Date.now() / 1000), avatar: data.avatar ?? null,
    first_name: data.first_name ?? '', last_name: data.last_name ?? '', sex: data.sex ?? null,
    proxy: data.proxy ?? [], ipv6: Boolean(data.ipv6), session_file: path.basename(file, '.session'),
  };
}
module.exports = { accountJSON };
