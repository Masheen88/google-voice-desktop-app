"use strict";

/**
 * GIF attachment helpers shared by the Electron main process and the unit tests.
 * Never download arbitrary URLs supplied by a renderer: restrict host, protocol,
 * filename and redirects before fetching untrusted remote media.
 */
const MAX_GIF_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_ATTEMPTS = 8;

/** Only allow actual GIF media hosted by GIPHY over HTTPS. */
function isSafeGiphyGifUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "giphy.com" || url.hostname.endsWith(".giphy.com")) &&
      url.pathname.toLowerCase().endsWith(".gif") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Retain only the small, data-only subset of a GIPHY result we need.
 * The renderer supplies this object, but cannot choose an arbitrary download host.
 */
function normalizeGif(item) {
  if (!item || typeof item !== "object" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id || "")) {
    return null;
  }

  const images = Array.isArray(item.images) ? item.images : [];
  const candidates = images
    .filter((image) => image && isSafeGiphyGifUrl(image.url))
    .slice(0, 12)
    .map((image) => ({
      url: image.url,
      size: Number.isFinite(Number(image.size)) && Number(image.size) > 0
        ? Number(image.size) : 0,
      width: Number(image.width) || 0,
    }));

  if (!candidates.length) return null;

  const preview = typeof item.preview === "string" &&
    /^https:\/\/[a-zA-Z0-9.-]+\.giphy\.com\//i.test(item.preview)
    ? item.preview : candidates[0].url;

  return {
    id: item.id,
    title: String(item.title || "GIF").slice(0, 120),
    preview,
    images: candidates,
  };
}

/**
 * Try multiple resolutions, preferring usable images with more pixels, and reject
 * oversized files without reading an unbounded response into memory.
 */
async function downloadGif(item, fetchImpl = globalThis.fetch) {
  const gif = normalizeGif(item);
  if (!gif) throw new Error("The selected GIF does not contain an allowed GIPHY download URL.");

  const candidates = [...gif.images]
    .filter((image) => !image.size || image.size <= MAX_GIF_BYTES)
    .sort((a, b) => (b.width || b.size) - (a.width || a.size))
    .slice(0, MAX_DOWNLOAD_ATTEMPTS);

  if (!candidates.length) {
    throw new Error("No version of this GIF is under Google Voice's 2 MB attachment limit.");
  }

  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate.url, {
        redirect: "manual", // Prevent a GIPHY URL redirecting to an unrelated network destination.
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok || response.status >= 300 || !response.body) continue;

      const length = Number(response.headers.get("content-length"));
      if (length > MAX_GIF_BYTES) {
        await response.body.cancel();
        continue;
      }

      const pieces = [];
      let total = 0;
      let tooLarge = false;
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > MAX_GIF_BYTES) {
          tooLarge = true;
          break;
        }
        pieces.push(Buffer.from(chunk));
      }
      if (tooLarge) {
        await response.body.cancel().catch(() => {});
        continue;
      }
      const bytes = Buffer.concat(pieces);
      const header = bytes.subarray(0, 6).toString("ascii");
      if (header !== "GIF87a" && header !== "GIF89a") continue;
      return { bytes, filename: `voice-gif-${gif.id}.gif`, gif };
    } catch {
      // An individual resolution might have disappeared; try the next rendition.
    }
  }

  throw new Error("Could not download a valid animated GIF under 2 MB. Try another GIF.");
}

/** Persist short, validated metadata rather than raw GIF files. */
function normalizeSavedGifs(items) {
  if (!Array.isArray(items)) return [];
  return items.map(normalizeGif).filter(Boolean).slice(0, 50);
}

module.exports = {
  MAX_GIF_BYTES,
  isSafeGiphyGifUrl,
  normalizeGif,
  normalizeSavedGifs,
  downloadGif,
};
