import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { rcedit } from 'rcedit';

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
  appVersion: '2.3.0',
  buildVersion: '2.3.0.0',
  win32metadata: { ProductName: 'Telegram Sessions', FileDescription: 'Telegram Sessions', CompanyName: '' },
  ignore: [/^\/data(?:\/|$)/, /^\/dist(?:\/|$)/, /^\/tests(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/\.git(?:\/|$)/, /^\/README\.md$/, /^\/Руководство\.txt$/],
});
for (const destination of destinations) {
  // Replace the executable's default icon group as well as the window icon.
  await rcedit(path.join(destination, 'Telegram Sessions.exe'), {
    icon: path.join(root, 'assets', 'app.ico'),
  });
  await fs.copyFile(path.join(root, 'Руководство.txt'), path.join(destination, 'Руководство.txt'));
  await fs.copyFile(path.join(root, 'GUIDE.en.md'), path.join(destination, 'GUIDE.en.md'));
  console.log(destination);
}
