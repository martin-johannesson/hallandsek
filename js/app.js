// ===== Publik sida med varukorg =====

(function () {
  'use strict';

  const DATA_URL = 'data/projects.json';
  const ORDER_EMAIL = 'martin.johannesson92@gmail.com';
  let projects = [];
  let cart = []; // {id, name, price, qty}

  // --- Init ---
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const resp = await fetch(DATA_URL);
      if (!resp.ok) throw new Error('Kunde inte ladda produktdata');
      const data = await resp.json();
      projects = data.projects || [];
    } catch (err) {
      console.error(err);
      projects = [];
    }
    loadCart();
    renderGallery();
    setupOverlay();
    setupLightbox();
    updateCartUI();
  });

  // --- Cart persistence ---
  function loadCart() {
    try {
      cart = JSON.parse(localStorage.getItem('hallandsek_cart') || '[]');
    } catch (e) { cart = []; }
  }

  function saveCart() {
    localStorage.setItem('hallandsek_cart', JSON.stringify(cart));
  }

  // --- Gallery ---
  function renderGallery() {
    const gallery = document.getElementById('gallery');
    if (!gallery) return;

    if (projects.length === 0) {
      gallery.innerHTML = '<div class="empty-state"><p>Inga produkter att visa.</p></div>';
      return;
    }

    gallery.innerHTML = projects.map(p => {
      const coverSrc = p.cover || (p.images && p.images[0]) || '';
      const imgTag = coverSrc
        ? `<img class="card-image" src="${esc(coverSrc)}" alt="${esc(p.name)}" loading="lazy">`
        : `<div class="card-image" style="display:flex;align-items:center;justify-content:center;color:#999;">Ingen bild</div>`;

      return `
        <article class="project-card" data-id="${esc(p.id)}">
          ${imgTag}
          <div class="card-body">
            <h2>${esc(p.name)}</h2>
            ${p.price ? `<div class="card-price">${formatSEK(p.price)}</div>` : ''}
            ${p.price ? `
              <div class="card-actions" data-id="${esc(p.id)}">
                <div class="qty-control">
                  <button class="qty-btn card-qty-minus">-</button>
                  <span class="card-qty-display">1</span>
                  <button class="qty-btn card-qty-plus">+</button>
                </div>
                <button class="btn btn-primary btn-add-cart">Lägg i varukorg</button>
              </div>` : ''}
          </div>
        </article>`;
    }).join('');

    gallery.querySelectorAll('.project-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-actions')) return;
        const proj = projects.find(p => p.id === card.dataset.id);
        if (proj) showDetail(proj);
      });
    });

    gallery.querySelectorAll('.card-actions').forEach(actions => {
      let qty = 1;
      const display = actions.querySelector('.card-qty-display');
      const proj = projects.find(p => p.id === actions.dataset.id);

      actions.querySelector('.card-qty-minus').addEventListener('click', (e) => {
        e.stopPropagation();
        if (qty > 1) { qty--; display.textContent = qty; }
      });
      actions.querySelector('.card-qty-plus').addEventListener('click', (e) => {
        e.stopPropagation();
        qty++; display.textContent = qty;
      });
      actions.querySelector('.btn-add-cart').addEventListener('click', (e) => {
        e.stopPropagation();
        if (proj) {
          addToCart(proj, qty);
          const btn = e.target;
          btn.textContent = 'Tillagd!';
          setTimeout(() => { btn.textContent = 'Lägg i varukorg'; }, 1200);
        }
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

    let imagesHtml = '';
    if (proj.images && proj.images.length > 0) {
      imagesHtml = `<div class="detail-images">
        ${proj.images.map(src => `<img src="${esc(src)}" alt="${esc(proj.name)}" data-lightbox>`).join('')}
      </div>`;
    }

    const inCart = cart.find(c => c.id === proj.id);
    const initQty = inCart ? inCart.qty : 1;

    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(proj.name)}</h2>
        <button class="detail-close" id="detail-close">&times;</button>
      </div>
      <div class="detail-body">
        ${proj.description ? `<div class="detail-desc">${esc(proj.description)}</div>` : ''}
        ${imagesHtml}
        ${proj.price ? `<div class="detail-price">${formatSEK(proj.price)}</div>` : ''}
        <div class="detail-actions">
          ${proj.price ? `
            <div class="qty-control">
              <button class="qty-btn" id="qty-minus">-</button>
              <span id="qty-display">${initQty}</span>
              <button class="qty-btn" id="qty-plus">+</button>
            </div>
            <button class="btn btn-primary" id="add-to-cart">Lägg i varukorg</button>
          ` : ''}
        </div>
      </div>`;

    document.getElementById('detail-close').addEventListener('click', closeDetail);

    if (proj.price) {
      let qty = initQty;
      const qtyDisplay = document.getElementById('qty-display');
      document.getElementById('qty-minus').addEventListener('click', () => {
        if (qty > 1) { qty--; qtyDisplay.textContent = qty; }
      });
      document.getElementById('qty-plus').addEventListener('click', () => {
        qty++; qtyDisplay.textContent = qty;
      });
      document.getElementById('add-to-cart').addEventListener('click', () => {
        addToCart(proj, qty);
        closeDetail();
      });
    }

    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeDetail() {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // --- Cart ---
  function addToCart(proj, qty) {
    const existing = cart.find(c => c.id === proj.id);
    if (existing) {
      existing.qty = qty;
    } else {
      cart.push({ id: proj.id, name: proj.name, price: proj.price, qty });
    }
    saveCart();
    updateCartUI();
  }

  function removeFromCart(id) {
    cart = cart.filter(c => c.id !== id);
    saveCart();
    updateCartUI();
    renderCartPanel();
  }

  function updateCartUI() {
    const totalItems = cart.reduce((s, c) => s + c.qty, 0);
    const icon = document.getElementById('cart-icon');
    const count = document.getElementById('cart-count');
    if (totalItems > 0) {
      icon.classList.remove('hidden');
      count.textContent = totalItems;
    } else {
      icon.classList.add('hidden');
    }
  }

  function renderCartPanel() {
    const items = document.getElementById('cart-items');
    const totalEl = document.getElementById('cart-total');
    const mailtoEl = document.getElementById('cart-mailto');

    if (cart.length === 0) {
      items.innerHTML = '<p class="cart-empty">Varukorgen är tom</p>';
      totalEl.textContent = '';
      mailtoEl.classList.add('hidden');
      return;
    }

    items.innerHTML = cart.map(c => `
      <div class="cart-item">
        <div class="cart-item-info">
          <span class="cart-item-name">${esc(c.name)}</span>
          <span class="cart-item-detail">${c.qty} st &times; ${formatSEK(c.price)}</span>
        </div>
        <div class="cart-item-right">
          <span class="cart-item-sum">${formatSEK(c.qty * c.price)}</span>
          <button class="cart-item-remove" data-id="${esc(c.id)}">&times;</button>
        </div>
      </div>`).join('');

    items.querySelectorAll('.cart-item-remove').forEach(btn => {
      btn.addEventListener('click', () => removeFromCart(btn.dataset.id));
    });

    const total = cart.reduce((s, c) => s + c.qty * c.price, 0);
    totalEl.textContent = 'Totalt: ' + formatSEK(total);

    // Build mailto
    const lines = cart.map(c => `${c.qty} st ${c.name} - ${formatSEK(c.qty * c.price)}`);
    lines.push('', `Totalt: ${formatSEK(total)}`);
    const subject = encodeURIComponent('Beställning från Hallandsek');
    const body = encodeURIComponent(`Hej!\n\nJag vill beställa:\n\n${lines.join('\n')}\n\nMitt namn:\nMin adress:\nTelefon:\n`);
    mailtoEl.href = `mailto:${ORDER_EMAIL}?subject=${subject}&body=${body}`;
    mailtoEl.classList.remove('hidden');
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

  // --- Global bindings ---
  window._toggleCart = () => {
    const panel = document.getElementById('cart-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) renderCartPanel();
  };
})();
