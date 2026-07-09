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
  let filters = { priceRange: null, minRating: null, includeSponsored: true };
  let processedUrls = new Set();
  let savedCount = 0;
  let processedCount = 0;
  let statusMessage = "Idle";
  let saveLock = Promise.resolve(); // serializes saveLead calls

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Message Listener ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "startScrape") {
      if (isActive) {
        sendResponse({ success: false, reason: "Already scraping" });
        return;
      }
      keyword = msg.keyword || "";
      if (msg.settings) settings = { ...settings, ...msg.settings };
      if (msg.filters) filters = { ...filters, ...msg.filters };
      sendResponse({ success: true });
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

  // ── Stop on storage change ──
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.autoScrape && changes.autoScrape.newValue === false) {
      isActive = false;
    }
  });

  // ── Stop scraping when tab is closed or navigated away ──
  window.addEventListener("beforeunload", () => {
    if (isActive) {
      isActive = false;
      statusMessage = "Stopped — tab closed";
      chrome.storage.local.set({ autoScrape: false, scrapeStatus: "idle" });
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

    // Read filters from storage as fallback (in case script was cached from a previous injection)
    try {
      const stored = await new Promise((res) =>
        chrome.storage.local.get(["scrapeFilters"], (r) => res(r))
      );
      if (stored.scrapeFilters) {
        filters = { ...filters, ...stored.scrapeFilters };
      }
    } catch {}
    console.log("[Scraper] Filters:", JSON.stringify(filters));

    injectBadge();
    updateBadge();

    // Wait for Google Maps to fully render
    statusMessage = "Waiting for results to load...";
    updateBadge();
    await sleep(3000);

    // ── Single-pass scraping loop ──
    // Process visible cards, then scroll down to reveal more.
    // Key: we detect "new results" by checking for unprocessed URLs,
    // NOT by comparing DOM card counts (which fails due to virtualization).
    let staleScrollRounds = 0;
    let lastProcessedUrl = null;

    while (isActive) {
      // 1. Get currently visible cards and find unprocessed ones
      const cards = getResultCards();
      
      let startIndex = 0;
      if (lastProcessedUrl) {
        // Find the index of the last processed card in the current visible DOM
        const lastIndex = cards.findIndex(c => getCardUrl(c) === lastProcessedUrl);
        if (lastIndex !== -1) {
          // Only look at cards AFTER the last processed one to prevent jumping UP
          startIndex = lastIndex + 1;
        }
      }

      const unprocessed = [];
      for (let i = startIndex; i < cards.length; i++) {
        const card = cards[i];
        const url = getCardUrl(card);
        if (url && !processedUrls.has(url)) {
          unprocessed.push(card);
        }
      }

      if (unprocessed.length > 0) {
        // Reset stale counter — we found work to do
        staleScrollRounds = 0;

        // Process ONE card at a time, then re-query the DOM.
        // Google Maps may recycle/detach cards when the detail panel opens,
        // so we can't iterate a stale NodeList.
        const card = unprocessed[0];
        const url = getCardUrl(card);
        if (!url || processedUrls.has(url)) continue;

        processedUrls.add(url);
        lastProcessedUrl = url;
        processedCount++;

        const cardName = getCardName(card);
        statusMessage = `[${processedCount}] Clicking: ${cardName.substring(0, 30)}`;
        updateBadge();

        try {
          // Scroll card into view
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          await sleep(500);

          // Check it's still in the DOM
          if (!card.isConnected) {
            statusMessage = `[${processedCount}] Skipped (detached)`;
            updateBadge();
            continue;
          }

          // Check if this is a sponsored result
          if (!filters.includeSponsored && isSponsored(card)) {
            statusMessage = `[${processedCount}] Skipped (sponsored)`;
            updateBadge();
            await sleep(300);
            continue;
          }

          // Click the card to open the detail panel on the right
          card.click();
          await sleep(800);

          // Wait for the detail panel to load with the correct business
          const detailLoaded = await waitForDetailPanel(12000, cardName);
          if (!isActive) break;

          if (detailLoaded) {
            // Wait longer for all detail elements (phone, address, etc.) to render
            await sleep(1500);
            const lead = extractLeadData(url);

            // Fallback: use card name if detail panel name wasn't extracted
            if (!lead.name && cardName && cardName !== "Business") {
              lead.name = cardName;
            }

            if (lead.name) {
              // Apply filters before saving
              const filterResult = applyFilters(lead);
              if (filterResult === true) {
                const wasSaved = await saveLead(lead);
                if (wasSaved) {
                  savedCount++;
                  statusMessage = `[${savedCount}] ✅ ${lead.name}`;
                } else {
                  statusMessage = `[${processedCount}] Duplicate: ${lead.name}`;
                }
              } else {
                statusMessage = `[${processedCount}] Filtered: ${filterResult}`;
              }
            } else {
              statusMessage = `[${processedCount}] No name found, skipped`;
            }
          } else {
            // Retry once: click again and wait
            statusMessage = `[${processedCount}] Retrying...`;
            updateBadge();
            card.scrollIntoView({ behavior: "smooth", block: "center" });
            await sleep(400);
            if (card.isConnected) {
              card.click();
              await sleep(800);
              const retryLoaded = await waitForDetailPanel(8000, cardName);
              if (retryLoaded) {
                await sleep(1500);
                const lead = extractLeadData(url);
                if (!lead.name && cardName && cardName !== "Business") {
                  lead.name = cardName;
                }
                if (lead.name) {
                  const filterResult = applyFilters(lead);
                  if (filterResult === true) {
                    const wasSaved = await saveLead(lead);
                    if (wasSaved) {
                      savedCount++;
                      statusMessage = `[${savedCount}] ✅ ${lead.name}`;
                    } else {
                      statusMessage = `[${processedCount}] Duplicate: ${lead.name}`;
                    }
                  } else {
                    statusMessage = `[${processedCount}] Filtered: ${filterResult}`;
                  }
                } else {
                  statusMessage = `[${processedCount}] No name found after retry`;
                }
              } else {
                statusMessage = `[${processedCount}] Timeout after retry`;
              }
            } else {
              statusMessage = `[${processedCount}] Card detached, skipped`;
            }
          }
        } catch (err) {
          console.error("[Scraper] Error processing card:", err);
          statusMessage = `[${processedCount}] Error: ${err.message}`;
        }

        updateBadge();
        await sleep(300);
      } else {
        // 2. No unprocessed cards visible — we need to scroll for more

        // First check: have we reached the end of the list?
        if (isEndOfList()) {
          statusMessage = `✅ Done! ${savedCount} leads from ${processedCount} results.`;
          updateBadge();
          break;
        }

        statusMessage = `Scrolling for more results... (${savedCount} saved so far)`;
        updateBadge();

        // Scroll down
        const scrolled = await scrollForMore();

        if (scrolled) {
          // Wait for new cards to load
          await sleep(1500);

          // Check if we actually got new unprocessed cards
          const newCards = getResultCards();
          let hasNew = false;
          for (const c of newCards) {
            const u = getCardUrl(c);
            if (u && !processedUrls.has(u)) {
              hasNew = true;
              break;
            }
          }

          if (hasNew) {
            staleScrollRounds = 0;
          } else {
            staleScrollRounds++;
          }
        } else {
          // Scroll position didn't change
          staleScrollRounds++;
        }

        // If we've scrolled many times without finding new results, give up
        if (staleScrollRounds >= 30) {
          // One final end-of-list check
          if (isEndOfList()) {
            statusMessage = `✅ Done! ${savedCount} leads from ${processedCount} results.`;
          } else {
            statusMessage = `✅ Complete! ${savedCount} leads saved (no more results loading).`;
          }
          updateBadge();
          break;
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
   * Get all result cards (anchor links to /maps/place/) from the results panel.
   * Google Maps only renders ~7-20 cards at a time (virtualized list).
   */
  function getResultCards() {
    // Primary: links inside the feed container
    let cards = Array.from(
      document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]')
    );
    if (cards.length > 0) return cards;

    // Broader fallback: any place link that looks like a result card
    cards = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
    return cards.filter(
      (a) => a.getAttribute("aria-label") || a.querySelector("div")
    );
  }

  /**
   * Check if a result card is a sponsored/ad result.
   * Google Maps marks sponsored results with "Sponsored" text or ad indicators.
   */
  function isSponsored(card) {
    // Scoped container check: Walk up to find the individual card's wrapper,
    // making sure we don't accidentally grab the entire list container (role="feed")
    let container = card;
    for (let i = 0; i < 3; i++) {
        if (container.parentElement && !container.parentElement.hasAttribute("role")) {
            container = container.parentElement;
        } else {
            break;
        }
    }

    const text = (container.innerText || "").toLowerCase();
    
    // Sponsored/Ad label usually appears at the top of the individual card
    // Check only the first 150 chars to avoid false positives in reviews
    const topText = text.substring(0, 150);
    if (topText.includes("sponsored")) return true;
    if (topText.includes(" ad\n") || topText.startsWith("ad\n")) return true;
    
    // Check data attributes within the scoped container
    if (container.querySelector('[data-ad-preview]') || container.closest('[data-ad-preview]')) return true;
    if (container.querySelector('[data-is-ad]') || container.closest('[data-is-ad]')) return true;
    
    return false;
  }

  function getCardUrl(card) {
    const href = card.href || card.getAttribute("href");
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      url.hash = "";
      // Strip all transient/non-identifying query params
      const paramsToRemove = ["hl", "gl", "authuser", "entry", "g_ep", "g_st", "sa", "ved"];
      paramsToRemove.forEach((p) => url.searchParams.delete(p));
      
      // Return the full clean URL instead of just the name segment.
      // This ensures different branches of the same franchise are not treated as the same URL
      // and thus skipped during scraping, preventing "random jumping".
      return url.toString();
    } catch {
      return href;
    }
  }

  function getCardName(card) {
    return (
      card.getAttribute("aria-label") ||
      card.textContent?.trim()?.substring(0, 40) ||
      "Business"
    );
  }

  /**
   * Get the scrollable results container.
   * The feed div (role="feed") itself is usually not the scrollable element —
   * it's a parent div with overflow-y that actually scrolls.
   */
  function getResultsContainer() {
    const feed = document.querySelector('div[role="feed"]');
    if (feed) {
      // Walk up from the feed to find the scrollable parent
      let el = feed.parentElement;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 10
        ) {
          return el;
        }
        el = el.parentElement;
      }
      // Fallback: use the feed itself
      return feed;
    }
    return (
      document.querySelector(".m6QErb.DxyBCb.kA9KIf.dS8AEf.ecceSd") ||
      document.querySelector(".m6QErb")
    );
  }

  /**
   * Check if we've hit the end of the results list.
   * Google Maps shows a specific element or text when all results are loaded.
   */
  function isEndOfList() {
    // Google Maps renders a span with class "HlvSq" at the end
    if (document.querySelector("span.HlvSq")) return true;

    // Check specific elements for end-of-list text rather than scanning the whole container
    // This avoids false positives where a user review might contain "no results found".
    const allSpans = document.querySelectorAll("span");
    for (const span of allSpans) {
      const txt = (span.innerText || "").trim();
      if (
        txt === "You've reached the end of the list" ||
        txt === "No results found" ||
        txt === "No more results"
      ) {
        return true;
      }
    }
    
    const allDivs = document.querySelectorAll("div");
    for (const div of allDivs) {
      const txt = (div.innerText || "").trim();
      if (
        txt === "You've reached the end of the list" ||
        txt === "No results found" ||
        txt === "No more results"
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Scroll the results panel down to load more items.
   * Returns true if scroll position actually changed (i.e. we scrolled).
   */
  async function scrollForMore() {
    const container = getResultsContainer();
    if (!container) return false;

    const scrollBefore = container.scrollTop;

    // Scroll by a good chunk
    const step = Math.max(container.clientHeight, 500);
    container.scrollTop += step;

    // Also try forcing the last card into view
    const cards = getResultCards();
    if (cards.length > 0) {
      try {
        cards[cards.length - 1].scrollIntoView({
          behavior: "smooth",
          block: "end",
        });
      } catch {}
    }

    // Small wait to let the scroll settle and new items render
    await sleep(800);
    if (!isActive) return false;

    // Did we actually scroll?
    const scrollAfter = container.scrollTop;
    return Math.abs(scrollAfter - scrollBefore) > 5;
  }

  /**
   * Wait for the detail panel to load (the right side panel with business info).
   * Verifies the h1 text changed to match the expected business name.
   */
  async function waitForDetailPanel(maxMs = 12000, expectedName = "") {
    const start = Date.now();
    const normalExpected = expectedName.toLowerCase().trim();
    while (Date.now() - start < maxMs) {
      if (!isActive) return false;

      const h1 =
        document.querySelector("h1.DUwDvf") ||
        document.querySelector("h1.fontHeadlineLarge") ||
        document.querySelector('div[role="main"] h1');

      if (h1 && h1.innerText.trim().length > 0) {
        // If we have an expected name, verify the panel is showing the right business
        if (normalExpected) {
          const panelName = h1.innerText.trim().toLowerCase();
          // Check if the panel name contains or starts with the expected name (or vice versa)
          if (
            panelName.includes(normalExpected.substring(0, 15)) ||
            normalExpected.includes(panelName.substring(0, 15))
          ) {
            return true;
          }
          // Even if names don't match closely, accept after a reasonable wait
          // (the expected name from aria-label might differ from the h1 text)
          if (Date.now() - start > 3000) return true;
        } else {
          return true;
        }
      }
      await sleep(300);
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
        const phoneEl =
          document.querySelector('button[aria-label*="Phone"]') ||
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
        const label =
          addrBtn.getAttribute("aria-label") || addrBtn.innerText || "";
        const addr = label
          .replace(/^Address:\s*/i, "")
          .replace(/\s+/g, " ")
          .trim();
        if (addr.length > 3) lead.address = addr;
      }

      // Fallback
      if (!lead.address) {
        const addrEl = document.querySelector('button[aria-label*="Address"]');
        if (addrEl) {
          const label = addrEl.getAttribute("aria-label") || "";
          const addr = label
            .replace(/^Address:\s*/i, "")
            .replace(/\s+/g, " ")
            .trim();
          if (addr.length > 3) lead.address = addr;
        }
      }
    }

    // ── Rating ──
    if (settings.rating !== false) {
      // Method 1: span with aria-hidden in the header area
      const ratingSpans = document.querySelectorAll(
        'div.fontBodyMedium span[aria-hidden="true"]'
      );
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
          const m = starEl
            .getAttribute("aria-label")
            .match(/([\d.]+)\s*star/);
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
        const webLink =
          document.querySelector('a[aria-label*="Website"]') ||
          document.querySelector('a[aria-label*="website"]');
        if (webLink) lead.website = webLink.href;
      }
    }

    return lead;
  }

  // ══════════════════════════════════════════════
  // ── FILTERS ──
  // ══════════════════════════════════════════════

  /**
   * Apply user-configured filters to a lead.
   * Returns true if the lead passes all filters, or a string describing why it was filtered.
   */
  function applyFilters(lead) {

    // Minimum rating filter
    if (filters.minRating && filters.minRating > 0) {
      if (lead.rating) {
        const ratingNum = parseFloat(lead.rating);
        if (!isNaN(ratingNum) && ratingNum < filters.minRating) {
          return `rating ${lead.rating} < ${filters.minRating}`;
        }
      }
      // If no rating found, still include it
    }

    return true;
  }

  // ══════════════════════════════════════════════
  // ── SAVE TO STORAGE ──
  // ══════════════════════════════════════════════

  async function saveLead(newLead) {
    // Serialize save calls to prevent race-condition duplicates
    const result = new Promise((resolve) => {
      saveLock = saveLock.then(() => new Promise((done) => {
        chrome.storage.local.get(["keywordsData"], (result) => {
          const allData = result.keywordsData || {};
          const existing = allData[keyword] || [];

          // Dedup by UID (normalized URL)
          const uidDup = existing.some((l) => l.uid === newLead.uid);
          if (uidDup) {
            resolve(false);
            done();
            return;
          }

          // Secondary dedup by name AND (phone OR address) to avoid merging different branches
          if (newLead.name) {
            const normName = newLead.name.toLowerCase().replace(/\s+/g, " ").trim();
            const isTrueDuplicate = existing.some((l) => {
              if (!l.name) return false;
              const existName = l.name.toLowerCase().replace(/\s+/g, " ").trim();
              if (existName !== normName) return false;
              
              // If name matches, check if phone or address matches
              const phoneMatch = l.phone && newLead.phone && l.phone === newLead.phone;
              const addrMatch = l.address && newLead.address && l.address === newLead.address;
              
              // If we have phone/address for both and they match, it's a duplicate
              return phoneMatch || addrMatch;
            });
            if (isTrueDuplicate) {
              resolve(false);
              done();
              return;
            }
          }

          existing.push(newLead);
          allData[keyword] = existing;
          chrome.storage.local.set({ keywordsData: allData }, () => {
            resolve(true);
            done();
          });
        });
      }));
    });
    return result;
  }

  // ══════════════════════════════════════════════
  // ── FLOATING BADGE UI ──
  // ══════════════════════════════════════════════

  function injectBadge() {
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
    if (stats)
      stats.textContent = `✅ Saved: ${savedCount}  |  📊 Processed: ${processedCount}`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
