# User guide — Telegram Sessions 2.1.0

## Getting started

Extract the complete Windows release and open `Telegram Sessions.exe`. Open Settings (`Настройки`) and enter your own API ID and API hash from my.telegram.org. Choose your working folders and add Telethon `.session` files with Add accounts (`Добавить аккаунты`).

## Processing accounts

Select accounts and choose Run selected (`Запустить выбранные`). Normal rotation verifies the source authorization, creates a new authorization, configures 2FA, and verifies the saved files before logging out of the old session. A fresh login code is read automatically when available; otherwise the app prompts for manual input. The 2FA password is read from the account JSON or requested separately.

Results are saved under `new_sessions/+phone/session/`. After successful logout, original files are archived under `old/archive`. The `.state` folder stores recovery information for interrupted operations.

## Creating a second session

Use the **+** button in an account row. This performs a new login and creates a separate authorization key while keeping the original authorization active. It does not simply copy the session file.

## Converting formats

Open Conversion (`Конвертация`) to convert `.session → tdata` or `tdata → .session`. You can select multiple files, account folders, or ZIP archives containing tdata.

Both formats are saved in the same account folder: `new_sessions/+phone/session/` and `new_sessions/+phone/tdata/`. An unknown phone number is resolved through the configured API or requested manually. Creating tdata also requires the Telegram user ID, obtained from JSON, the API, or manual input.

Conversion preserves the existing authorization. Use Accounts (`Аккаунты`) to create a new authorization key. Protected tdata may require the local Telegram Desktop passcode, which is different from the Telegram cloud 2FA password.

## Progress, logs, and stopping

Active tasks (`Активные задачи`) shows progress. Logs (`Логи`) lists account operations and timestamps; the history is saved in `run.log`. Stop (`Остановить`) finishes the current account and stops the queue. After an interruption, retry using the same working folders.

## Removing an account

The trash button moves the source session and JSON files to the Windows Recycle Bin. Generated results remain available, and Telegram authorizations are not logged out by this action.

## Working files

Data is stored in `data` beside the app or in your selected folders. Account JSON files contain API details and may include a plaintext 2FA password. Restrict access to these files. Codes and passwords are excluded from logs. Avoid opening the same session concurrently in multiple applications.

Keep the executable with its supporting files, including `resources` and `locales`, in a writable folder.

## Contact and licenses

The Telegram icon opens [@Kenjee132](https://t.me/Kenjee132). Third-party licenses are distributed with the app. Telegram Sessions is independent and is not affiliated with Telegram.
