import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destinations = await packager({
  dir: root,
  name: 'Telegram Sessions',
  executableName: 'Telegram Sessions',
  platform: 'win32',
  arch: 'x64',
  electronVersion: '42.11.15',
  out: path.join(root, 'dist'),
  overwrite: true,
  asar: { unpack: '**/*.node' },
  icon: path.join(root, 'assets', 'app.ico'),
  appVersion: '2.1.0',
  buildVersion: '2.1.0.0',
  win32metadata: { ProductName: 'Telegram Sessions', FileDescription: 'Telegram Sessions', CompanyName: '' },
  ignore: [/^\/data(?:\/|$)/, /^\/dist(?:\/|$)/, /^\/tests(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/\.git(?:\/|$)/, /^\/README\.md$/, /^\/Руководство\.txt$/],
});
for (const destination of destinations) {
  await fs.copyFile(path.join(root, 'Руководство.txt'), path.join(destination, 'Руководство.txt'));
  console.log(destination);
}
