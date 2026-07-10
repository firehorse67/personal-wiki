document.addEventListener('DOMContentLoaded', () => {
  const serverUrlInput = document.getElementById('server-url');
  const tokenInput = document.getElementById('token');
  const saveBtn = document.getElementById('save');
  const statusDiv = document.getElementById('status');

  // Load existing settings
  chrome.storage.local.get(['clipperToken', 'clipperServerUrl'], (result) => {
    if (result.clipperToken) {
      tokenInput.value = result.clipperToken;
    }
    if (result.clipperServerUrl) {
      serverUrlInput.value = result.clipperServerUrl;
    }
  });

  saveBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    let serverUrl = serverUrlInput.value.trim();

    if (serverUrl.endsWith('/')) {
      serverUrl = serverUrl.slice(0, -1);
    }

    if (!token) {
      statusDiv.textContent = 'Bearer token is required.';
      statusDiv.style.color = '#fa5252';
      return;
    }
    if (!serverUrl) {
      statusDiv.textContent = 'Server URL is required.';
      statusDiv.style.color = '#fa5252';
      return;
    }

    chrome.storage.local.set({
      clipperToken: token,
      clipperServerUrl: serverUrl
    }, () => {
      statusDiv.textContent = 'Settings saved successfully!';
      statusDiv.style.color = '#0ca678';
      setTimeout(() => {
        statusDiv.textContent = '';
      }, 3000);
    });
  });
});
