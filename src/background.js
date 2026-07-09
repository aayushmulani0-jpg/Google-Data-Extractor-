/* ── Background Service Worker ── */

let activeScrapeTabId = null;

// Clean up when the scraping tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeScrapeTabId) {
    activeScrapeTabId = null;
    chrome.storage.local.set({ autoScrape: false, scrapeStatus: "idle" });
    console.log("[BG] Scraping tab closed — stopped.");
  }
});

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── START SCRAPE ──
  if (msg.action === "startScrape") {
    const { keyword, settings, filters } = msg;

    // Save intent to storage (content script also reads this on load)
    chrome.storage.local.set({
      autoScrape: true,
      scrapeKeyword: keyword,
      scrapeSettings: settings,
      scrapeFilters: filters || {},
      scrapeStatus: "starting",
    });

    // Find existing Google Maps tab or open a new one
    chrome.tabs.query({}, (tabs) => {
      // Filter manually since * in host pattern is invalid for tabs.query
      const mapsTabs = tabs.filter(t => t.url && t.url.includes("google.") && t.url.includes("/maps/"));
      if (mapsTabs && mapsTabs.length > 0) {
        // Focus existing tab
        const tab = mapsTabs[0];
        activeScrapeTabId = tab.id;

        // Update the tab URL to search for the keyword
        const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/`;
        chrome.tabs.update(tab.id, { active: true, url: mapsUrl }, () => {
          // Wait for page to load, then inject
          waitForTabLoad(tab.id, () => {
            injectAndStart(tab.id, keyword, settings, filters);
          });
        });
        sendResponse({ success: true });
      } else {
        // Open new tab
        const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/`;
        chrome.tabs.create({ url: mapsUrl, active: true }, (tab) => {
          activeScrapeTabId = tab.id;
          waitForTabLoad(tab.id, () => {
            injectAndStart(tab.id, keyword, settings, filters);
          });
        });
        sendResponse({ success: true });
      }
    });

    return true; // async response
  }

  // ── STOP SCRAPE ──
  if (msg.action === "stopScrape") {
    chrome.storage.local.set({ autoScrape: false, scrapeStatus: "idle" });
    if (activeScrapeTabId) {
      chrome.tabs.sendMessage(activeScrapeTabId, { action: "stopScrape" }).catch(() => {});
    }
    activeScrapeTabId = null;
    sendResponse({ success: true });
    return true;
  }

  // ── GET STATUS ──
  if (msg.action === "getStatus") {
    if (activeScrapeTabId) {
      chrome.tabs
        .sendMessage(activeScrapeTabId, { action: "getStatus" })
        .then((resp) => sendResponse(resp))
        .catch(() => sendResponse({ scraping: false, saved: 0, processed: 0, message: "Not running" }));
    } else {
      sendResponse({ scraping: false, saved: 0, processed: 0, message: "Idle" });
    }
    return true;
  }
});

// ── Helpers ──

function waitForTabLoad(tabId, callback, maxAttempts = 40) {
  let attempts = 0;
  const check = setInterval(() => {
    attempts++;
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        clearInterval(check);
        return;
      }
      if (tab.status === "complete") {
        clearInterval(check);
        // Small extra delay for Google Maps JS to initialize
        setTimeout(callback, 1500);
      }
      if (attempts >= maxAttempts) {
        clearInterval(check);
        // Try anyway
        setTimeout(callback, 500);
      }
    });
  }, 500);
}

function injectAndStart(tabId, keyword, settings, filters) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      files: ["content.js"],
    })
    .then(() => {
      // Give the content script a moment to set up its listener
      setTimeout(() => {
        const message = {
          action: "startScrape",
          keyword,
          settings,
          filters: filters || {},
        };
        chrome.tabs
          .sendMessage(tabId, message)
          .then((resp) => {
            console.log("[BG] Content script responded:", resp);
          })
          .catch((err) => {
            console.warn("[BG] sendMessage failed, retrying:", err.message);
            // Retry once after a longer delay
            setTimeout(() => {
              chrome.tabs
                .sendMessage(tabId, message)
                .catch((e) => console.error("[BG] Retry also failed:", e.message));
            }, 3000);
          });
      }, 1000);
    })
    .catch((err) => {
      console.error("[BG] Script injection failed:", err);
    });
}

// Clean up on service worker suspend
chrome.runtime.onSuspend.addListener(() => {
  chrome.storage.local.set({ autoScrape: false, scrapeStatus: "idle" });
});
