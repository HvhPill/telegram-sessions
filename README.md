# Telegram Sessions

A Windows desktop app for managing Telegram sessions and converting `.session ↔ tdata`.

**English** · [Русский](README.ru.md)

## Download for Windows

[Download the latest Windows x64 release](https://github.com/HvhPill/telegram-sessions/releases/latest)

Extract the entire ZIP archive and run `Telegram Sessions.exe`. Python and Node.js are not required for the packaged app. Keep the executable together with its supporting files and folders.

## Features

- Batch processing for selected accounts.
- Create a second independent authorization with a new key while keeping the original session active.
- Rotate a session: create and verify the new authorization before logging out of the old one.
- Read a fresh login code from Telegram service messages when available, with manual input as a fallback.
- Read or request a 2FA password, configure 2FA, and update the companion JSON file.
- Convert Telethon `.session` files to Telegram Desktop `tdata` and back, including ZIP imports.
- Store results in a separate folder for each phone number.
- Remove source accounts from the list by moving their files to the Windows Recycle Bin.
- View progress and logs, and resume interrupted processing.
- Dark interface with bundled Inter fonts and animations.

## Run from source

Requires Node.js 24 or later.

```sh
npm ci
npm start
```

Enter your own Telegram API ID and API hash in the app settings. Obtain them from **API development tools** at [my.telegram.org](https://my.telegram.org).

## Build for Windows x64

```sh
npm run package:win
```

The application folder is created in `dist`. The build embeds the application icon into the Windows executable.

## Tests

```sh
npm test
```

Tests use synthetic accounts and keys. They do not connect to Telegram or contain personal authorizations.

## Account files

Each account uses one phone-number folder:

```text
new_sessions/
  +123123123/
    session/  # .session files and companion JSON
    tdata/    # Telegram Desktop files
```

Session rotation and both conversion directions use this layout. If the phone number is unavailable in tdata, the app resolves it using the configured API or requests manual input.

The **+** button creates a new authorization with a separate key and leaves the original active. Format conversion preserves the existing authorization; use the Accounts tab to create a new key.

Account files, sessions, tdata, API settings, passwords, and logs are excluded from the repository. Account JSON files may contain a plaintext 2FA password; keep working folders private.

See the [English user guide](GUIDE.en.md) or [Russian user guide](Руководство.txt).

## Contact

[Telegram: @Kenjee132](https://t.me/Kenjee132)

## Components

Electron, GramJS, sql.js, @mtcute/convert, adm-zip, and Inter. The font license is included in `ui/fonts/OFL.txt`; other dependency licenses are distributed with their respective packages.

Telegram Sessions is an independent application and is not affiliated with Telegram. The current application interface is in Russian.
