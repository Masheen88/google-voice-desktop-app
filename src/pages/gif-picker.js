/**********************************************************************************************************************
 * Local, sandboxed Voice Desktop GIPHY picker. Searches GIPHY directly from the client (their API requirement).
 * All GIF downloads and attachment requests are strictly validated by the Electron main process.
 **********************************************************************************************************************/
(() => {
  "use strict";
  const api = window.voiceGifPicker;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  const grid = $("grid");
  const status = $("status");
  const more = $("more");
  const saveGifButton = $("save-gif");
  let failedGif = null;
  const searchInput = $("search");
  const resultsWrap = $("results-wrap");
  const quick = $("quick");
  let settings = null;
  let currentTab = "trending";
  let offset = 0;
  let pendingSearch = 0;
  let latestRequest = null;
  let debounceTimer = null;
  let busy = false;
  let displayedIds = new Set();

  /** Visible status updates also announce failures to assistive technologies. */
  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function isFavorite(id) {
    return settings.favorites.some((item) => item.id === id);
  }

  /** Keep stored favorites in sync with the main process, which performs validation. */
  async function toggleFavorite(item, button) {
    try {
      const result = isFavorite(item.id)
        ? await api.removeFavorite(item.id)
        : await api.saveFavorite(item);
      settings.favorites = result;
      button.classList.toggle("saved", isFavorite(item.id));
      button.textContent = isFavorite(item.id) ? "★" : "☆";
      button.title = isFavorite(item.id) ? "Remove from favorites" : "Add to favorites";
      if (currentTab === "favorites") await showSaved("favorites");
    } catch (error) {
      showStatus(error.message || "Could not save favorite.");
    }
  }

  /** Normalize API entries before attaching them to clickable controls. */
  function normalizeResponse(item) {
    const images = item?.images || {};
    const preferred = ["downsized", "fixed_width", "fixed_height", "fixed_width_small", "fixed_height_small", "preview_gif", "original"];
    const renditions = preferred
      .map((name) => images[name])
      .filter((value) => value && typeof value.url === "string" && /^https:\/\/[^/]+\.giphy\.com\//i.test(value.url) && value.url.split("?")[0].endsWith(".gif"))
      .map((value) => ({ url: value.url, size: value.size || 0, width: value.width || 0 }));
    if (!renditions.length || !/^[a-zA-Z0-9_-]{1,80}$/.test(item?.id || "")) return null;
    const preview = images.fixed_width_small?.url || images.preview_gif?.url || images.fixed_width?.url || renditions[0].url;
    return { id: item.id, title: String(item.title || "GIF").slice(0, 120), preview, images: renditions };
  }

  /** Never construct HTML from network-supplied GIF titles or URLs. */
  function createCard(item) {
    const article = document.createElement("article");
    article.className = "gif-card";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "gif-select";
    select.title = `${item.title} — attach GIF`;
    select.setAttribute("aria-label", `Attach ${item.title}`);
    const img = document.createElement("img");
    img.className = "gif-preview";
    img.loading = "lazy";
    img.alt = item.title;
    // The local page's CSP additionally constrains image origins to GIPHY.
    img.src = item.preview;
    select.append(img);
    select.addEventListener("click", () => void attachGif(item));

    const star = document.createElement("button");
    star.type = "button";
    star.className = `star${isFavorite(item.id) ? " saved" : ""}`;
    star.textContent = isFavorite(item.id) ? "★" : "☆";
    star.title = isFavorite(item.id) ? "Remove from favorites" : "Add to favorites";
    star.setAttribute("aria-label", star.title);
    star.addEventListener("click", () => void toggleFavorite(item, star));

    article.append(select, star);
    return article;
  }

  /** Fetch/attach is delegated to main; sending the message remains a manual Google Voice action. */
  async function attachGif(item) {
    if (busy) return;
    busy = true;
    failedGif = null;
    saveGifButton.hidden = true;
    document.body.dataset.busy = "true";
    showStatus("Preparing GIF under 2 MB…");
    try {
      const result = await api.selectGif(item);
      if (result?.ok) {
        api.close();
      } else {
        failedGif = item;
        saveGifButton.hidden = false;
        showStatus(result?.error || "Could not attach the selected GIF. Try another one.");
      }
    } catch (error) {
      failedGif = item;
      saveGifButton.hidden = false;
      showStatus(error.message || "Could not attach GIF.");
    } finally {
      busy = false;
      document.body.dataset.busy = "false";
    }
  }

  function appendItems(items, reset = false) {
    if (reset) {
      saveGifButton.hidden = true;
      failedGif = null;
      grid.replaceChildren();
      displayedIds = new Set();
      resultsWrap.scrollTop = 0;
    }
    for (const item of items) {
      if (item && !displayedIds.has(item.id)) {
        displayedIds.add(item.id);
        grid.append(createCard(item));
      }
    }
    showStatus(displayedIds.size ? "" : "No GIFs here yet. Try another search.");
  }

  async function showSaved(tab) {
    latestRequest?.abort();
    more.hidden = true;
    const items = tab === "favorites" ? settings.favorites : settings.recent;
    appendItems(items, true);
    if (!items.length) showStatus(tab === "favorites" ? "Star GIFs to find them here later." : "Your recently attached GIFs will appear here.");
  }

  /** Search GIPHY from the client with cancellation, debounce and pagination. */
  async function loadResults(reset = true) {
    if (currentTab !== "trending") return;
    if (!settings?.apiKey) {
      showStatus("Add your free GIPHY API key in File → Settings → GIF picker to search GIFs.");
      more.hidden = true;
      grid.replaceChildren();
      return;
    }
    if (reset) {
      offset = 0;
      displayedIds = new Set();
      grid.replaceChildren();
      resultsWrap.scrollTop = 0;
    }
    latestRequest?.abort();
    const controller = new AbortController();
    latestRequest = controller;
    const myRequest = ++pendingSearch;
    more.hidden = true;
    showStatus("Searching GIFs…");

    const query = searchInput.value.trim().slice(0, 50);
    const endpoint = query ? "search" : "trending";
    const url = new URL(`https://api.giphy.com/v1/gifs/${endpoint}`);
    url.searchParams.set("api_key", settings.apiKey);
    url.searchParams.set("limit", "24");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("rating", settings.rating || "pg");
    if (query) url.searchParams.set("q", query);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 429 ? "GIPHY rate limit reached. Try again later." : `GIPHY request failed (${response.status}). Check your API key.`);
      const responseData = await response.json();
      if (myRequest !== pendingSearch) return;
      const items = (responseData.data || []).map(normalizeResponse).filter(Boolean);
      appendItems(items, false);
      if (!displayedIds.size) showStatus("No GIFs found. Try a different search.");
      const pagination = responseData.pagination || {};
      offset += (responseData.data || []).length;
      more.hidden = !items.length || offset >= (pagination.total_count || 0);
    } catch (error) {
      if (error.name === "AbortError") return;
      showStatus(`Unable to load GIFs. ${error.message}`);
    }
  }

  function changeTab(tab) {
    currentTab = tab;
    clearTimeout(debounceTimer);
    document.querySelectorAll(".tabs button").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    quick.hidden = tab !== "trending";
    searchInput.placeholder = tab === "trending" ? "Search GIFs…" : "Search GIFs…";
    if (tab === "trending") void loadResults();
    else void showSaved(tab);
  }

  saveGifButton.addEventListener("click", async () => {
    if (!failedGif) return;
    saveGifButton.disabled = true;
    showStatus("Saving GIF…");
    try {
      const result = await api.saveGif(failedGif);
      showStatus(result.ok ? "Saved! In Google Voice, click Select image and choose this GIF." : (result.error || "Unable to save GIF."));
      if (result.ok) saveGifButton.hidden = true;
    } catch (error) {
      showStatus(error.message || "Unable to save GIF.");
    } finally {
      saveGifButton.disabled = false;
    }
  });

  $("close").addEventListener("click", () => api.close());
  $("giphy").addEventListener("click", () => api.openGiphy());
  document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => changeTab(button.dataset.tab)));
  quick.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    searchInput.value = button.dataset.query;
    changeTab("trending");
    searchInput.focus();
  }));
  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    if (currentTab !== "trending") changeTab("trending");
    else debounceTimer = setTimeout(() => void loadResults(), 400);
  });
  more.addEventListener("click", () => void loadResults(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") api.close();
    if (event.key === "/" && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
    }
  });

  // On each open reload settings so changing API keys/favorites works without restarting.
  (async () => {
    try {
      settings = await api.getSettings();
      if (settings.theme === "default" || ["minty", "cerulean"].includes(settings.theme)) {
        document.documentElement.style.colorScheme = "light";
        // Keep the high-contrast picker dark for consistent GIF preview legibility.
      }
      changeTab("trending");
      searchInput.focus();
    } catch (error) {
      showStatus(`Cannot load GIF settings: ${error.message}`);
    }
  })();
})();
