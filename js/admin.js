// ===== Admin-panel =====

(function () {
  'use strict';

  // SHA-256 hash av lösenordet: "snickeri2026"
  const PASSWORD_HASH = 'c0ab1d2444c03e707670286f837e04561a559f53b4304d36e7abb699df911e90';

  const REPO_OWNER = 'martin-johannesson';
  const REPO_NAME = 'hallandsek';
  const DATA_PATH = 'data/projects.json';
  const IMAGES_DIR = 'images/';
  const LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const GH_API = LOCAL ? '/ghproxy/' : 'https://api.github.com/';
  const API_BASE = GH_API + 'repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/';

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

    if (location.protocol === 'file:') {
      showStatus('Adminsidan kan inte köras från filsystemet. Öppna via hallandsek.se/admin/ eller kör python3 admin_server.py', 'error');
    }

    await loadProjects();
    renderProjectList();
  }

  // --- GitHub API helpers ---
  async function ghFetch(path, options) {
    const resp = await fetch(API_BASE + path, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        ...(options && options.headers)
      }
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || 'GitHub API ' + resp.status);
    }
    return resp.json();
  }

  async function ghPut(path, content, sha, message) {
    const body = { message, content };
    if (sha) body.sha = sha;
    return ghFetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  // --- Load / Save ---
  async function loadProjects() {
    try {
      // Ladda från statisk fil (fungerar alltid, ingen CORS)
      const resp = await fetch('../data/projects.json?_=' + Date.now());
      if (!resp.ok) throw new Error(resp.status);
      const text = await resp.text();
      const data = JSON.parse(text);
      projects = data.projects || [];
    } catch (e) {
      console.error('loadProjects:', e);
      showStatus('Kunde inte ladda produkter: ' + e.message, 'error');
    }
  }

  async function getFileSha() {
    const data = await ghFetch(DATA_PATH);
    return data.sha;
  }

  async function saveProjects(message) {
    const jsonStr = JSON.stringify({ projects }, null, 2) + '\n';
    const bytes = new TextEncoder().encode(jsonStr);

    // base64-koda i block (undviker stack overflow vid spread)
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const content = btoa(binary);

    // Hämta aktuell SHA från GitHub API precis innan sparning
    const sha = await getFileSha();
    const result = await ghPut(DATA_PATH, content, sha, message || 'Uppdatera projects.json');
    return result;
  }

  async function uploadImage(filename, base64data) {
    // Nya bilder har ingen SHA (ny fil)
    return ghPut(IMAGES_DIR + filename, base64data, null, 'Lägg till bild: ' + filename);
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

      await saveProjects('Uppdatera: ' + name);
      pendingImages = [];
      showStatus('Sparat!', 'success');
      await loadProjects();
      renderProjectList();
      closeEditor();
    } catch (err) {
      console.error('saveProject:', err);
      if (err instanceof TypeError) {
        if (LOCAL) {
          showStatus('Kunde inte nå GitHub. Kör: python3 admin_server.py och öppna localhost:8000/admin/', 'error');
        } else {
          showStatus('Kunde inte nå GitHub API. Kontrollera nätverksanslutningen eller prova en annan webbläsare.', 'error');
        }
      } else {
        showStatus('Fel vid sparning: ' + err.message, 'error');
      }
    }
  }

  // --- Delete project ---
  async function deleteProject(id) {
    const proj = projects.find(p => p.id === id);
    if (!proj) return;
    if (!confirm('Ta bort "' + proj.name + '"?')) return;

    projects = projects.filter(p => p.id !== id);
    try {
      await saveProjects('Ta bort: ' + proj.name);
      showStatus('"' + proj.name + '" borttaget', 'success');
      renderProjectList();
    } catch (err) {
      console.error('deleteProject:', err);
      if (err instanceof TypeError) {
        if (LOCAL) {
          showStatus('Kunde inte nå GitHub. Kör: python3 admin_server.py och öppna localhost:8000/admin/', 'error');
        } else {
          showStatus('Kunde inte nå GitHub API. Kontrollera nätverksanslutningen eller prova en annan webbläsare.', 'error');
        }
      } else {
        showStatus('Fel: ' + err.message, 'error');
      }
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
