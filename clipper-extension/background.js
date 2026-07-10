const CAPTURE_INTERVAL_MS = 600; // captureVisibleTab quota: max 2 calls/sec
const MAX_FULLPAGE_SEGMENTS = 12;
const MAX_DATAURL_LENGTH = 3_900_000; // stay under the server's 4 MB screenshot cap

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sendClip') {
    const { endpoint, token, payload } = message;
    postClip(endpoint, token, payload)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }

  if (message.action === 'captureArea') {
    const { tabId, windowId, job } = message;
    chrome.storage.session.set({ ['clipJob:' + tabId]: { ...job, windowId } }, () => {
      chrome.scripting.executeScript({ target: { tabId }, func: startAreaSelection }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      });
    });
    return true;
  }

  if (message.action === 'areaSelected') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    finishAreaCapture(tabId, message.rect, message.dpr);
    return;
  }

  if (message.action === 'areaCancelled') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) chrome.storage.session.remove('clipJob:' + tabId);
    return;
  }

  if (message.action === 'captureFull') {
    const { tabId, windowId, job } = message;
    captureFullPage(tabId, windowId, job)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        showToast(tabId, 'Full page clip failed: ' + error.message, false);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

async function postClip(endpoint, token, payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

// ---------- Select-area capture ----------

async function finishAreaCapture(tabId, rect, dpr) {
  const key = 'clipJob:' + tabId;
  const stored = await chrome.storage.session.get(key);
  const job = stored[key];
  await chrome.storage.session.remove(key);
  if (!job) return;

  try {
    // The overlay removes itself just before this message; give the page a
    // frame to repaint so the selection box isn't in the shot.
    await sleep(120);
    const dataUrl = await captureTab(job.windowId);
    const bitmap = await dataUrlToBitmap(dataUrl);

    // rect is in CSS pixels; the capture is in device pixels. Deriving the
    // scale from the actual bitmap width also covers page zoom, where
    // devicePixelRatio alone would be wrong.
    const scale = bitmap.width / rect.viewportWidth;
    void dpr;
    const sx = Math.max(0, Math.round(rect.x * scale));
    const sy = Math.max(0, Math.round(rect.y * scale));
    const sw = Math.min(bitmap.width - sx, Math.round(rect.w * scale));
    const sh = Math.min(bitmap.height - sy, Math.round(rect.h * scale));
    if (sw < 4 || sh < 4) throw new Error('Selection too small');

    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const screenshot = await encodeUnderCap(canvas);

    const result = await postClip(job.endpoint, job.token, { ...job.clip, screenshot });
    showToast(tabId, result.ok ? 'Clipped to Web Clips!' : 'Clip failed: ' + clipError(result), result.ok);
  } catch (error) {
    showToast(tabId, 'Area clip failed: ' + error.message, false);
  }
}

/** Injected into the page: drag a rectangle, Esc to cancel. */
function startAreaSelection() {
  if (window.__wikiClipperSelecting) return;
  window.__wikiClipperSelecting = true;

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.08);';
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;border:2px dashed #c66930;background:rgba(198,105,48,0.12);display:none;z-index:2147483647;pointer-events:none;';
  const hint = document.createElement('div');
  hint.textContent = 'Drag to select an area — Esc to cancel';
  hint.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#00361f;color:#fff;' +
    'padding:6px 14px;border-radius:6px;font:13px -apple-system,sans-serif;z-index:2147483647;pointer-events:none;';
  document.documentElement.append(overlay, box, hint);

  let startX = 0, startY = 0, dragging = false;

  function cleanup() {
    overlay.remove();
    box.remove();
    hint.remove();
    document.removeEventListener('keydown', onKey, true);
    window.__wikiClipperSelecting = false;
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cleanup();
      chrome.runtime.sendMessage({ action: 'areaCancelled' });
    }
  }
  document.addEventListener('keydown', onKey, true);

  overlay.addEventListener('mousedown', (event) => {
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    box.style.display = 'block';
    event.preventDefault();
  });

  overlay.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const x = Math.min(startX, event.clientX);
    const y = Math.min(startY, event.clientY);
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    box.style.width = Math.abs(event.clientX - startX) + 'px';
    box.style.height = Math.abs(event.clientY - startY) + 'px';
  });

  overlay.addEventListener('mouseup', (event) => {
    if (!dragging) return;
    const rect = {
      x: Math.min(startX, event.clientX),
      y: Math.min(startY, event.clientY),
      w: Math.abs(event.clientX - startX),
      h: Math.abs(event.clientY - startY),
      viewportWidth: window.innerWidth
    };
    const dpr = window.devicePixelRatio || 1;
    cleanup();
    if (rect.w < 5 || rect.h < 5) {
      chrome.runtime.sendMessage({ action: 'areaCancelled' });
      return;
    }
    // Let the overlay disappear from the paint before the capture fires.
    requestAnimationFrame(() =>
      setTimeout(() => chrome.runtime.sendMessage({ action: 'areaSelected', rect, dpr }), 60)
    );
  });
}

// ---------- Full-page capture ----------

async function captureFullPage(tabId, windowId, job) {
  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      ),
      viewport: window.innerHeight,
      width: window.innerWidth,
      dpr: window.devicePixelRatio || 1,
      originalY: window.scrollY
    })
  });

  const segments = Math.min(
    Math.ceil(metrics.scrollHeight / metrics.viewport),
    MAX_FULLPAGE_SEGMENTS
  );
  const totalHeight = Math.min(metrics.scrollHeight, segments * metrics.viewport);

  // Stitch in CSS pixels: device-pixel canvases for tall pages blow past
  // both memory and the 4 MB upload budget for no visible gain in a note.
  const canvas = new OffscreenCanvas(metrics.width, totalHeight);
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < segments; i++) {
    const targetY = Math.min(i * metrics.viewport, metrics.scrollHeight - metrics.viewport);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (y) => window.scrollTo(0, y),
      args: [Math.max(0, targetY)]
    });
    await sleep(CAPTURE_INTERVAL_MS); // paint + lazy content + capture quota
    const dataUrl = await captureTab(windowId);
    const bitmap = await dataUrlToBitmap(dataUrl);
    ctx.drawImage(bitmap, 0, Math.max(0, targetY), metrics.width, metrics.viewport);
  }

  // Restore where the user was.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (y) => window.scrollTo(0, y),
    args: [metrics.originalY]
  });

  const screenshot = await encodeUnderCap(canvas);
  const truncated = metrics.scrollHeight > totalHeight;
  const result = await postClip(job.endpoint, job.token, { ...job.clip, screenshot });
  showToast(
    tabId,
    result.ok
      ? 'Full page clipped!' + (truncated ? ' (first ' + segments + ' screens)' : '')
      : 'Clip failed: ' + clipError(result),
    result.ok
  );
}

// ---------- Shared helpers ----------

function captureTab(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 75 }, (dataUrl) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(dataUrl);
    });
  });
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

/** Encode as JPEG, stepping down quality (then scale) to fit the upload cap. */
async function encodeUnderCap(canvas) {
  for (const quality of [0.7, 0.5, 0.35]) {
    const dataUrl = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
    if (dataUrl.length <= MAX_DATAURL_LENGTH) return dataUrl;
  }
  const scaled = new OffscreenCanvas(Math.round(canvas.width * 0.6), Math.round(canvas.height * 0.6));
  scaled.getContext('2d').drawImage(canvas, 0, 0, scaled.width, scaled.height);
  const dataUrl = await blobToDataUrl(await scaled.convertToBlob({ type: 'image/jpeg', quality: 0.5 }));
  if (dataUrl.length > MAX_DATAURL_LENGTH) throw new Error('Capture too large even after compression');
  return dataUrl;
}

/** Service workers have no FileReader; base64-encode from the array buffer. */
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return 'data:' + blob.type + ';base64,' + btoa(binary);
}

function clipError(result) {
  try {
    return JSON.parse(result.text).message || 'status ' + result.status;
  } catch {
    return 'status ' + result.status;
  }
}

function showToast(tabId, text, ok) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: (msg, good) => {
      const toast = document.createElement('div');
      toast.textContent = msg;
      toast.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'padding:10px 18px;border-radius:8px;font:13px -apple-system,sans-serif;color:#fff;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.25);transition:opacity 0.4s;background:' +
        (good ? '#00361f' : '#b3261e') + ';';
      document.documentElement.appendChild(toast);
      setTimeout(() => (toast.style.opacity = '0'), 3200);
      setTimeout(() => toast.remove(), 3700);
    },
    args: [text, ok]
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
