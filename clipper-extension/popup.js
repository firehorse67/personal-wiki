document.addEventListener('DOMContentLoaded', () => {
  const titleInput = document.getElementById('title');
  const urlInput = document.getElementById('url');
  const descriptionInput = document.getElementById('description');
  const clipModeSelect = document.getElementById('clip-mode');
  const clipBtn = document.getElementById('clip-btn');
  const statusDiv = document.getElementById('status');
  const setupWarning = document.getElementById('setup-warning');
  const mainForm = document.getElementById('main-form');
  const openOptionsLink = document.getElementById('open-options');
  const goToOptionsBtn = document.getElementById('go-to-options');

  let clipperToken = '';
  let clipperServerUrl = '';
  let activeTabId = null;
  let activeTabWindowId = null;
  let activeTabUrl = '';

  function showStatus(message, isError = false) {
    statusDiv.textContent = message;
    statusDiv.className = isError ? 'error' : 'success';
    statusDiv.style.display = 'block';
  }

  function hideStatus() {
    statusDiv.style.display = 'none';
  }

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  function isRestrictedUrl(url) {
    if (!url) return true;
    return (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('edge://') ||
      url.startsWith('about:') ||
      url.startsWith('https://chrome.google.com/') ||
      url.startsWith('https://chromewebstore.google.com/')
    );
  }

  openOptionsLink.addEventListener('click', openOptions);
  goToOptionsBtn.addEventListener('click', openOptions);

  // Load saved settings
  chrome.storage.local.get(['clipperToken', 'clipperServerUrl'], (result) => {
    if (!result.clipperToken || !result.clipperServerUrl) {
      setupWarning.style.display = 'block';
      mainForm.style.display = 'none';
    } else {
      clipperToken = result.clipperToken;
      clipperServerUrl = result.clipperServerUrl;
      setupWarning.style.display = 'none';
      mainForm.style.display = 'block';
    }
  });

  // Load active tab info and look for active text selection
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      const activeTab = tabs[0];
      activeTabId = activeTab.id;
      activeTabWindowId = activeTab.windowId;
      activeTabUrl = activeTab.url || '';
      
      titleInput.value = activeTab.title || '';
      urlInput.value = activeTabUrl;

      if (isRestrictedUrl(activeTabUrl)) {
        // Disable modes that require page access
        clipModeSelect.value = 'article'; // Fallback
        for (const value of ['selection', 'screenshot', 'screenshot-area', 'screenshot-full']) {
          const option = clipModeSelect.querySelector(`option[value="${value}"]`);
          if (option) option.disabled = true;
        }
        descriptionInput.placeholder = 'System pages cannot be screenshotted or parsed.';
      } else {
        // Read any text selection, plus page metadata for a default description
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => {
            const meta = (sel) => {
              const el = document.querySelector(sel);
              return el ? (el.getAttribute('content') || '').trim() : '';
            };
            return {
              selection: window.getSelection().toString().trim(),
              siteName: meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]'),
              published: meta('meta[property="article:published_time"]') ||
                         meta('meta[name="date"]') ||
                         (document.querySelector('article time[datetime]')?.getAttribute('datetime') || '')
            };
          }
        }, (results) => {
          if (chrome.runtime.lastError) {
            console.warn('Scripting failed (expected on some pages):', chrome.runtime.lastError.message);
            return;
          }
          const info = results && results[0] && results[0].result;
          if (!info) return;
          if (info.selection) {
            descriptionInput.value = info.selection;
            // Default to selection mode if there is selected text
            clipModeSelect.value = 'selection';
          } else if (!descriptionInput.value) {
            // Pre-fill "Site: 16 July 2026" from page metadata; falls back to
            // the site hostname and today's date. Editable before clipping.
            const site = info.siteName || new URL(activeTabUrl).hostname.replace(/^www\./, '');
            const when = info.published ? new Date(info.published) : new Date();
            const dateStr = isNaN(when) ? '' : when.toLocaleDateString('en-AU', {
              day: 'numeric', month: 'long', year: 'numeric'
            });
            descriptionInput.value = dateStr ? `${site}: ${dateStr}` : site;
          }
        });
      }
    }
  });

  // Clip button handler
  clipBtn.addEventListener('click', async () => {
    if (!clipperToken || !clipperServerUrl) {
      showStatus('Configuration missing. Please set up options first.', true);
      return;
    }

    const title = titleInput.value.trim();
    const url = urlInput.value.trim();
    const description = descriptionInput.value.trim();
    const mode = clipModeSelect.value;

    showStatus('Preparing clip...');
    clipBtn.disabled = true;

    const delegateClipToBackground = (screenshotDataUrl = null, excerptContent = null) => {
      const endpoint = `${clipperServerUrl}/api/clip`;
      const bodyData = {
        title: title,
        url: url,
        description: description
      };

      if (mode === 'screenshot' && screenshotDataUrl) {
        bodyData.screenshot = screenshotDataUrl;
      }
      if ((mode === 'selection' || mode === 'article') && excerptContent) {
        bodyData.excerpt = excerptContent;
      }

      chrome.runtime.sendMessage({
        action: 'sendClip',
        endpoint: endpoint,
        token: clipperToken,
        payload: bodyData
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Runtime error:', chrome.runtime.lastError.message);
          showStatus(`Extension error: ${chrome.runtime.lastError.message}`, true);
          clipBtn.disabled = false;
          return;
        }

        if (!response || !response.success) {
          showStatus(`Failed: ${response?.error || 'Unknown background error'}`, true);
          clipBtn.disabled = false;
          return;
        }

        let responseData;
        try {
          responseData = JSON.parse(response.text);
        } catch {}

        if (response.ok) {
          showStatus('Successfully clipped to Web Clips!');
          descriptionInput.value = '';
          setTimeout(hideStatus, 3000);
        } else {
          const errorMsg = responseData?.message || response.text || `Status ${response.status}`;
          showStatus(`Failed: ${errorMsg}`, true);
        }
        clipBtn.disabled = false;
      });
    };

    if (mode === 'screenshot-area' || mode === 'screenshot-full') {
      if (activeTabId === null || isRestrictedUrl(activeTabUrl)) {
        showStatus('Cannot capture screenshots on system/restricted pages.', true);
        clipBtn.disabled = false;
        return;
      }
      // The background worker owns these captures end-to-end: area selection
      // needs the popup gone so the user can drag on the page, and full-page
      // scrolling outlives the popup. Results arrive as an on-page toast.
      chrome.runtime.sendMessage({
        action: mode === 'screenshot-area' ? 'captureArea' : 'captureFull',
        tabId: activeTabId,
        windowId: activeTabWindowId,
        job: {
          endpoint: `${clipperServerUrl}/api/clip`,
          token: clipperToken,
          clip: { title: title, url: url, description: description }
        }
      });
      window.close();
      return;
    }

    if (mode === 'screenshot') {
      showStatus('Capturing screenshot...');
      if (activeTabWindowId !== null && !isRestrictedUrl(activeTabUrl)) {
        chrome.tabs.captureVisibleTab(activeTabWindowId, { format: 'jpeg', quality: 50 }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            console.warn('Screenshot capture failed:', chrome.runtime.lastError.message);
            showStatus(`Screenshot capture failed: ${chrome.runtime.lastError.message}. Sending without screenshot...`, true);
            setTimeout(() => delegateClipToBackground(null), 2000);
          } else {
            delegateClipToBackground(dataUrl);
          }
        });
      } else {
        showStatus('Cannot capture screenshot on system/restricted pages.', true);
        clipBtn.disabled = false;
      }
    } else if (mode === 'selection') {
      delegateClipToBackground(null, description);
    } else if (mode === 'article') {
      if (activeTabId !== null && !isRestrictedUrl(activeTabUrl)) {
        showStatus('Extracting page text...');
        // Inject Mozilla Readability (the Firefox Reader View engine) first;
        // the extractor below uses it and falls back to a heuristic strip.
        chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          files: ['Readability.js']
        }, () => {
        if (chrome.runtime.lastError) {
          console.warn('Readability injection failed:', chrome.runtime.lastError.message);
        }
        chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          func: () => {
            // Preferred path: Mozilla Readability scores content blocks by
            // text/link density, so link-farms ("recommended", promoted,
            // footers) drop out no matter what their classes are named.
            try {
              if (typeof Readability === 'function') {
                const parsed = new Readability(document.cloneNode(true)).parse();
                if (parsed && parsed.textContent && parsed.textContent.trim().length > 250) {
                  // parsed.textContent squashes paragraph breaks; rebuild them
                  // from the article HTML via an inert DOMParser document.
                  const dom = new DOMParser().parseFromString(parsed.content, 'text/html');
                  const SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,pre';
                  const blocks = [...dom.body.querySelectorAll(SEL)]
                    .filter(el => !el.querySelector(SEL))
                    .map(el => el.textContent.replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
                  const text = blocks.join('\n\n');
                  const body = text.length > 250 ? text : parsed.textContent.trim();
                  const header = [parsed.title, parsed.byline].filter(Boolean).join('\n');
                  return (header ? header + '\n\n' : '') + body;
                }
              }
            } catch (e) {
              console.warn('Readability parse failed, falling back:', e);
            }

            // Fallback: find the main article container, clone it, drop junk
            // (nav/ads/footers), and return its text. Falls back to the whole
            // body if nothing article-like is found.
            const JUNK_SELECTOR = [
              'script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button',
              'nav', 'aside', 'footer', 'header',
              '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
              '[role="contentinfo"]', '[aria-hidden="true"]', '[hidden]',
              '[class*="cookie"]', '[id*="cookie"]', '[class*="consent"]',
              '[class*="newsletter"]', '[class*="subscribe"]', '[class*="paywall"]',
              '[class*="related"]', '[class*="recommend"]', '[class*="share"]',
              '[class*="social"]', '[class*="comment"]', '[id*="comment"]',
              '[class*="sidebar"]', '[id*="sidebar"]', '[class*="popup"]',
              '[class*="banner"]', '[id*="banner"]', '[class*="promo"]',
              '[class*="sponsor"]', '[class*="advert"]', '[id*="advert"]',
              '[class*="-ad-"]', '[class^="ad-"]', '[class$="-ad"]',
              '[class~="ad"]', '[class~="ads"]', '[id^="ad-"]', '[id~="ad"]',
              'ins.adsbygoogle', '[data-ad-slot]', '[data-testid*="ad"]'
            ].join(',');

            // Candidate containers, most specific first.
            const candidates = [
              document.querySelector('article'),
              document.querySelector('[role="main"]'),
              document.querySelector('main'),
              document.querySelector('#content, .post-content, .article-body, .entry-content, .story-body')
            ].filter(Boolean);

            // Pick the first candidate with a meaningful amount of text;
            // an <article> that's just a teaser card is skipped.
            let root = null;
            for (const el of candidates) {
              if (el.innerText && el.innerText.trim().length > 250) { root = el; break; }
            }
            if (!root) root = document.body;

            const clone = root.cloneNode(true);
            clone.querySelectorAll(JUNK_SELECTOR).forEach(el => el.remove());

            // Cloned nodes are detached, so innerText won't reflect layout —
            // walk block elements instead to keep paragraph breaks.
            const holder = document.createElement('div');
            holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:800px;';
            holder.appendChild(clone);
            document.body.appendChild(holder);
            const text = clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
            holder.remove();

            // If stripping was too aggressive, fall back to the raw body text.
            return text.length > 100 ? text : document.body.innerText;
          }
        }, (results) => {
          if (chrome.runtime.lastError) {
            console.warn('Scripting failed (expected on some pages):', chrome.runtime.lastError.message);
            delegateClipToBackground(null, '');
          } else {
            const pageText = results && results[0] && results[0].result ? results[0].result : '';
            delegateClipToBackground(null, pageText);
          }
        });
        });
      } else {
        delegateClipToBackground(null, '');
      }
    } else {
      delegateClipToBackground(null);
    }
  });
});
