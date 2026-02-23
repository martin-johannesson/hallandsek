// ===== Publik galleri-sida =====

(function () {
  'use strict';

  const DATA_URL = 'data/projects.json';
  let projects = [];

  // --- Init ---
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const resp = await fetch(DATA_URL);
      if (!resp.ok) throw new Error('Kunde inte ladda projektdata');
      const data = await resp.json();
      projects = data.projects || [];
    } catch (err) {
      console.error(err);
      projects = [];
    }
    renderGallery();
    setupOverlay();
    setupLightbox();
  });

  // --- Gallery ---
  function renderGallery() {
    const gallery = document.getElementById('gallery');
    if (!gallery) return;

    if (projects.length === 0) {
      gallery.innerHTML = '<div class="empty-state"><p>Inga projekt att visa.</p></div>';
      return;
    }

    gallery.innerHTML = projects.map(p => {
      const total = (p.purchases || []).reduce((s, i) => s + (i.cost || 0), 0);
      const coverSrc = p.cover || (p.images && p.images[0]) || '';
      const imgTag = coverSrc
        ? `<img class="card-image" src="${esc(coverSrc)}" alt="${esc(p.name)}" loading="lazy">`
        : `<div class="card-image" style="display:flex;align-items:center;justify-content:center;color:#999;">Ingen bild</div>`;

      return `
        <article class="project-card" data-id="${esc(p.id)}">
          ${imgTag}
          <div class="card-body">
            <h2>${esc(p.name)}</h2>
            <span class="card-date">${esc(p.date || '')}</span>
            ${total > 0 ? `<div class="card-cost">${formatSEK(total)}</div>` : ''}
          </div>
        </article>`;
    }).join('');

    gallery.querySelectorAll('.project-card').forEach(card => {
      card.addEventListener('click', () => {
        const proj = projects.find(p => p.id === card.dataset.id);
        if (proj) showDetail(proj);
      });
    });
  }

  // --- Detail overlay ---
  function setupOverlay() {
    const overlay = document.getElementById('overlay');
    if (!overlay) return;
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeDetail();
    });
  }

  function showDetail(proj) {
    const overlay = document.getElementById('overlay');
    const detail = document.getElementById('detail-content');
    if (!overlay || !detail) return;

    const total = (proj.purchases || []).reduce((s, i) => s + (i.cost || 0), 0);

    let imagesHtml = '';
    if (proj.images && proj.images.length > 0) {
      imagesHtml = `<div class="detail-images">
        ${proj.images.map(src => `<img src="${esc(src)}" alt="${esc(proj.name)}" data-lightbox>`).join('')}
      </div>`;
    }

    let purchasesHtml = '';
    if (proj.purchases && proj.purchases.length > 0) {
      purchasesHtml = `
        <div class="purchases">
          <h3>Inköpslista</h3>
          <table>
            <thead><tr><th>Datum</th><th>Beskrivning</th><th class="cost-cell">Kostnad</th></tr></thead>
            <tbody>
              ${proj.purchases.map(p => `
                <tr>
                  <td>${esc(p.date || '')}</td>
                  <td>${esc(p.description || '')}</td>
                  <td class="cost-cell">${formatSEK(p.cost || 0)}</td>
                </tr>`).join('')}
              <tr class="total-row">
                <td colspan="2">Totalt</td>
                <td class="cost-cell">${formatSEK(total)}</td>
              </tr>
            </tbody>
          </table>
        </div>`;
    }

    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(proj.name)}</h2>
        <button class="detail-close" id="detail-close">&times;</button>
      </div>
      <div class="detail-body">
        <div class="detail-date">${esc(proj.date || '')}</div>
        ${proj.description ? `<div class="detail-desc">${esc(proj.description)}</div>` : ''}
        ${imagesHtml}
        ${purchasesHtml}
      </div>`;

    document.getElementById('detail-close').addEventListener('click', closeDetail);
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeDetail() {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // --- Lightbox ---
  function setupLightbox() {
    const lb = document.getElementById('lightbox');
    if (!lb) return;

    document.addEventListener('click', e => {
      if (e.target.matches('[data-lightbox]')) {
        lb.querySelector('img').src = e.target.src;
        lb.classList.remove('hidden');
      }
    });

    lb.addEventListener('click', () => lb.classList.add('hidden'));

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        lb.classList.add('hidden');
        closeDetail();
      }
    });
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
})();
