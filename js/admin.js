// ===== Admin-panel =====

(function () {
  'use strict';

  // SHA-256 hash av lösenordet (ändra detta till din egen hash)
  // Standard: "snickeri2026" → generera ny med: echo -n "dittlösenord" | sha256sum
  const PASSWORD_HASH = 'c0ab1d2444c03e707670286f837e04561a559f53b4304d36e7abb699df911e90'; // "snickeri2026"

  const REPO_OWNER = 'martin-johannesson';
  const REPO_NAME = 'hallandsek';
  const DATA_PATH = 'data/projects.json';
  const IMAGES_DIR = 'images/';

  let token = '';
  let projects = [];
  let currentProjectId = null;
  let pendingImages = []; // {file, dataUrl, filename}

  // --- Init ---
  document.addEventListener('DOMContentLoaded', () => {
    setupLogin();
  });

  // --- Auth ---
  async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function setupLogin() {
    const loginForm = document.getElementById('login-form');
    const passwordInput = document.getElementById('password-input');
    const tokenInput = document.getElementById('token-input');
    const errorEl = document.getElementById('login-error');

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const hash = await sha256(passwordInput.value);
      if (hash !== PASSWORD_HASH) {
        errorEl.textContent = 'Fel lösenord';
        return;
      }
      token = tokenInput.value.trim();
      if (!token) {
        errorEl.textContent = 'GitHub-token krävs';
        return;
      }
      localStorage.setItem('snickeri_token', token);
      errorEl.textContent = '';
      showAdmin();
    });

    // Auto-fill token from localStorage
    const saved = localStorage.getItem('snickeri_token');
    if (saved) tokenInput.value = saved;
  }

  async function showAdmin() {
    document.getElementById('login-section').style.display = 'none';
    document.querySelector('.admin-panel').classList.add('active');
    await loadProjects();
    renderProjectList();
  }

  // --- GitHub API ---
  async function ghApi(path, opts = {}) {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      ...opts.headers
    };
    const resp = await fetch(url, { ...opts, headers });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `GitHub API ${resp.status}`);
    }
    return resp.json();
  }

  async function loadProjects() {
    try {
      const file = await ghApi(DATA_PATH);
      const content = atob(file.content.replace(/\n/g, ''));
      const data = JSON.parse(content);
      projects = data.projects || [];
      window._fileSha = file.sha;
    } catch (err) {
      if (err.message.includes('404')) {
        projects = [];
        window._fileSha = null;
      } else {
        showStatus('Kunde inte ladda projekt: ' + err.message, 'error');
      }
    }
  }

  async function saveProjects(message) {
    const content = btoa(unescape(encodeURIComponent(JSON.stringify({ projects }, null, 2) + '\n')));
    const body = {
      message: message || 'Uppdatera projects.json',
      content: content
    };
    if (window._fileSha) body.sha = window._fileSha;

    const resp = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_PATH}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `Sparfel ${resp.status}`);
    }

    const result = await resp.json();
    window._fileSha = result.content.sha;
    return result;
  }

  async function uploadImage(filename, base64data) {
    // Check if file already exists to get sha
    let sha = null;
    try {
      const existing = await ghApi(IMAGES_DIR + filename);
      sha = existing.sha;
    } catch (e) { /* file doesn't exist */ }

    const body = {
      message: `Lägg till bild: ${filename}`,
      content: base64data
    };
    if (sha) body.sha = sha;

    const resp = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${IMAGES_DIR}${filename}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `Bilduppladdningsfel ${resp.status}`);
    }
    return resp.json();
  }

  async function deleteFile(path, sha, message) {
    const resp = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message, sha })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `Raderingsfel ${resp.status}`);
    }
  }

  // --- Render project list ---
  function renderProjectList() {
    const list = document.getElementById('project-list');
    if (projects.length === 0) {
      list.innerHTML = '<p style="color:#666;">Inga projekt. Skapa ett nytt!</p>';
      return;
    }

    list.innerHTML = projects.map(p => {
      const total = (p.purchases || []).reduce((s, i) => s + (i.cost || 0), 0);
      return `
        <div class="admin-project-card">
          <h3>${esc(p.name)}</h3>
          <div class="meta">${esc(p.date || '')} &mdash; ${(p.images || []).length} bilder &mdash; ${formatSEK(total)}</div>
          <div class="actions">
            <button class="btn btn-primary btn-sm" onclick="window._editProject('${p.id}')">Redigera</button>
            <button class="btn btn-danger btn-sm" onclick="window._deleteProject('${p.id}')">Ta bort</button>
          </div>
        </div>`;
    }).join('');
  }

  // --- Editor ---
  function openEditor(proj) {
    currentProjectId = proj ? proj.id : null;
    pendingImages = [];
    const editor = document.getElementById('editor');
    editor.style.display = 'block';
    document.getElementById('project-list-section').style.display = 'none';

    document.getElementById('editor-title').textContent = proj ? 'Redigera projekt' : 'Nytt projekt';
    document.getElementById('proj-name').value = proj ? proj.name : '';
    document.getElementById('proj-desc').value = proj ? (proj.description || '') : '';
    document.getElementById('proj-date').value = proj ? (proj.date || '') : new Date().toISOString().slice(0, 7);

    renderEditorImages(proj);
    renderEditorPurchases(proj);
  }

  function closeEditor() {
    document.getElementById('editor').style.display = 'none';
    document.getElementById('project-list-section').style.display = 'block';
    currentProjectId = null;
    pendingImages = [];
  }

  function renderEditorImages(proj) {
    const container = document.getElementById('image-thumbs');
    const existing = proj ? (proj.images || []) : [];
    const cover = proj ? (proj.cover || '') : '';

    let html = existing.map((src, i) => `
      <div class="image-thumb ${src === cover ? 'is-cover' : ''}" data-src="${esc(src)}">
        <img src="${esc(src)}">
        <button class="remove-img" data-idx="${i}" title="Ta bort">&times;</button>
        <button class="set-cover" data-idx="${i}" title="Sätt som omslag">Omslag</button>
      </div>`).join('');

    container.innerHTML = html;

    container.querySelectorAll('.remove-img').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const p = getEditingProject();
        if (p && p.images) {
          const removed = p.images.splice(idx, 1)[0];
          if (p.cover === removed) p.cover = p.images[0] || '';
          renderEditorImages(p);
        }
      });
    });

    container.querySelectorAll('.set-cover').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const p = getEditingProject();
        if (p && p.images && p.images[idx]) {
          p.cover = p.images[idx];
          renderEditorImages(p);
        }
      });
    });
  }

  function renderEditorPurchases(proj) {
    const container = document.getElementById('purchase-rows');
    const purchases = proj ? (proj.purchases || []) : [];

    container.innerHTML = purchases.map((p, i) => `
      <div class="purchase-row">
        <input type="date" value="${esc(p.date || '')}" data-idx="${i}" data-field="date">
        <input type="text" value="${esc(p.description || '')}" placeholder="Beskrivning" data-idx="${i}" data-field="description">
        <input type="number" value="${p.cost || 0}" step="1" data-idx="${i}" data-field="cost">
        <button class="remove-purchase" data-idx="${i}">&times;</button>
      </div>`).join('');

    updatePurchaseTotal(purchases);

    container.querySelectorAll('.remove-purchase').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = getEditingProject();
        if (p) {
          p.purchases.splice(parseInt(btn.dataset.idx), 1);
          renderEditorPurchases(p);
        }
      });
    });
  }

  function collectPurchasesFromForm() {
    const rows = document.querySelectorAll('#purchase-rows .purchase-row');
    return Array.from(rows).map(row => ({
      date: row.querySelector('[data-field="date"]').value,
      description: row.querySelector('[data-field="description"]').value,
      cost: parseFloat(row.querySelector('[data-field="cost"]').value) || 0
    }));
  }

  function updatePurchaseTotal(purchases) {
    const total = purchases.reduce((s, p) => s + (p.cost || 0), 0);
    document.getElementById('purchase-total').textContent = 'Totalt: ' + formatSEK(total);
  }

  function getEditingProject() {
    if (!currentProjectId) return null;
    return projects.find(p => p.id === currentProjectId);
  }

  // --- Image upload ---
  function setupImageUpload() {
    const area = document.getElementById('image-upload-area');
    const fileInput = document.getElementById('image-file-input');

    area.addEventListener('click', () => fileInput.click());

    area.addEventListener('dragover', (e) => {
      e.preventDefault();
      area.classList.add('dragover');
    });

    area.addEventListener('dragleave', () => area.classList.remove('dragover'));

    area.addEventListener('drop', (e) => {
      e.preventDefault();
      area.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', () => {
      handleFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  function handleFiles(files) {
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const ext = file.name.split('.').pop().toLowerCase();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
        const filename = Date.now() + '_' + safeName;
        pendingImages.push({ file, dataUrl, filename, base64: dataUrl.split(',')[1] });
        renderPendingImages();
      };
      reader.readAsDataURL(file);
    });
  }

  function renderPendingImages() {
    const container = document.getElementById('pending-thumbs');
    container.innerHTML = pendingImages.map((img, i) => `
      <div class="image-thumb">
        <img src="${img.dataUrl}">
        <button class="remove-img" data-pending="${i}">&times;</button>
      </div>`).join('');

    container.querySelectorAll('.remove-img').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingImages.splice(parseInt(btn.dataset.pending), 1);
        renderPendingImages();
      });
    });
  }

  // --- Save project ---
  async function saveProject() {
    const name = document.getElementById('proj-name').value.trim();
    if (!name) {
      showStatus('Namn krävs', 'error');
      return;
    }

    const desc = document.getElementById('proj-desc').value.trim();
    const date = document.getElementById('proj-date').value;
    const purchases = collectPurchasesFromForm();

    showStatus('Sparar...', 'info');

    try {
      // Upload pending images
      const uploadedPaths = [];
      for (const img of pendingImages) {
        await uploadImage(img.filename, img.base64);
        uploadedPaths.push(IMAGES_DIR + img.filename);
      }

      if (currentProjectId) {
        // Update existing
        const proj = projects.find(p => p.id === currentProjectId);
        if (proj) {
          proj.name = name;
          proj.description = desc;
          proj.date = date;
          proj.purchases = purchases;
          proj.images = [...(proj.images || []), ...uploadedPaths];
          if (!proj.cover && proj.images.length > 0) proj.cover = proj.images[0];
        }
      } else {
        // New project
        const id = 'proj-' + Date.now();
        const images = uploadedPaths;
        projects.push({
          id,
          name,
          description: desc,
          date,
          images,
          cover: images[0] || '',
          purchases
        });
        currentProjectId = id;
      }

      await saveProjects(`Uppdatera: ${name}`);
      pendingImages = [];
      showStatus('Sparat!', 'success');
      await loadProjects();
      renderProjectList();
      closeEditor();
    } catch (err) {
      showStatus('Fel vid sparning: ' + err.message, 'error');
    }
  }

  // --- Delete project ---
  async function deleteProject(id) {
    const proj = projects.find(p => p.id === id);
    if (!proj) return;
    if (!confirm(`Ta bort "${proj.name}"? Bilderna i repot tas inte bort automatiskt.`)) return;

    projects = projects.filter(p => p.id !== id);
    try {
      await saveProjects(`Ta bort: ${proj.name}`);
      showStatus(`"${proj.name}" borttaget`, 'success');
      renderProjectList();
    } catch (err) {
      showStatus('Fel: ' + err.message, 'error');
    }
  }

  // --- Status ---
  function showStatus(msg, type) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status-msg ' + type;
    el.style.display = 'block';
    if (type === 'success') setTimeout(() => el.style.display = 'none', 3000);
  }

  // --- Helpers ---
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  function formatSEK(n) {
    return n.toLocaleString('sv-SE') + ' kr';
  }

  function generateId() {
    return 'proj-' + Date.now();
  }

  // --- Global bindings (for onclick in rendered HTML) ---
  window._editProject = (id) => {
    const proj = projects.find(p => p.id === id);
    if (proj) openEditor(proj);
  };

  window._deleteProject = (id) => deleteProject(id);

  window._newProject = () => {
    const id = generateId();
    const proj = { id, name: '', description: '', date: new Date().toISOString().slice(0, 7), images: [], cover: '', purchases: [] };
    projects.push(proj);
    currentProjectId = id;
    openEditor(proj);
  };

  window._closeEditor = () => {
    // If it was a new unsaved project, remove it
    if (currentProjectId) {
      const proj = getEditingProject();
      if (proj && !proj.name) {
        projects = projects.filter(p => p.id !== currentProjectId);
      }
    }
    closeEditor();
  };

  window._saveProject = () => saveProject();

  window._addPurchase = () => {
    const proj = getEditingProject();
    if (!proj) return;
    if (!proj.purchases) proj.purchases = [];
    proj.purchases.push({ date: new Date().toISOString().slice(0, 10), description: '', cost: 0 });
    renderEditorPurchases(proj);
  };

  // Setup upload after DOM ready
  document.addEventListener('DOMContentLoaded', setupImageUpload);
})();
