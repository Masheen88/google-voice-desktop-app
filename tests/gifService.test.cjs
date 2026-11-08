"use strict";

// Run with `node --test tests/gifService.test.cjs` without installing Electron.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_GIF_BYTES,
  isSafeGiphyGifUrl,
  normalizeGif,
  normalizeSavedGifs,
  downloadGif,
} = require("../src/utils/gifService");

const smallGif = Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff,", "binary");
const gif = {
  id: "abc_123",
  title: "A fun GIF",
  preview: "https://media1.giphy.com/media/abc_123/100w.gif",
  images: [
    { url: "https://media1.giphy.com/media/abc_123/200w.gif", size: 80000, width: 200 },
    { url: "https://media1.giphy.com/media/abc_123/100w.gif", size: 32000, width: 100 },
  ],
};

function response(buffer, status = 200, headers = {}) {
  return new Response(buffer, { status, headers });
}

test("only valid HTTPS GIPHY GIF URLs can be downloaded", () => {
  assert.equal(isSafeGiphyGifUrl(gif.preview), true);
  for (const url of [
    "http://media.giphy.com/media/foo.gif",
    "https://media.giphy.com.attacker.site/foo.gif",
    "https://giphy.com@evil.com/foo.gif",
    "https://giphy.com/path/file.mp4",
    "file:///Users/test/secret.gif",
    "https://evil.example/capture.gif",
  ]) assert.equal(isSafeGiphyGifUrl(url), false, url);
});

test("saved metadata has no arbitrary properties and is capped at 50 entries", () => {
  const original = { ...gif, secret: "do not persist" };
  const clean = normalizeGif(original);
  assert.equal(clean.secret, undefined);
  assert.equal(clean.images.length, 2);
  assert.equal(normalizeSavedGifs(new Array(70).fill(original)).length, 50);
});

test("downloads a real GIF without changing its animation bytes", async () => {
  const result = await downloadGif(gif, async () => response(smallGif));
  assert.equal(result.filename, "voice-gif-abc_123.gif");
  assert.deepEqual(result.bytes, smallGif);
});

test("rejects responses with invalid file headers", async () => {
  await assert.rejects(downloadGif(gif, async () => response(Buffer.from("fake image!"))), /valid animated GIF/);
});

test("retries with smaller rendition if the first file exceeds the limit", async () => {
  let count = 0;
  const result = await downloadGif(gif, async () => {
    count++;
    return count === 1 ? response(Buffer.alloc(MAX_GIF_BYTES + 1, 0x41)) : response(smallGif);
  });
  assert.equal(count, 2);
  assert.deepEqual(result.bytes, smallGif);
});

test("rejects redirects without following them", async () => {
  await assert.rejects(downloadGif(gif, async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return response(null, 302, { Location: "https://example.org/file.gif" });
  }), /valid animated GIF/);
});
