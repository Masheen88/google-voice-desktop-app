# Voice Desktop GIF picker

This fork adds a GIPHY search picker to the existing Electron shell **without using an unofficial Google Voice send API**. It attaches through the Google Voice image UI when that UI is discoverable; **it never presses Send**.

## Configure (Windows 11)

1. Get an API key from https://developers.giphy.com/ (create an API app, not an SDK app). GIPHY's free beta keys are rate-limited to 100 API requests/hour. The API key is stored **locally in your Electron app's preferences file** (plaintext, like other settings); it is never passed to Google Voice.
2. Run `corepack enable`, then `pnpm install`, then `pnpm start` from this directory in **cmd**. If pnpm is already installed, you can skip `corepack enable`.
3. Open **File → Settings → GIF picker**, enable the feature, enter your API key, choose the rating, and click **Save key**.
4. Open a Google Voice conversation, then click **GIF** beside the message composer. If the button doesn't appear due to a newer Voice layout, use **Ctrl+Shift+G** or **File → GIF picker**.
5. Search/trending/favorites/recent GIFs are available. Clicking an item obtains a GIPHY rendition under 2 MiB and attempts to attach it to the Google Voice message. **Check the native attachment preview before clicking Send.**
6. If Voice changed its attachment controls, the picker shows a **Save selected GIF to attach manually** button. Save it and use Google Voice's **Select image** control to attach the saved file.

## Build

```cmd
corepack enable
pnpm install
pnpm start
```

For a Windows installer:

```cmd
pnpm run build:windows:offline
```

The normal build script increments the app version. This source ZIP intentionally keeps the original version number and existing updater behavior unchanged.

## Tests

```cmd
node --test tests/gifService.test.cjs
```

Unit tests cover URL allowlisting, metadata validation, GIF byte signatures, size limits, rendition retries and redirect prevention. Electron compilation and the Google Voice authenticated UI **were not exercised** in the isolated build environment. Test with a real conversation before relying on it.

## Design and safety

- The GIPHY picker is a **local sandboxed, frameless BrowserWindow** positioned near the message editor. It fetches search/trending results directly from GIPHY, as required by GIPHY's API terms.
- A small button is inserted from the isolated Google Voice preload; it has no remote network access. The GIPHY API key is never exposed to Google Voice, and the renderer does not receive Node.js or unrestricted IPC privileges.
- GIF downloads in the Electron main process are allowlisted to HTTPS GIPHY `.gif` URLs, reject redirects and check both downloaded byte size and GIF file signature.
- GIPHY may provide a smaller rendition when the original exceeds 2 MB. This feature does **not** transcode arbitrary GIFs. If no downloadable rendition is small enough, choose a different result.
- The saved favorite/recent lists retain metadata (URLs/title/ID), not copies of your messages or GIF bytes. GIF queries are sent to GIPHY, as with other GIF pickers.
- This is not a Google product; Google can change the web UI at any time, which may require adjusting the attachment selector in `src/preload.js`.
