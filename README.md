#

## Why

I'm annoyed at the lack of desktop app for voice, like hangouts had.

## What does it do

It just lets you keep voice open without a chrome browser. It will also check the dom for notifications and display a badge in the task bar and closing the app will send it to a tray instead of closing.

## Supported Operating Systems

Currently supports both OSX, Windows 10 & Linux.

Questions? Ideas? Join us in discord [<https://discord.gg/3SSS6vkKET>](https://discord.gg/3SSS6vkKET)

## Installation

Go to the [Releases Page](https://github.com/Jerrkawz/google-voice-desktop-app/releases) and download the release for your OS.

Simply uzip and drag into the applications folder (mac) or run the executable (windows) or run the app image (ubuntu)

### Mac Note

The mac version is unsigned, so you will have to click "Open Anyway" after running, or go to Settings > Security & Privacy > General > Open Anyway. Sorry not paying for a dev license just for this

### Linux Note

You will have to make the AppImage executable in order to run it. Right Click > Properties > Permissions > Allow Executing file as a program

## Customize

You can change settings, apply themes and other things in the customization page. Go to `Electron > Settings` on Mac in the global menu bar, or `File > Settings` on windows. If you've hidden the menu bar you can also access the settings from the system tray.

### **Windows Settings**

![Windows Settings](/screenshots/windowsSettings.png?raw=true)

### **Mac Settings**

![Mac Settings](/screenshots/macSettings.png?raw=true)

### **Linux Settings**

Token stored in profile export GH_TOKEN="your_token_here"

### **System Tray Settings**

![System Tray Settings](/screenshots/systemTraySettings.png?raw=true)

## Themes

The latest version now supports custom themes, which can be set in the Settings dialog.

Not only themes but also a system for themeing! If you want to create your own theme and contribute back to the project you can do that [in the themes guide](THEMES.md).

## Run From Source

`git clone git@github.com:Jerrkawz/google-voice-desktop-app.git`

`npm install -g yarn`

`yarn install`

`yarn start`

To build yourself you can run
`yarn run build:windows` or `yarn run build:mac` or `yarn run build:linux`

## Screenshots

### **Main window:**

![Windows](/screenshots/windows.png?raw=true)

### **Dracula theme:**

![Dracula](/screenshots/dracula.png?raw=true)

### **Solar theme:**

![Solar](/screenshots/solar.png?raw=true)

### **Minty theme:**

![Minty](/screenshots/minty.png?raw=true)

### **Cerulean theme:**

![Cerulean](/screenshots/cerulean.png?raw=true)

## Attributions

- Dracula: [https://github.com/dracula/dracula-theme](https://github.com/dracula/dracula-theme)
- Solar / Minty / Cerulean: [https://bootswatch.com/](https://bootswatch.com/)

## Optimized builds

This fork keeps the packaged Electron payload as small as practical without removing Google Voice calling/media support.

- `pnpm build:windows` builds the fully offline x64 NSIS installer.
- `pnpm build:windows:web` (or `pnpm build:windows:small`) builds an NSIS Web bootstrap installer. The `.exe` is dramatically smaller because it downloads the application package during installation.
- `pnpm release:windows:web` publishes the web installer and its package files to the configured GitHub release provider.
- `pnpm size:windows` prints the largest files in `dist/win` after a Windows build.

Every build command above automatically increments the patch version before packaging. Themes are precompiled before development and release builds so Sass is not shipped inside the application. The app also uses small local implementations for preferences, context menus, and launch-at-login instead of packaging the previous runtime dependency trees.

The offline installer still contains the Electron/Chromium runtime, so its size has a relatively high floor even after the application payload itself is minimized. Use the Web installer when the size of the downloadable `.exe` is the primary concern.

### Publishing credentials

The project archive intentionally does not include a real `.env` file. Copy `.env.example` to `.env` and set `GH_TOKEN` locally when publishing GitHub releases.
