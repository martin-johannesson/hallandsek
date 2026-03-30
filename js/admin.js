// ===== Admin-panel =====

(function () {
  'use strict';

  // SHA-256 hash av lösenordet: "snickeri2026"
  const PASSWORD_HASH = 'c0ab1d2444c03e707670286f837e04561a559f53b4304d36e7abb699df911e90';

  const REPO_OWNER = 'martin-johannesson';
  const REPO_NAME = 'hallandsek';
  const DATA_PATH = 'data/projects.json';
  const IMAGES_DIR = 'images/';

  let token = '';
  let projects = [];
  let currentProjectId = null;
  let pendingImages = [];

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

    const saved = localStorage.getItem('snickeri_token');
    if (saved) {
      tokenInput.value = saved;
      token = saved;
      showAdmin();
    }
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
      const binary = atob(file.content.replace(/\n/g, ''));
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      const content = new TextDecoder().decode(bytes);
      const data = JSON.parse(content);
      projects = data.projects || [];
      window._fileSha = file.sha;
    } catch (err) {
      if (err.message.includes('404')) {
        projects = [];
        window._fileSha = null;
      } else {
        showStatus('Kunde inte ladda produkter: ' + err.message, 'error');
      }
    }
  }

  async function saveProjects(message) {
    // Hämta aktuell SHA innan sparning (undviker konflikt)
    try {
      const current = await ghApi(DATA_PATH);
      window._fileSha = current.sha;
    } catch (e) { /* ny fil */ }

    const jsonStr = JSON.stringify({ projects }, null, 2) + '\n';
    const bytes = new TextEncoder().encode(jsonStr);
    const content = btoa(String.fromCharCode(...bytes));
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

  // --- Render project list ---
  function renderProjectList() {
    const list = document.getElementById('project-list');
    if (projects.length === 0) {
      list.innerHTML = '<p style="color:#666;">Inga produkter. Skapa en ny!</p>';
      return;
    }

    list.innerHTML = projects.map((p, i) => `
      <div class="admin-project-card">
        <div class="card-top-row">
          <h3>${esc(p.name)}</h3>
          <div class="order-buttons">
            <button class="btn btn-sm btn-order" ${i === 0 ? 'disabled' : ''} onclick="window._moveProject('${p.id}', -1)" title="Flytta upp">&uarr;</button>
            <button class="btn btn-sm btn-order" ${i === projects.length - 1 ? 'disabled' : ''} onclick="window._moveProject('${p.id}', 1)" title="Flytta ner">&darr;</button>
          </div>
        </div>
        <div class="meta">${(p.images || []).length} bilder &mdash; ${p.price ? formatSEK(p.price) : 'Inget pris'}</div>
        <div class="actions">
          <button class="btn btn-primary btn-sm" onclick="window._editProject('${p.id}')">Redigera</button>
          <button class="btn btn-danger btn-sm" onclick="window._deleteProject('${p.id}')">Ta bort</button>
        </div>
      </div>`).join('');
  }

  // --- Editor ---
  function openEditor(proj) {
    currentProjectId = proj ? proj.id : null;
    pendingImages = [];
    const editor = document.getElementById('editor');
    editor.style.display = 'block';
    document.getElementById('project-list-section').style.display = 'none';

    document.getElementById('editor-title').textContent = proj ? 'Redigera produkt' : 'Ny produkt';
    document.getElementById('proj-name').value = proj ? proj.name : '';
    document.getElementById('proj-desc').value = proj ? (proj.description || '') : '';
    document.getElementById('proj-price').value = proj ? (proj.price || '') : '';

    renderEditorImages(proj);
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

    container.innerHTML = existing.map((src, i) => `
      <div class="image-thumb ${src === cover ? 'is-cover' : ''}" data-src="${esc(src)}">
        <img src="${esc(src)}">
        <button class="remove-img" data-idx="${i}" title="Ta bort">&times;</button>
        <button class="set-cover" data-idx="${i}" title="Sätt som omslag">Omslag</button>
      </div>`).join('');

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

  function getEditingProject() {
    if (!currentProjectId) return null;
    return projects.find(p => p.id === currentProjectId);
  }

  // --- Image upload ---
  function setupImageUpload() {
    const area = document.getElementById('image-upload-area');
    const fileInput = document.getElementById('image-file-input');

    area.addEventListener('click', () => fileInput.click());
    area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('dragover'); });
    area.addEventListener('dragleave', () => area.classList.remove('dragover'));
    area.addEventListener('drop', (e) => { e.preventDefault(); area.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
    fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });
  }

  function handleFiles(files) {
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
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
    if (!name) { showStatus('Namn krävs', 'error'); return; }

    const desc = document.getElementById('proj-desc').value.trim();
    const price = parseFloat(document.getElementById('proj-price').value) || 0;

    showStatus('Sparar...', 'info');

    try {
      const uploadedPaths = [];
      for (const img of pendingImages) {
        await uploadImage(img.filename, img.base64);
        uploadedPaths.push(IMAGES_DIR + img.filename);
      }

      if (currentProjectId) {
        const proj = projects.find(p => p.id === currentProjectId);
        if (proj) {
          proj.name = name;
          proj.description = desc;
          proj.price = price;
          proj.images = [...(proj.images || []), ...uploadedPaths];
          if (!proj.cover && proj.images.length > 0) proj.cover = proj.images[0];
        }
      } else {
        const id = 'proj-' + Date.now();
        const images = uploadedPaths;
        projects.push({
          id, name, description: desc, price,
          images, cover: images[0] || ''
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
    if (!confirm(`Ta bort "${proj.name}"?`)) return;

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

  // --- Global bindings ---
  window._editProject = (id) => {
    const proj = projects.find(p => p.id === id);
    if (proj) openEditor(proj);
  };

  window._deleteProject = (id) => deleteProject(id);

  window._moveProject = async (id, direction) => {
    const idx = projects.findIndex(p => p.id === id);
    if (idx < 0) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= projects.length) return;
    [projects[idx], projects[newIdx]] = [projects[newIdx], projects[idx]];
    renderProjectList();
    try {
      await saveProjects('Ändra ordning');
      showStatus('Ordning sparad!', 'success');
    } catch (err) {
      showStatus('Fel vid sparning: ' + err.message, 'error');
    }
  };

  window._newProject = () => {
    const id = 'proj-' + Date.now();
    const proj = { id, name: '', description: '', price: 0, images: [], cover: '' };
    projects.push(proj);
    currentProjectId = id;
    openEditor(proj);
  };

  window._closeEditor = () => {
    if (currentProjectId) {
      const proj = getEditingProject();
      if (proj && !proj.name) {
        projects = projects.filter(p => p.id !== currentProjectId);
      }
    }
    closeEditor();
  };

  window._saveProject = () => saveProject();

  document.addEventListener('DOMContentLoaded', setupImageUpload);
})();
