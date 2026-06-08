/* ── Google Maps Content Script — Scraper Engine ── */
/* Injected into Google Maps pages to scrape business data */

(function () {
  // Prevent double-initialization if script is injected multiple times
  if (window.__gmapsScraper) return;
  window.__gmapsScraper = true;

  // ── State ──
  let isActive = false;
  let keyword = "";
  let settings = { name: true, phone: true, address: true, rating: true, website: true };
  let processedUrls = new Set();
  let savedCount = 0;
  let processedCount = 0;
  let statusMessage = "Idle";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Message Listener (critical — this was missing in old code) ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "startScrape") {
      if (isActive) {
        sendResponse({ success: false, reason: "Already scraping" });
        return;
      }
      keyword = msg.keyword || "";
      if (msg.settings) settings = { ...settings, ...msg.settings };
      sendResponse({ success: true });

      // Start async scraping
      startScraping();
      return;
    }

    if (msg.action === "stopScrape") {
      isActive = false;
      statusMessage = "Stopped by user";
      updateBadge();
      sendResponse({ success: true });
      return;
    }

    if (msg.action === "getStatus") {
      sendResponse({
        scraping: isActive,
        saved: savedCount,
        processed: processedCount,
        message: statusMessage,
        keyword: keyword,
      });
      return;
    }
  });

  // ── Also check storage on load (fallback for when content script loads with flag already set) ──
  chrome.storage.local.get(["autoScrape", "scrapeKeyword", "scrapeSettings"], (result) => {
    if (result.autoScrape && !isActive) {
      if (!window.location.hostname.includes("google") || !window.location.pathname.startsWith("/maps")) {
        return;
      }
      keyword = result.scrapeKeyword || "";
      if (result.scrapeSettings) settings = { ...settings, ...result.scrapeSettings };
      startScraping();
    }
  });

  // ── Stop on storage change ──
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.autoScrape && changes.autoScrape.newValue === false) {
      isActive = false;
    }
  });

  // ══════════════════════════════════════════════
  // ── SCRAPING ENGINE ──
  // ══════════════════════════════════════════════

  async function startScraping() {
    isActive = true;
    savedCount = 0;
    processedCount = 0;
    processedUrls.clear();
    statusMessage = "Starting...";

    injectBadge();
    updateBadge();

    // Wait for Google Maps to fully render
    statusMessage = "Waiting for results to load...";
    updateBadge();
    await sleep(3000);

    // Main scraping loop
    let noNewResultsRounds = 0;

    while (isActive) {
      const resultCards = getResultCards();
      const unprocessed = resultCards.filter((card) => {
        const url = getCardUrl(card);
        return url && !processedUrls.has(url);
      });

      if (unprocessed.length > 0) {
        noNewResultsRounds = 0;

        for (const card of unprocessed) {
          if (!isActive) break;

          const url = getCardUrl(card);
          if (!url || processedUrls.has(url)) continue;
          processedUrls.add(url);
          processedCount++;

          const cardName = getCardName(card);
          statusMessage = `[${processedCount}] Clicking: ${cardName.substring(0, 30)}`;
          updateBadge();

          try {
            // Scroll card into view and click it
            card.scrollIntoView({ behavior: "smooth", block: "center" });
            await sleep(600);

            if (!card.isConnected) {
              statusMessage = `[${processedCount}] Skipped (detached)`;
              updateBadge();
              continue;
            }

            // Click the card to open the detail panel
            card.click();
            await sleep(500);

            // Wait for the detail panel to load
            const detailLoaded = await waitForDetailPanel(8000);
            if (!isActive) break;

            if (detailLoaded) {
              await sleep(800);
              const lead = extractLeadData(url);

              if (lead.name) {
                const wasSaved = await saveLead(lead);
                if (wasSaved) {
                  savedCount++;
                  statusMessage = `[${savedCount}] ✅ ${lead.name}`;
                } else {
                  statusMessage = `[${processedCount}] Duplicate: ${lead.name}`;
                }
              } else {
                statusMessage = `[${processedCount}] No name found, skipped`;
              }
            } else {
              statusMessage = `[${processedCount}] Timeout loading details`;
            }
          } catch (err) {
            console.error("[Scraper] Error:", err);
            statusMessage = `[${processedCount}] Error: ${err.message}`;
          }

          updateBadge();
          await sleep(400);
        }
      } else {
        // No unprocessed cards — try scrolling for more
        if (isEndOfList()) {
          statusMessage = `✅ Done! ${savedCount} leads from ${processedCount} results.`;
          updateBadge();
          break;
        }

        statusMessage = `Scrolling for more... (${savedCount} saved)`;
        updateBadge();

        const gotMore = await scrollForMore();
        if (!gotMore) {
          noNewResultsRounds++;
          if (noNewResultsRounds >= 4) {
            statusMessage = `✅ Complete! ${savedCount} leads saved.`;
            updateBadge();
            break;
          }
        } else {
          noNewResultsRounds = 0;
        }
      }
    }

    // ── Finished ──
    if (!isActive && statusMessage.startsWith("Stopped")) {
      statusMessage = `⏹ Stopped. ${savedCount} leads saved.`;
    } else if (isActive) {
      statusMessage = `✅ Done! ${savedCount} leads from ${processedCount} results.`;
    }
    isActive = false;
    updateBadge();

    // Update storage
    chrome.storage.local.set({ autoScrape: false, scrapeStatus: "idle" });

    // Remove badge after a delay
    setTimeout(() => {
      const badge = document.getElementById("gme-badge");
      if (badge) {
        const btn = badge.querySelector("button");
        if (btn) btn.style.display = "none";
        setTimeout(() => {
          if (badge && badge.isConnected) badge.remove();
        }, 8000);
      }
    }, 2000);
  }

  // ══════════════════════════════════════════════
  // ── DOM HELPERS ──
  // ══════════════════════════════════════════════

  /**
   * Get all result cards from the left-side results panel.
   */
  function getResultCards() {
    // Primary: article role divs (Google Maps uses role="article" for each result)
    let cards = Array.from(document.querySelectorAll('div[role="feed"] > div > div > a[href*="/maps/place/"]'));
    if (cards.length > 0) return cards;

    // Fallback: any anchor links to place pages inside the feed
    cards = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
    // Filter to only those that look like result cards (have aria-label)
    return cards.filter((a) => a.getAttribute("aria-label") || a.querySelector("div"));
  }

  function getCardUrl(card) {
    const href = card.href || card.getAttribute("href");
    if (!href) return null;
    try {
      const url = new URL(href);
      url.hash = "";
      url.searchParams.delete("hl");
      url.searchParams.delete("gl");
      url.searchParams.delete("authuser");
      return url.toString();
    } catch {
      return href;
    }
  }

  function getCardName(card) {
    return card.getAttribute("aria-label") || card.textContent?.trim()?.substring(0, 40) || "Business";
  }

  /**
   * Get the results feed container.
   */
  function getResultsContainer() {
    return (
      document.querySelector('div[role="feed"]') ||
      document.querySelector(".m6QErb.DxyBCb.kA9KIf.dS8AEf.ecceSd") ||
      document.querySelector(".m6QErb")
    );
  }

  /**
   * Check if we've hit the end of the results list.
   */
  function isEndOfList() {
    const container = getResultsContainer();
    if (!container) return false;
    const text = container.innerText || "";
    return (
      text.includes("You've reached the end of the list") ||
      text.includes("No results found") ||
      text.includes("No more results")
    );
  }

  /**
   * Scroll the results feed to load more items.
   */
  async function scrollForMore() {
    const container = getResultsContainer();
    if (!container) return false;

    const beforeCount = getResultCards().length;
    const scrollStep = Math.max(container.clientHeight, 600);

    for (let attempt = 0; attempt < 5; attempt++) {
      container.scrollTop += scrollStep;

      // Also try scrolling the last result into view
      const cards = getResultCards();
      if (cards.length > 0) {
        try {
          cards[cards.length - 1].scrollIntoView({ behavior: "smooth", block: "end" });
        } catch {}
      }

      // Wait and check for new results
      for (let wait = 0; wait < 4; wait++) {
        await sleep(800);
        if (!isActive) return false;

        const afterCount = getResultCards().length;
        if (afterCount > beforeCount) return true;
        if (isEndOfList()) return false;
      }

      if (isEndOfList()) return false;
    }

    return false;
  }

  /**
   * Wait for the detail panel to load (the right side with business info).
   */
  async function waitForDetailPanel(maxMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (!isActive) return false;

      const h1 =
        document.querySelector("h1.DUwDvf") ||
        document.querySelector("h1.fontHeadlineLarge") ||
        document.querySelector('div[role="main"] h1');

      if (h1 && h1.innerText.trim().length > 0) return true;
      await sleep(400);
    }
    return false;
  }

  // ══════════════════════════════════════════════
  // ── DATA EXTRACTION ──
  // ══════════════════════════════════════════════

  function extractLeadData(uid) {
    const lead = {
      uid,
      timestamp: new Date().toISOString(),
    };

    // ── Name ──
    if (settings.name !== false) {
      const h1 =
        document.querySelector("h1.DUwDvf") ||
        document.querySelector("h1.fontHeadlineLarge") ||
        document.querySelector('div[role="main"] h1');
      if (h1) lead.name = h1.innerText.trim();
    }

    // ── Phone ──
    if (settings.phone !== false) {
      // Method 1: data-item-id starting with "phone:"
      const phoneBtn = document.querySelector('button[data-item-id^="phone:"]');
      if (phoneBtn) {
        const itemId = phoneBtn.getAttribute("data-item-id");
        const phone = itemId.replace("phone:", "").replace("tel:", "").trim();
        if (phone.length > 5) lead.phone = phone;
      }

      // Method 2: tel: links
      if (!lead.phone) {
        const telLink = document.querySelector('a[href^="tel:"]');
        if (telLink) {
          const phone = telLink.href.replace("tel:", "").trim();
          if (phone.length > 5) lead.phone = phone;
        }
      }

      // Method 3: aria-label containing "Phone"
      if (!lead.phone) {
        const phoneEl = document.querySelector('button[aria-label*="Phone"]') ||
                         document.querySelector('button[aria-label*="phone"]');
        if (phoneEl) {
          const label = phoneEl.getAttribute("aria-label") || "";
          const match = label.match(/[\+\d\s\(\)\-]{7,}/);
          if (match) lead.phone = match[0].trim();
        }
      }
    }

    // ── Address ──
    if (settings.address !== false) {
      const addrBtn = document.querySelector('button[data-item-id="address"]');
      if (addrBtn) {
        const label = addrBtn.getAttribute("aria-label") || addrBtn.innerText || "";
        const addr = label.replace(/^Address:\s*/i, "").replace(/\s+/g, " ").trim();
        if (addr.length > 3) lead.address = addr;
      }

      // Fallback
      if (!lead.address) {
        const addrEl = document.querySelector('button[aria-label*="Address"]');
        if (addrEl) {
          const label = addrEl.getAttribute("aria-label") || "";
          const addr = label.replace(/^Address:\s*/i, "").replace(/\s+/g, " ").trim();
          if (addr.length > 3) lead.address = addr;
        }
      }
    }

    // ── Rating ──
    if (settings.rating !== false) {
      // Method 1: span with aria-hidden in the header area
      const ratingSpans = document.querySelectorAll('div.fontBodyMedium span[aria-hidden="true"]');
      for (const span of ratingSpans) {
        if (/^\d/.test(span.textContent)) {
          lead.rating = span.textContent.trim();
          break;
        }
      }

      // Method 2: aria-label with "stars"
      if (!lead.rating) {
        const starEl = document.querySelector('[aria-label*="stars"]');
        if (starEl) {
          const m = starEl.getAttribute("aria-label").match(/([\d.]+)\s*star/);
          if (m) lead.rating = m[1];
        }
      }
    }

    // ── Website ──
    if (settings.website !== false) {
      const webBtn = document.querySelector('a[data-item-id="authority"]');
      if (webBtn) {
        lead.website = webBtn.href;
      }
      if (!lead.website) {
        const webLink = document.querySelector('a[aria-label*="Website"]') ||
                         document.querySelector('a[aria-label*="website"]');
        if (webLink) lead.website = webLink.href;
      }
    }

    return lead;
  }

  // ══════════════════════════════════════════════
  // ── SAVE TO STORAGE ──
  // ══════════════════════════════════════════════

  async function saveLead(newLead) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["keywordsData"], (result) => {
        const allData = result.keywordsData || {};
        const existing = allData[keyword] || [];

        // Dedup by UID (normalized URL)
        const isDuplicate = existing.some((l) => l.uid === newLead.uid);
        if (isDuplicate) {
          resolve(false);
          return;
        }

        existing.push(newLead);
        allData[keyword] = existing;
        chrome.storage.local.set({ keywordsData: allData }, () => {
          resolve(true);
        });
      });
    });
  }

  // ══════════════════════════════════════════════
  // ── FLOATING BADGE UI ──
  // ══════════════════════════════════════════════

  function injectBadge() {
    // Remove existing badge if any
    const old = document.getElementById("gme-badge");
    if (old) old.remove();

    const el = document.createElement("div");
    el.id = "gme-badge";
    el.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      background: #ffffff;
      color: #333;
      padding: 14px 18px;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      border: 2px solid #1677ff;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 240px;
      max-width: 320px;
      transition: opacity 0.3s;
    `;
    el.innerHTML = `
      <div style="font-weight:700;font-size:14px;color:#1677ff;display:flex;align-items:center;gap:6px;">
        <span style="font-size:16px;">📍</span>
        <span>Scraping: <span style="color:#333;font-weight:600;">${escapeHtml(keyword)}</span></span>
      </div>
      <div id="gme-progress" style="color:#666;font-size:12px;line-height:1.4;">Starting...</div>
      <div id="gme-stats" style="color:#1677ff;font-size:12px;font-weight:600;"></div>
      <button id="gme-stop" style="
        margin-top:2px;background:#ff4d4f;color:#fff;border:none;
        padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:600;
        font-size:12px;transition:background 0.2s;
      ">⏹ Stop Scraping</button>
    `;
    document.body.appendChild(el);

    document.getElementById("gme-stop").addEventListener("click", () => {
      isActive = false;
      statusMessage = "Stopped by user";
      chrome.storage.local.set({ autoScrape: false });
      updateBadge();
    });
  }

  function updateBadge() {
    const progress = document.getElementById("gme-progress");
    const stats = document.getElementById("gme-stats");
    if (progress) progress.textContent = statusMessage;
    if (stats) stats.textContent = `✅ Saved: ${savedCount}  |  📊 Processed: ${processedCount}`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
