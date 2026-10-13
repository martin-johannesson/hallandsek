// ===== Bildkontur till DXF =====

(function () {
  'use strict';

  // --- State ---
  var TOTAL_STEPS = 6;
  var currentStep = 1;
  var srcImage = null;       // HTMLImageElement
  var grayData = null;       // Uint8Array (w * h)
  var maskData = null;       // Uint8Array (w * h), 1 = included, 0 = excluded
  var maskActive = false;    // true if user painted anything (otherwise skip mask)
  var imgW = 0, imgH = 0;
  var contours = [];         // [{points: [{x,y}], area: number, selected: boolean}]
  var calPoints = [];        // [{x,y}] max 2
  var pixPerMm = 0;          // 0 = uncalibrated
  var MAX_DIM = 1200;

  // Mask painting state
  var painting = false;
  var maskMode = 'brush';    // 'brush' or 'eraser'

  // --- DOM refs (lazily resolved) ---
  function $(id) { return document.getElementById(id); }

  // =====================
  // Init
  // =====================
  document.addEventListener('DOMContentLoaded', function () {
    setupUpload();
    setupMaskStep();
    setupContourStep();
    setupSelectStep();
    setupCalStep();
    setupExportStep();
    setupNav();
  });

  // =====================
  // Step navigation
  // =====================
  function goToStep(n) {
    for (var i = 1; i <= TOTAL_STEPS; i++) {
      var panel = $('step-' + i);
      if (panel) panel.classList.toggle('hidden', i !== n);
    }
    currentStep = n;
    updateStepDots();
    if (n === 2) renderMaskStep();
    if (n === 3) renderContourPreview();
    if (n === 4) renderSelectStep();
    if (n === 5) renderCalStep();
    if (n === 6) renderExportStep();
  }

  function updateStepDots() {
    var dots = document.querySelectorAll('.step-dot');
    dots.forEach(function (dot) {
      var s = parseInt(dot.dataset.step);
      dot.classList.remove('active', 'done');
      if (s === currentStep) dot.classList.add('active');
      else if (s < currentStep) dot.classList.add('done');
    });
  }

  function setupNav() {
    $('btn-back-1').addEventListener('click', function () { goToStep(1); });
    $('btn-next-2').addEventListener('click', function () { goToStep(3); });
    $('btn-back-2').addEventListener('click', function () { goToStep(2); });
    $('btn-next-3').addEventListener('click', function () { goToStep(4); });
    $('btn-back-3').addEventListener('click', function () { goToStep(3); });
    $('btn-next-4').addEventListener('click', function () { goToStep(5); });
    $('btn-back-4').addEventListener('click', function () { goToStep(4); });
    $('btn-next-5').addEventListener('click', function () { goToStep(6); });
    $('btn-back-5').addEventListener('click', function () { goToStep(5); });
    $('btn-skip-mask').addEventListener('click', function () {
      maskActive = false;
      goToStep(3);
    });
    $('btn-skip-cal').addEventListener('click', function () {
      pixPerMm = 0;
      goToStep(6);
    });
    $('btn-restart').addEventListener('click', function () {
      srcImage = null;
      grayData = null;
      maskData = null;
      maskActive = false;
      contours = [];
      calPoints = [];
      pixPerMm = 0;
      $('cal-status').textContent = '';
      $('cal-mm').value = '';
      goToStep(1);
    });
  }

  // =====================
  // Step 1: Upload
  // =====================
  function setupUpload() {
    var area = $('upload-area');
    var input = $('file-input');

    area.addEventListener('click', function () { input.click(); });
    area.addEventListener('dragover', function (e) {
      e.preventDefault();
      area.classList.add('dragover');
    });
    area.addEventListener('dragleave', function () {
      area.classList.remove('dragover');
    });
    area.addEventListener('drop', function (e) {
      e.preventDefault();
      area.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', function () {
      if (input.files.length) handleFile(input.files[0]);
    });
  }

  function handleFile(file) {
    if (!file.type.startsWith('image/')) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        srcImage = img;
        processImage();
        goToStep(2);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function processImage() {
    // Scale down to MAX_DIM
    var scale = 1;
    if (srcImage.width > MAX_DIM || srcImage.height > MAX_DIM) {
      scale = Math.min(MAX_DIM / srcImage.width, MAX_DIM / srcImage.height);
    }
    imgW = Math.round(srcImage.width * scale);
    imgH = Math.round(srcImage.height * scale);

    var c = document.createElement('canvas');
    c.width = imgW;
    c.height = imgH;
    var ctx = c.getContext('2d');
    ctx.drawImage(srcImage, 0, 0, imgW, imgH);
    var imageData = ctx.getImageData(0, 0, imgW, imgH);
    var d = imageData.data;

    // Grayscale
    grayData = new Uint8Array(imgW * imgH);
    for (var i = 0; i < grayData.length; i++) {
      var off = i * 4;
      grayData[i] = Math.round(0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2]);
    }

    // Reset mask
    maskData = new Uint8Array(imgW * imgH);
    maskActive = false;
  }

  // =====================
  // Step 2: Mask object
  // =====================
  function setupMaskStep() {
    var canvas = $('canvas-mask');

    // Brush/eraser toggle
    $('btn-mask-brush').addEventListener('click', function () {
      maskMode = 'brush';
      $('btn-mask-brush').classList.add('active');
      $('btn-mask-eraser').classList.remove('active');
    });
    $('btn-mask-eraser').addEventListener('click', function () {
      maskMode = 'eraser';
      $('btn-mask-eraser').classList.add('active');
      $('btn-mask-brush').classList.remove('active');
    });

    // Brush size
    $('slider-brush-size').addEventListener('input', function () {
      $('val-brush-size').textContent = this.value;
    });

    // Clear / fill
    $('btn-mask-clear').addEventListener('click', function () {
      maskData = new Uint8Array(imgW * imgH);
      maskActive = false;
      renderMaskCanvas();
    });
    $('btn-mask-fill').addEventListener('click', function () {
      maskData = new Uint8Array(imgW * imgH);
      for (var i = 0; i < maskData.length; i++) maskData[i] = 1;
      maskActive = true;
      renderMaskCanvas();
    });

    // Painting events
    canvas.addEventListener('mousedown', function (e) {
      painting = true;
      maskActive = true;
      paintMask(e);
    });
    canvas.addEventListener('mousemove', function (e) {
      if (painting) paintMask(e);
    });
    canvas.addEventListener('mouseup', function () { painting = false; });
    canvas.addEventListener('mouseleave', function () { painting = false; });

    // Touch support
    canvas.addEventListener('touchstart', function (e) {
      e.preventDefault();
      painting = true;
      maskActive = true;
      paintMask(e.touches[0]);
    }, { passive: false });
    canvas.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (painting) paintMask(e.touches[0]);
    }, { passive: false });
    canvas.addEventListener('touchend', function () { painting = false; });
  }

  function paintMask(e) {
    var canvas = $('canvas-mask');
    var rect = canvas.getBoundingClientRect();
    var scaleX = imgW / rect.width;
    var scaleY = imgH / rect.height;
    var cx = (e.clientX - rect.left) * scaleX;
    var cy = (e.clientY - rect.top) * scaleY;
    var radius = parseInt($('slider-brush-size').value);
    var val = maskMode === 'brush' ? 1 : 0;

    // Paint circle into mask
    var r2 = radius * radius;
    var x0 = Math.max(0, Math.floor(cx - radius));
    var y0 = Math.max(0, Math.floor(cy - radius));
    var x1 = Math.min(imgW - 1, Math.ceil(cx + radius));
    var y1 = Math.min(imgH - 1, Math.ceil(cy + radius));
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          maskData[y * imgW + x] = val;
        }
      }
    }
    renderMaskCanvas();
  }

  function renderMaskStep() {
    renderMaskCanvas();
  }

  function renderMaskCanvas() {
    var canvas = $('canvas-mask');
    canvas.width = imgW;
    canvas.height = imgH;
    var ctx = canvas.getContext('2d');

    // Draw original image
    ctx.drawImage(srcImage, 0, 0, imgW, imgH);

    // Dim unmasked areas
    var overlay = ctx.getImageData(0, 0, imgW, imgH);
    var d = overlay.data;
    for (var i = 0; i < maskData.length; i++) {
      if (maskData[i] === 0) {
        // Darken unmasked pixels
        var off = i * 4;
        d[off] = Math.round(d[off] * 0.35);
        d[off + 1] = Math.round(d[off + 1] * 0.35);
        d[off + 2] = Math.round(d[off + 2] * 0.35);
      } else {
        // Tint masked pixels green
        var off2 = i * 4;
        d[off2 + 1] = Math.min(255, d[off2 + 1] + 40);
        d[off2 + 3] = 255;
      }
    }
    ctx.putImageData(overlay, 0, 0);

    // Draw mask edge outline
    ctx.strokeStyle = 'rgba(212,114,42,0.6)';
    ctx.lineWidth = 1;
    for (var y = 0; y < imgH; y++) {
      for (var x = 0; x < imgW; x++) {
        if (maskData[y * imgW + x] === 1) {
          // Check if edge pixel (any neighbor is 0 or border)
          var isEdge = false;
          if (x === 0 || x === imgW - 1 || y === 0 || y === imgH - 1) isEdge = true;
          else if (maskData[y * imgW + x - 1] === 0 || maskData[y * imgW + x + 1] === 0 ||
                   maskData[(y - 1) * imgW + x] === 0 || maskData[(y + 1) * imgW + x] === 0) isEdge = true;
          if (isEdge) {
            ctx.fillStyle = 'rgba(212,114,42,0.7)';
            ctx.fillRect(x, y, 1, 1);
          }
        }
      }
    }
  }

  // =====================
  // Step 3: Adjust contours
  // =====================
  function setupContourStep() {
    var sliders = ['threshold', 'blur', 'area', 'simplify'];
    sliders.forEach(function (name) {
      $('slider-' + name).addEventListener('input', function () {
        $('val-' + name).textContent = this.value;
        renderContourPreview();
      });
    });
    $('toggle-invert').addEventListener('change', function () { renderContourPreview(); });
    $('toggle-smooth').addEventListener('change', function () { renderContourPreview(); });
  }

  function getParams() {
    return {
      threshold: parseInt($('slider-threshold').value),
      blur: parseInt($('slider-blur').value),
      minArea: parseInt($('slider-area').value),
      simplify: parseFloat($('slider-simplify').value),
      invert: $('toggle-invert').checked,
      smooth: $('toggle-smooth').checked
    };
  }

  function renderContourPreview() {
    if (!grayData) return;
    var p = getParams();
    var processed = applyBlur(grayData, imgW, imgH, p.blur);
    var binary = threshold(processed, imgW, imgH, p.threshold, p.invert);

    // Apply mask: zero out everything outside mask
    if (maskActive && maskData) {
      for (var i = 0; i < binary.length; i++) {
        if (maskData[i] === 0) binary[i] = 0;
      }
    }

    var rawContours = marchingSquares(binary, imgW, imgH);
    var stitched = stitchSegments(rawContours);

    contours = [];
    for (var j = 0; j < stitched.length; j++) {
      var pts = stitched[j];
      var area = contourArea(pts);
      if (Math.abs(area) < p.minArea) continue;
      // Ensure consistent winding (CCW)
      if (area < 0) pts.reverse();
      var simplified = douglasPeucker(pts, p.simplify);
      if (simplified.length < 3) continue;
      if (p.smooth) simplified = chaikinSmooth(simplified, 2);
      contours.push({ points: simplified, area: Math.abs(contourArea(simplified)), selected: false });
    }

    // Sort by area descending
    contours.sort(function (a, b) { return b.area - a.area; });
    // Select largest by default
    if (contours.length > 0) contours[0].selected = true;

    drawContourOverlay('canvas-contour', contours, null);
  }

  function drawContourOverlay(canvasId, cList, highlightIdx) {
    var canvas = $(canvasId);
    canvas.width = imgW;
    canvas.height = imgH;
    var ctx = canvas.getContext('2d');

    // Draw original image
    ctx.drawImage(srcImage, 0, 0, imgW, imgH);

    // Dim slightly
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, imgW, imgH);

    // Draw contours
    for (var i = 0; i < cList.length; i++) {
      var c = cList[i];
      ctx.beginPath();
      var pts = c.points;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var j = 1; j < pts.length; j++) {
        ctx.lineTo(pts[j].x, pts[j].y);
      }
      ctx.closePath();
      if (c.selected) {
        ctx.strokeStyle = '#d4722a';
        ctx.lineWidth = 2;
        ctx.fillStyle = 'rgba(212,114,42,0.15)';
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(200,200,200,0.6)';
        ctx.lineWidth = 1;
      }
      if (highlightIdx === i) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
      }
      ctx.stroke();
    }
  }

  // =====================
  // Step 4: Select contours
  // =====================
  function setupSelectStep() {
    $('btn-select-all').addEventListener('click', function () {
      contours.forEach(function (c) { c.selected = true; });
      renderSelectStep();
    });
    $('btn-deselect-all').addEventListener('click', function () {
      contours.forEach(function (c) { c.selected = false; });
      renderSelectStep();
    });

    $('canvas-select').addEventListener('click', function (e) {
      var rect = this.getBoundingClientRect();
      var scaleX = imgW / rect.width;
      var scaleY = imgH / rect.height;
      var mx = (e.clientX - rect.left) * scaleX;
      var my = (e.clientY - rect.top) * scaleY;

      // Find closest contour
      var bestDist = Infinity, bestIdx = -1;
      for (var i = 0; i < contours.length; i++) {
        if (pointInPolygon(mx, my, contours[i].points)) {
          // Pick smallest containing polygon
          if (contours[i].area < bestDist) {
            bestDist = contours[i].area;
            bestIdx = i;
          }
        }
      }
      if (bestIdx >= 0) {
        contours[bestIdx].selected = !contours[bestIdx].selected;
        renderSelectStep();
      }
    });
  }

  function renderSelectStep() {
    drawContourOverlay('canvas-select', contours, null);

    var list = $('contour-list');
    list.innerHTML = '';
    for (var i = 0; i < contours.length; i++) {
      (function (idx) {
        var c = contours[idx];
        var item = document.createElement('div');
        item.className = 'contour-item' + (c.selected ? ' selected' : '');
        item.innerHTML =
          '<input type="checkbox"' + (c.selected ? ' checked' : '') + '>' +
          '<span class="contour-info">Kontur ' + (idx + 1) + '</span>' +
          '<span class="contour-area">' + Math.round(c.area) + ' px\u00B2 \u2022 ' + c.points.length + ' punkter</span>';
        item.addEventListener('click', function (e) {
          if (e.target.tagName === 'INPUT') {
            c.selected = e.target.checked;
          } else {
            c.selected = !c.selected;
          }
          renderSelectStep();
        });
        list.appendChild(item);
      })(i);
    }
  }

  // =====================
  // Step 5: Calibration
  // =====================
  function setupCalStep() {
    var canvas = $('canvas-cal');
    canvas.addEventListener('click', function (e) {
      if (calPoints.length >= 2) return;
      var rect = canvas.getBoundingClientRect();
      var scaleX = imgW / rect.width;
      var scaleY = imgH / rect.height;
      calPoints.push({
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      });
      drawCalOverlay();
      if (calPoints.length === 2) {
        var dx = calPoints[1].x - calPoints[0].x;
        var dy = calPoints[1].y - calPoints[0].y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        $('cal-status').textContent = 'Linje: ' + Math.round(dist) + ' px. Ange mått i mm.';
      }
    });

    $('btn-cal-apply').addEventListener('click', function () {
      if (calPoints.length < 2) { $('cal-status').textContent = 'Markera två punkter först.'; return; }
      var mm = parseFloat($('cal-mm').value);
      if (!mm || mm <= 0) { $('cal-status').textContent = 'Ange ett giltigt mått.'; return; }
      var dx = calPoints[1].x - calPoints[0].x;
      var dy = calPoints[1].y - calPoints[0].y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      pixPerMm = dist / mm;
      $('cal-status').textContent = 'Skala: ' + pixPerMm.toFixed(2) + ' px/mm (' + (1 / pixPerMm).toFixed(3) + ' mm/px)';
    });

    $('btn-cal-reset').addEventListener('click', function () {
      calPoints = [];
      pixPerMm = 0;
      $('cal-status').textContent = '';
      $('cal-mm').value = '';
      drawCalOverlay();
    });
  }

  function renderCalStep() {
    drawCalOverlay();
  }

  function drawCalOverlay() {
    var canvas = $('canvas-cal');
    canvas.width = imgW;
    canvas.height = imgH;
    var ctx = canvas.getContext('2d');

    ctx.drawImage(srcImage, 0, 0, imgW, imgH);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, imgW, imgH);

    // Draw selected contours
    var selected = contours.filter(function (c) { return c.selected; });
    for (var i = 0; i < selected.length; i++) {
      var pts = selected[i].points;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.closePath();
      ctx.strokeStyle = '#d4722a';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Draw cal points and line
    for (var k = 0; k < calPoints.length; k++) {
      ctx.beginPath();
      ctx.arc(calPoints[k].x, calPoints[k].y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#d4722a';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (calPoints.length === 2) {
      ctx.beginPath();
      ctx.moveTo(calPoints[0].x, calPoints[0].y);
      ctx.lineTo(calPoints[1].x, calPoints[1].y);
      ctx.strokeStyle = '#d4722a';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // =====================
  // Step 6: Export
  // =====================
  function setupExportStep() {
    $('btn-download').addEventListener('click', downloadDXF);
  }

  function renderExportStep() {
    var selected = contours.filter(function (c) { return c.selected; });
    var totalPts = selected.reduce(function (s, c) { return s + c.points.length; }, 0);

    // Draw preview
    var canvas = $('canvas-export');
    canvas.width = imgW;
    canvas.height = imgH;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#faf8f5';
    ctx.fillRect(0, 0, imgW, imgH);

    for (var i = 0; i < selected.length; i++) {
      var pts = selected[i].points;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.closePath();
      ctx.strokeStyle = '#6b4c2a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Info
    var scaleStr = pixPerMm > 0
      ? pixPerMm.toFixed(2) + ' px/mm'
      : 'Ej kalibrerad (1 px = 1 enhet)';
    var unitStr = pixPerMm > 0 ? 'mm' : 'px';

    $('export-info').innerHTML =
      '<div class="export-info-row"><span>Konturer:</span><span>' + selected.length + '</span></div>' +
      '<div class="export-info-row"><span>Totalt punkter:</span><span>' + totalPts + '</span></div>' +
      '<div class="export-info-row"><span>Skala:</span><span>' + scaleStr + '</span></div>' +
      '<div class="export-info-row"><span>Enheter i DXF:</span><span>' + unitStr + '</span></div>' +
      (pixPerMm === 0 ? '<div class="export-info-row" style="color:#9e3030;margin-top:0.5rem"><span>OBS: Utan kalibrering exporteras koordinaterna i pixlar.</span><span></span></div>' : '');
  }

  function downloadDXF() {
    var selected = contours.filter(function (c) { return c.selected; });
    if (selected.length === 0) return;

    var dxf = generateDXF(selected, pixPerMm);
    var blob = new Blob([dxf], { type: 'application/dxf' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var today = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = 'kontur_' + today + '.dxf';
    a.click();
    URL.revokeObjectURL(url);
  }

  // =====================
  // Image processing
  // =====================
  function applyBlur(data, w, h, passes) {
    if (passes <= 0) return data;
    var src = new Uint8Array(data);
    var dst = new Uint8Array(w * h);
    for (var p = 0; p < passes; p++) {
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var sum = 0, count = 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              var nx = x + dx, ny = y + dy;
              if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                sum += src[ny * w + nx];
                count++;
              }
            }
          }
          dst[y * w + x] = Math.round(sum / count);
        }
      }
      var tmp = src; src = dst; dst = tmp;
    }
    return src;
  }

  function threshold(data, w, h, thresh, invert) {
    var out = new Uint8Array(w * h);
    for (var i = 0; i < out.length; i++) {
      var val = data[i] >= thresh ? 1 : 0;
      out[i] = invert ? (1 - val) : val;
    }
    return out;
  }

  // =====================
  // Marching Squares
  // =====================
  function marchingSquares(binary, w, h) {
    var segments = [];
    for (var y = 0; y < h - 1; y++) {
      for (var x = 0; x < w - 1; x++) {
        var tl = binary[y * w + x];
        var tr = binary[y * w + x + 1];
        var br = binary[(y + 1) * w + x + 1];
        var bl = binary[(y + 1) * w + x];
        var cell = (tl << 3) | (tr << 2) | (br << 1) | bl;

        if (cell === 0 || cell === 15) continue;

        var top = { x: x + 0.5, y: y };
        var right = { x: x + 1, y: y + 0.5 };
        var bottom = { x: x + 0.5, y: y + 1 };
        var left = { x: x, y: y + 0.5 };

        switch (cell) {
          case 1:  segments.push([left, bottom]); break;
          case 2:  segments.push([bottom, right]); break;
          case 3:  segments.push([left, right]); break;
          case 4:  segments.push([right, top]); break;
          case 5:
            var center = (tl + tr + br + bl) / 4;
            if (center >= 0.5) {
              segments.push([left, top]);
              segments.push([bottom, right]);
            } else {
              segments.push([left, bottom]);
              segments.push([right, top]);
            }
            break;
          case 6:  segments.push([bottom, top]); break;
          case 7:  segments.push([left, top]); break;
          case 8:  segments.push([top, left]); break;
          case 9:  segments.push([top, bottom]); break;
          case 10:
            var center2 = (tl + tr + br + bl) / 4;
            if (center2 >= 0.5) {
              segments.push([top, right]);
              segments.push([bottom, left]);
            } else {
              segments.push([top, left]);
              segments.push([bottom, right]);
            }
            break;
          case 11: segments.push([top, right]); break;
          case 12: segments.push([right, left]); break;
          case 13: segments.push([right, bottom]); break;
          case 14: segments.push([bottom, left]); break;
        }
      }
    }
    return segments;
  }

  // =====================
  // Segment stitching
  // =====================
  function stitchSegments(segments) {
    if (segments.length === 0) return [];

    var PREC = 10;
    function key(p) { return Math.round(p.x * PREC) + ',' + Math.round(p.y * PREC); }

    var map = {};
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      var k0 = key(s[0]), k1 = key(s[1]);
      if (!map[k0]) map[k0] = [];
      if (!map[k1]) map[k1] = [];
      map[k0].push(i);
      map[k1].push(i);
    }

    var used = new Uint8Array(segments.length);
    var chains = [];

    for (var si = 0; si < segments.length; si++) {
      if (used[si]) continue;
      used[si] = 1;
      var chain = [segments[si][0], segments[si][1]];

      var extended = true;
      while (extended) {
        extended = false;
        var endKey = key(chain[chain.length - 1]);
        var candidates = map[endKey];
        if (!candidates) break;
        for (var ci = 0; ci < candidates.length; ci++) {
          var idx = candidates[ci];
          if (used[idx]) continue;
          var seg = segments[idx];
          var sk0 = key(seg[0]), sk1 = key(seg[1]);
          if (sk0 === endKey) {
            chain.push(seg[1]);
            used[idx] = 1;
            extended = true;
            break;
          } else if (sk1 === endKey) {
            chain.push(seg[0]);
            used[idx] = 1;
            extended = true;
            break;
          }
        }
      }

      extended = true;
      while (extended) {
        extended = false;
        var startKey = key(chain[0]);
        var candidates2 = map[startKey];
        if (!candidates2) break;
        for (var ci2 = 0; ci2 < candidates2.length; ci2++) {
          var idx2 = candidates2[ci2];
          if (used[idx2]) continue;
          var seg2 = segments[idx2];
          var sk0b = key(seg2[0]), sk1b = key(seg2[1]);
          if (sk0b === startKey) {
            chain.unshift(seg2[1]);
            used[idx2] = 1;
            extended = true;
            break;
          } else if (sk1b === startKey) {
            chain.unshift(seg2[0]);
            used[idx2] = 1;
            extended = true;
            break;
          }
        }
      }

      if (chain.length >= 3) chains.push(chain);
    }

    return chains;
  }

  // =====================
  // Contour area (shoelace)
  // =====================
  function contourArea(pts) {
    var area = 0;
    var n = pts.length;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      area += pts[i].x * pts[j].y;
      area -= pts[j].x * pts[i].y;
    }
    return area / 2;
  }

  // =====================
  // Douglas-Peucker simplification
  // =====================
  function douglasPeucker(pts, epsilon) {
    if (pts.length <= 2) return pts;

    var maxDist = 0, maxIdx = 0;
    var first = pts[0], last = pts[pts.length - 1];

    for (var i = 1; i < pts.length - 1; i++) {
      var d = perpDist(pts[i], first, last);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }

    if (maxDist > epsilon) {
      var left = douglasPeucker(pts.slice(0, maxIdx + 1), epsilon);
      var right = douglasPeucker(pts.slice(maxIdx), epsilon);
      return left.slice(0, -1).concat(right);
    } else {
      return [first, last];
    }
  }

  function perpDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((p.x - a.x) * (p.x - a.x) + (p.y - a.y) * (p.y - a.y));
    var num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
    return num / Math.sqrt(lenSq);
  }

  // =====================
  // Chaikin smoothing
  // =====================
  function chaikinSmooth(pts, iterations) {
    var result = pts;
    for (var iter = 0; iter < iterations; iter++) {
      var next = [];
      var n = result.length;
      for (var i = 0; i < n; i++) {
        var j = (i + 1) % n;
        var p0 = result[i], p1 = result[j];
        next.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
        next.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
      }
      result = next;
    }
    return result;
  }

  // =====================
  // Point in polygon (ray casting)
  // =====================
  function pointInPolygon(px, py, pts) {
    var inside = false;
    var n = pts.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = pts[i].x, yi = pts[i].y;
      var xj = pts[j].x, yj = pts[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // =====================
  // DXF R12 generation
  // =====================
  function generateDXF(selected, ppm) {
    var scale = ppm > 0 ? (1 / ppm) : 1;
    var lines = [];

    lines.push('0');
    lines.push('SECTION');
    lines.push('2');
    lines.push('HEADER');
    lines.push('9');
    lines.push('$INSUNITS');
    lines.push('70');
    lines.push(ppm > 0 ? '4' : '0');
    lines.push('0');
    lines.push('ENDSEC');

    lines.push('0');
    lines.push('SECTION');
    lines.push('2');
    lines.push('ENTITIES');

    for (var i = 0; i < selected.length; i++) {
      var pts = selected[i].points;
      lines.push('0');
      lines.push('POLYLINE');
      lines.push('8');
      lines.push('0');
      lines.push('66');
      lines.push('1');
      lines.push('70');
      lines.push('1');

      for (var j = 0; j < pts.length; j++) {
        lines.push('0');
        lines.push('VERTEX');
        lines.push('8');
        lines.push('0');
        lines.push('10');
        lines.push((pts[j].x * scale).toFixed(4));
        lines.push('20');
        lines.push((-pts[j].y * scale).toFixed(4));
        lines.push('30');
        lines.push('0.0000');
      }

      lines.push('0');
      lines.push('SEQEND');
    }

    lines.push('0');
    lines.push('ENDSEC');
    lines.push('0');
    lines.push('EOF');

    return lines.join('\n');
  }

})();
