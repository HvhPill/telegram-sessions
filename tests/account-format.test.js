const { test } = require('node:test');
const assert = require('node:assert/strict');
const { accountJSON } = require('../account-format');
const { translate } = require('../ui/i18n');
test('public JSON matches account template and excludes internal processing state', () => {
 const actual = accountJSON({api_id:123,api_hash:'a'.repeat(32),two_fa:'secret',phone:'10000000000',user_id:'456',status:'complete',source_session:'private/source.session',keep_old:true}, '/results/+10000000000.session');
 assert.deepEqual(Object.keys(actual), ['app_id','app_hash','device','sdk','app_version','system_lang_pack','system_lang_code','lang_pack','lang_code','twoFA','role','id','phone','username','date_of_birth','date_of_birth_integrity','is_premium','has_profile_pic','spamblock','register_time','last_check_time','avatar','first_name','last_name','sex','proxy','ipv6','session_file']);
 assert.equal(actual.session_file,'+10000000000'); assert.equal(actual.twoFA,'secret'); assert.equal(actual.id,456);
 assert.equal(actual.phone,'+10000000000'); assert.equal(actual.status,undefined); assert.equal(actual.source_session,undefined);
});
test('English UI translates dynamic labels and warnings without changing phone numbers', () => {
 assert.equal(translate('Запустить выбранные (3)','en'),'Run selected (3)');
 assert.equal(translate('+10000000000 · Проверяем старую авторизацию','en'),'+10000000000 · Checking source authorization');
 assert.equal(translate('Предупреждение: FRESH_RESET_AUTHORISATION_FORBIDDEN','en'),'Warning: FRESH_RESET_AUTHORISATION_FORBIDDEN');
 assert.equal(translate('Настройки','ru'),'Настройки');
});
