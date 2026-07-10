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
        // Try to read user text selection from the page
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => window.getSelection().toString().trim()
        }, (results) => {
          if (chrome.runtime.lastError) {
            console.warn('Scripting failed (expected on some pages):', chrome.runtime.lastError.message);
            return;
          }
          if (results && results[0] && results[0].result) {
            const selectedText = results[0].result;
            descriptionInput.value = selectedText;
            // Default to selection mode if there is selected text
            clipModeSelect.value = 'selection';
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
        chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          func: () => document.body.innerText
        }, (results) => {
          if (chrome.runtime.lastError) {
            console.warn('Scripting failed (expected on some pages):', chrome.runtime.lastError.message);
            delegateClipToBackground(null, '');
          } else {
            const pageText = results && results[0] && results[0].result ? results[0].result : '';
            delegateClipToBackground(null, pageText);
          }
        });
      } else {
        delegateClipToBackground(null, '');
      }
    } else {
      delegateClipToBackground(null);
    }
  });
});
