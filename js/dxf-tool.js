// ===== Bildkontur till DXF =====

(function () {
  'use strict';

  // --- State ---
  var currentStep = 1;
  var srcImage = null;       // HTMLImageElement
  var grayData = null;       // Uint8Array (w * h)
  var rgbaData = null;       // Uint8ClampedArray (w * h * 4)
  var imgW = 0, imgH = 0;
  var contours = [];         // [{points: [{x,y}], area: number, selected: boolean}]
  var calPoints = [];        // [{x,y}] max 2
  var pixPerMm = 0;          // 0 = uncalibrated
  var MAX_DIM = 1200;
  var detectMode = 'object'; // 'object' or 'brush'
  var gradientMap = null;       // Float32Array (w * h), cached Sobel gradient
  var cachedCenters = null;     // k-means centroids array
  var cachedBorderPercent = 0;  // last border % for cache invalidation
  var brushMask = null;          // Uint8Array (w*h), 1 = brushed pixel
  var brushStrokes = [];         // [[{x,y},...]] for overlay rendering
  var brushFgCenters = null;     // k-means centroids from brushed pixels
  var brushDrawing = false;      // currently drawing a stroke
  var originalDataUrl = null;    // original image data URL for debug saving

  // --- DOM refs ---
  function $(id) { return document.getElementById(id); }

  // =====================
  // Init
  // =====================
  document.addEventListener('DOMContentLoaded', function () {
    setupUpload();
    setupStep2();
    setupStep3();
    setupStep4();
    setupStep5();
    setupNav();
  });

  // =====================
  // Step navigation
  // =====================
  function goToStep(n) {
    for (var i = 1; i <= 5; i++) {
      var panel = $('step-' + i);
      if (panel) panel.classList.toggle('hidden', i !== n);
    }
    currentStep = n;
    updateStepDots();
    if (n === 2) {
      renderContourPreview();
      $('canvas-contour').style.cursor = detectMode === 'brush' ? 'crosshair' : '';
    }
    if (n === 3) renderSelectStep();
    if (n === 4) renderCalStep();
    if (n === 5) renderExportStep();
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
    $('btn-restart').addEventListener('click', function () {
      srcImage = null;
      grayData = null;
      rgbaData = null;
      contours = [];
      calPoints = [];
      pixPerMm = 0;
      gradientMap = null;
      cachedCenters = null;
      cachedBorderPercent = 0;
      brushMask = null;
      brushStrokes = [];
      brushFgCenters = null;
      brushDrawing = false;
      originalDataUrl = null;
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
      originalDataUrl = e.target.result;
      var img = new Image();
      img.onload = function () {
        srcImage = img;
        processImage();
        goToStep(2);
        // Auto-save original to local server (silent fail if not running)
        saveToServer({ original: originalDataUrl });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function saveToServer(data) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/save-test', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(data));
    } catch (e) { /* silent */ }
  }

  function collectDebugInfo() {
    return {
      mode: detectMode,
      contours: contours.length,
      selected: contours.filter(function (c) { return c.selected; }).length,
      holes: contours.filter(function (c) { return c.isHole; }).length,
      imgW: imgW,
      imgH: imgH,
      pixPerMm: pixPerMm,
      sliders: {
        area: $('slider-area') ? $('slider-area').value : null,
        simplify: $('slider-simplify') ? $('slider-simplify').value : null,
        smooth: $('toggle-smooth') ? $('toggle-smooth').checked : null,
        tolerance: $('slider-tolerance') ? $('slider-tolerance').value : null,
        grow: $('slider-grow') ? $('slider-grow').value : null,
        brushWidth: $('slider-brush-width') ? $('slider-brush-width').value : null
      },
      contourDetails: contours.map(function (c, i) {
        return { idx: i, area: Math.round(c.area), isHole: c.isHole, parentIdx: c.parentIdx, selected: c.selected, points: c.points.length };
      }),
      timestamp: new Date().toISOString()
    };
  }

  function processImage() {
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

    // Store RGBA for flood fill
    rgbaData = new Uint8ClampedArray(d);

    // Grayscale for threshold mode
    grayData = new Uint8Array(imgW * imgH);
    for (var i = 0; i < grayData.length; i++) {
      var off = i * 4;
      grayData[i] = Math.round(0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2]);
    }

    // Precompute Sobel gradient (cached, reused on slider changes)
    gradientMap = computeGradient(grayData, imgW, imgH);
    cachedCenters = null;
    cachedBorderPercent = 0;
  }

  // =====================
  // Step 2: Detect contours
  // =====================
  function setupStep2() {
    var modeHints = {
      object: 'Separerar objekt från bakgrund via färganalys. Bakgrunden fylls in från bildkanterna. Justera känslighet tills objektet markeras.',
      brush: 'Måla på objektet med penseln. Algoritmen lär sig färgerna och hittar hela objektet automatiskt.'
    };

    // Mode selector
    var modeButtons = document.querySelectorAll('#mode-selector .mode-btn');
    modeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        modeButtons.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        detectMode = btn.dataset.mode;
        $('object-controls').style.display = detectMode === 'object' ? '' : 'none';
        $('brush-controls').style.display = detectMode === 'brush' ? '' : 'none';
        var cc = $('canvas-contour');
        cc.style.cursor = detectMode === 'brush' ? 'crosshair' : '';
        $('mode-hint').textContent = modeHints[detectMode] || '';
        renderContourPreview();
      });
    });

    // Object mode sliders
    ['tolerance', 'grow'].forEach(function (name) {
      $('slider-' + name).addEventListener('input', function () {
        $('val-' + name).textContent = this.value;
        renderContourPreview();
      });
    });

    // Shared sliders
    ['area', 'simplify'].forEach(function (name) {
      $('slider-' + name).addEventListener('input', function () {
        $('val-' + name).textContent = this.value;
        renderContourPreview();
      });
    });

    $('toggle-smooth').addEventListener('change', function () { renderContourPreview(); });

    // Brush mode controls
    $('slider-brush-width').addEventListener('input', function () {
      $('val-brush-width').textContent = this.value;
    });
    $('btn-brush-clear').addEventListener('click', function () {
      brushMask = null;
      brushStrokes = [];
      brushFgCenters = null;
      renderContourPreview();
    });
    $('btn-brush-undo').addEventListener('click', function () {
      if (brushStrokes.length === 0) return;
      brushStrokes.pop();
      // Rebuild mask from remaining strokes
      brushMask = brushStrokes.length > 0 ? new Uint8Array(imgW * imgH) : null;
      for (var si = 0; si < brushStrokes.length; si++) {
        var s = brushStrokes[si];
        var r = s[0].r;
        brushCircle(brushMask, imgW, imgH, s[0].x, s[0].y, r);
        for (var pi = 1; pi < s.length; pi++) {
          brushLine(brushMask, imgW, imgH, s[pi - 1].x, s[pi - 1].y, s[pi].x, s[pi].y, r);
        }
      }
      brushFgCenters = null;
      renderContourPreview();
    });

    // Brush canvas drawing — pointer events with setPointerCapture for reliable drag
    var brushCanvas = $('canvas-contour');
    brushCanvas.setAttribute('draggable', 'false');
    brushCanvas.style.touchAction = 'none';
    brushCanvas.style.userSelect = 'none';

    function brushImgRadius() {
      var r = brushCanvas.getBoundingClientRect();
      var sx = imgW / r.width;
      var screenPx = parseInt($('slider-brush-width').value);
      return Math.max(1, screenPx * sx / 2);
    }

    function canvasCoords(e) {
      var r = brushCanvas.getBoundingClientRect();
      var sx = imgW / r.width, sy = imgH / r.height;
      return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
    }

    brushCanvas.addEventListener('pointerdown', function (e) {
      if (detectMode !== 'brush' || !imgW) return;
      e.preventDefault();
      this.setPointerCapture(e.pointerId);
      brushDrawing = true;
      var p = canvasCoords(e);
      var imgR = brushImgRadius();
      brushStrokes.push([{ x: p.x, y: p.y, r: imgR }]);
      if (!brushMask) brushMask = new Uint8Array(imgW * imgH);
      brushCircle(brushMask, imgW, imgH, p.x, p.y, imgR);
      var ctx = this.getContext('2d');
      ctx.beginPath();
      ctx.arc(p.x, p.y, imgR, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(50,205,50,0.4)';
      ctx.fill();
    });

    brushCanvas.addEventListener('pointermove', function (e) {
      if (!brushDrawing) return;
      e.preventDefault();
      var p = canvasCoords(e);
      var stroke = brushStrokes[brushStrokes.length - 1];
      var prev = stroke[stroke.length - 1];
      stroke.push({ x: p.x, y: p.y });
      var imgR = stroke[0].r;
      brushLine(brushMask, imgW, imgH, prev.x, prev.y, p.x, p.y, imgR);
      var ctx = this.getContext('2d');
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = 'rgba(50,205,50,0.4)';
      ctx.lineWidth = imgR * 2;
      ctx.lineCap = 'round';
      ctx.stroke();
    });

    brushCanvas.addEventListener('pointerup', function (e) {
      if (!brushDrawing) return;
      this.releasePointerCapture(e.pointerId);
      brushDrawing = false;
      brushFgCenters = null;
      setTimeout(function () { renderContourPreview(); }, 10);
    });

    // Save test image (snapshot + debug info)
    $('btn-save-test').addEventListener('click', function () {
      var canvas = $('canvas-contour');
      var snapshotUrl = canvas.toDataURL('image/png');
      var debug = collectDebugInfo();
      // Save to local server
      saveToServer({ snapshot: snapshotUrl, original: originalDataUrl, debug: debug });
      // Also trigger browser download as fallback
      var a = document.createElement('a');
      a.href = snapshotUrl;
      var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = 'dxf-test-' + ts + '.png';
      a.click();
    });
  }

  function renderContourPreview() {
    if (!grayData) return;
    var minArea = parseInt($('slider-area').value);
    var simplify = parseFloat($('slider-simplify').value);
    var smooth = $('toggle-smooth').checked;
    var binary;

    if (detectMode === 'object') {
      var tolerance = parseInt($('slider-tolerance').value);
      var grow = parseInt($('slider-grow').value);
      binary = detectForeground(rgbaData, imgW, imgH, tolerance);
      // Morphological close (dilate then erode) to fill small gaps
      if (grow > 0) {
        binary = dilate(binary, imgW, imgH, grow);
        binary = erode(binary, imgW, imgH, grow);
      }
    } else if (detectMode === 'brush') {
      if (brushStrokes.length === 0 || !brushMask) {
        contours = [];
        drawContourOverlay('canvas-contour', contours, null);
        drawBrushStrokes('canvas-contour');
        return;
      }
      // Always compute fresh bg centers for brush mode (border 8% for better coverage)
      var bSamples = sampleBorderPixels(rgbaData, imgW, imgH, 8);
      var brushBgCenters = kMeansClusters(bSamples, 5, 15);
      // Fg centers from brushed pixels
      if (!brushFgCenters) {
        var fgSamples = [];
        for (var bi = 0; bi < brushMask.length; bi++) {
          if (brushMask[bi]) {
            var boff = bi * 4;
            fgSamples.push([rgbaData[boff], rgbaData[boff + 1], rgbaData[boff + 2]]);
          }
        }
        if (fgSamples.length === 0) {
          contours = [];
          drawContourOverlay('canvas-contour', contours, null);
          drawBrushStrokes('canvas-contour');
          return;
        }
        if (fgSamples.length > 8000) {
          var bstep = Math.floor(fgSamples.length / 8000);
          var bsub = [];
          for (var bsi = 0; bsi < fgSamples.length; bsi += bstep) bsub.push(fgSamples[bsi]);
          fgSamples = bsub;
        }
        var fgK = Math.min(5, Math.max(2, Math.ceil(fgSamples.length / 200)));
        var rawFgCenters = kMeansClusters(fgSamples, fgK, 15);
        // Filter out fg clusters that look like background (misclick protection)
        brushFgCenters = [];
        for (var fi = 0; fi < rawFgCenters.length; fi++) {
          var fc = rawFgCenters[fi];
          var minBgDist = Infinity;
          for (var bci = 0; bci < brushBgCenters.length; bci++) {
            var dr = fc[0] - brushBgCenters[bci][0], dg = fc[1] - brushBgCenters[bci][1], db = fc[2] - brushBgCenters[bci][2];
            var d = Math.sqrt(dr * dr + dg * dg + db * db);
            if (d < minBgDist) minBgDist = d;
          }
          // Keep fg cluster only if it's sufficiently different from all bg clusters
          if (minBgDist > 25) brushFgCenters.push(fc);
        }
        // If all were filtered, keep the one farthest from bg
        if (brushFgCenters.length === 0) {
          var bestDist = -1, bestCenter = rawFgCenters[0];
          for (var fi2 = 0; fi2 < rawFgCenters.length; fi2++) {
            var fc2 = rawFgCenters[fi2];
            var mbd = Infinity;
            for (var bci2 = 0; bci2 < brushBgCenters.length; bci2++) {
              var dr2 = fc2[0] - brushBgCenters[bci2][0], dg2 = fc2[1] - brushBgCenters[bci2][1], db2 = fc2[2] - brushBgCenters[bci2][2];
              var d2 = Math.sqrt(dr2 * dr2 + dg2 * dg2 + db2 * db2);
              if (d2 < mbd) mbd = d2;
            }
            if (mbd > bestDist) { bestDist = mbd; bestCenter = fc2; }
          }
          brushFgCenters = [bestCenter];
        }
      }
      binary = detectForegroundBrush(rgbaData, imgW, imgH, brushMask, brushBgCenters, brushFgCenters);
      // Morphological close (fill gaps) then open (remove noise)
      binary = dilate(binary, imgW, imgH, 2);
      binary = erode(binary, imgW, imgH, 3);
      binary = dilate(binary, imgW, imgH, 1);
    } else {
      // Fallback: treat as object mode
      var tolerance = parseInt($('slider-tolerance').value);
      binary = detectForeground(rgbaData, imgW, imgH, tolerance);
    }

    // Smooth binary mask with box blur + re-threshold to reduce jagged edges
    binary = smoothBinaryMask(binary, imgW, imgH, 1);

    var rawContours = marchingSquares(binary, imgW, imgH);
    var stitched = stitchSegments(rawContours);

    contours = [];
    for (var i = 0; i < stitched.length; i++) {
      var pts = stitched[i];
      var area = contourArea(pts);
      if (Math.abs(area) < minArea) continue;
      // Preserve winding direction — signed area determines hole vs outer
      var simplified = douglasPeucker(pts, simplify);
      if (simplified.length < 3) continue;
      if (smooth) simplified = chaikinSmooth(simplified, 2);
      var finalArea = contourArea(simplified);
      contours.push({ points: simplified, area: Math.abs(finalArea), rawArea: finalArea, selected: false, isHole: false, parentIdx: -1 });
    }

    contours.sort(function (a, b) { return b.area - a.area; });
    buildContourHierarchy(contours);

    // Auto-select: largest outer contour + all its direct holes
    if (contours.length > 0) {
      contours[0].selected = true;
      for (var ci = 1; ci < contours.length; ci++) {
        if (contours[ci].parentIdx === 0) contours[ci].selected = true;
      }
    }

    drawContourOverlay('canvas-contour', contours, null);
    if (detectMode === 'brush') drawBrushStrokes('canvas-contour');
  }

  function drawContourOverlay(canvasId, cList, highlightIdx) {
    var canvas = $(canvasId);
    canvas.width = imgW;
    canvas.height = imgH;
    var ctx = canvas.getContext('2d');

    ctx.drawImage(srcImage, 0, 0, imgW, imgH);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, imgW, imgH);

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
        if (c.isHole) {
          ctx.strokeStyle = '#2a7ad4';
          ctx.fillStyle = 'rgba(42,122,212,0.15)';
        } else {
          ctx.strokeStyle = '#d4722a';
          ctx.fillStyle = 'rgba(212,114,42,0.15)';
        }
        ctx.lineWidth = 2;
        ctx.fill();
      } else {
        ctx.strokeStyle = c.isHole ? 'rgba(100,150,220,0.6)' : 'rgba(200,200,200,0.6)';
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
  // Flood fill from borders (object detection)
  // =====================
  function detectForeground(rgba, w, h, tolerance) {
    // Classify pixels using k-means background clusters (handles mixed backgrounds)
    // Sample 5% border region, cluster into up to 5 colors, classify by min distance

    var bgSamples = sampleBorderPixels(rgba, w, h, 5);
    var nClusters = Math.min(5, Math.max(2, Math.ceil(bgSamples.length / 500)));
    var bgCenters = kMeansClusters(bgSamples, nClusters, 15);

    var fg = new Uint8Array(w * h);
    var tolSq = tolerance * tolerance;
    for (var i = 0; i < fg.length; i++) {
      var off = i * 4;
      var r = rgba[off], g = rgba[off + 1], b = rgba[off + 2];
      // Distance to nearest background cluster
      var minDist = Infinity;
      for (var c = 0; c < bgCenters.length; c++) {
        var dr = r - bgCenters[c][0], dg = g - bgCenters[c][1], db = b - bgCenters[c][2];
        var d = dr * dr + dg * dg + db * db;
        if (d < minDist) minDist = d;
      }
      if (minDist > tolSq) fg[i] = 1;
    }

    return fg;
  }

  // =====================
  // Sobel gradient (cached at image load)
  // =====================
  function computeGradient(gray, w, h) {
    var grad = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var tl = gray[(y - 1) * w + x - 1], tc = gray[(y - 1) * w + x], tr = gray[(y - 1) * w + x + 1];
        var ml = gray[y * w + x - 1],                                     mr = gray[y * w + x + 1];
        var bl = gray[(y + 1) * w + x - 1], bc = gray[(y + 1) * w + x], br = gray[(y + 1) * w + x + 1];
        var gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
        var gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
        grad[y * w + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    // Normalize to 0-255
    var maxVal = 0;
    for (var i = 0; i < grad.length; i++) {
      if (grad[i] > maxVal) maxVal = grad[i];
    }
    if (maxVal > 0) {
      var scale = 255 / maxVal;
      for (var j = 0; j < grad.length; j++) grad[j] *= scale;
    }
    return grad;
  }

  // =====================
  // K-means clustering (k-means++ init)
  // =====================
  function kMeansClusters(samples, k, maxIter) {
    var n = samples.length;
    if (n === 0) return [[128, 128, 128]];

    // k-means++ initialization
    var centers = [];
    var idx = Math.floor(Math.random() * n);
    centers.push([samples[idx][0], samples[idx][1], samples[idx][2]]);

    for (var c = 1; c < k; c++) {
      var dists = new Float32Array(n);
      var totalDist = 0;
      for (var i = 0; i < n; i++) {
        var minD = Infinity;
        for (var j = 0; j < centers.length; j++) {
          var dr = samples[i][0] - centers[j][0];
          var dg = samples[i][1] - centers[j][1];
          var db = samples[i][2] - centers[j][2];
          var d = dr * dr + dg * dg + db * db;
          if (d < minD) minD = d;
        }
        dists[i] = minD;
        totalDist += minD;
      }
      // Weighted random selection
      var threshold = Math.random() * totalDist;
      var cumulative = 0;
      var chosen = 0;
      for (var i2 = 0; i2 < n; i2++) {
        cumulative += dists[i2];
        if (cumulative >= threshold) { chosen = i2; break; }
      }
      centers.push([samples[chosen][0], samples[chosen][1], samples[chosen][2]]);
    }

    // Lloyd's iterations
    var assignments = new Int32Array(n);
    for (var iter = 0; iter < maxIter; iter++) {
      // Assign each sample to nearest center
      var changed = false;
      for (var i3 = 0; i3 < n; i3++) {
        var bestDist = Infinity, bestC = 0;
        for (var ci = 0; ci < centers.length; ci++) {
          var dr2 = samples[i3][0] - centers[ci][0];
          var dg2 = samples[i3][1] - centers[ci][1];
          var db2 = samples[i3][2] - centers[ci][2];
          var dist = dr2 * dr2 + dg2 * dg2 + db2 * db2;
          if (dist < bestDist) { bestDist = dist; bestC = ci; }
        }
        if (assignments[i3] !== bestC) { assignments[i3] = bestC; changed = true; }
      }
      if (!changed) break;

      // Recompute centers
      var sums = [];
      var counts = new Int32Array(k);
      for (var ci2 = 0; ci2 < k; ci2++) sums.push([0, 0, 0]);
      for (var i4 = 0; i4 < n; i4++) {
        var a = assignments[i4];
        sums[a][0] += samples[i4][0];
        sums[a][1] += samples[i4][1];
        sums[a][2] += samples[i4][2];
        counts[a]++;
      }
      for (var ci3 = 0; ci3 < k; ci3++) {
        if (counts[ci3] > 0) {
          centers[ci3] = [sums[ci3][0] / counts[ci3], sums[ci3][1] / counts[ci3], sums[ci3][2] / counts[ci3]];
        }
      }
    }
    return centers;
  }

  // =====================
  // Sample border pixels for k-means
  // =====================
  function sampleBorderPixels(rgba, w, h, borderPercent) {
    var bx = Math.max(1, Math.round(w * borderPercent / 100));
    var by = Math.max(1, Math.round(h * borderPercent / 100));
    var samples = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (x < bx || x >= w - bx || y < by || y >= h - by) {
          var off = (y * w + x) * 4;
          samples.push([rgba[off], rgba[off + 1], rgba[off + 2]]);
        }
      }
    }
    // Subsample if too many (cap at 5000 for speed)
    if (samples.length > 5000) {
      var step = Math.floor(samples.length / 5000);
      var sub = [];
      for (var i = 0; i < samples.length; i += step) sub.push(samples[i]);
      return sub;
    }
    return samples;
  }

  // =====================
  // Advanced foreground detection (multi-cluster)
  // =====================
  function detectForegroundAdvanced(rgba, w, h, tolerance, centers) {
    var fg = new Uint8Array(w * h);
    var tolSq = tolerance * tolerance;
    for (var i = 0; i < fg.length; i++) {
      var off = i * 4;
      var r = rgba[off], g = rgba[off + 1], b = rgba[off + 2];
      // Distance to nearest cluster center
      var minDist = Infinity;
      for (var c = 0; c < centers.length; c++) {
        var dr = r - centers[c][0], dg = g - centers[c][1], db = b - centers[c][2];
        var d = dr * dr + dg * dg + db * db;
        if (d < minDist) minDist = d;
      }
      if (minDist > tolSq) fg[i] = 1;
    }
    return fg;
  }

  // =====================
  // Edge-aware morphological operations
  // =====================
  function edgeAwareDilate(binary, w, h, radius, gradMap, edgeThreshold) {
    var out = new Uint8Array(w * h);
    var r2 = radius * radius;
    var edgeActive = edgeThreshold > 0 && gradMap;
    // Map slider 0-100 to gradient threshold (higher slider = stronger edge stopping)
    var gradThresh = edgeThreshold * 2.55;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (binary[y * w + x] === 1) {
          var y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
          var x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
          for (var ny = y0; ny <= y1; ny++) {
            for (var nx = x0; nx <= x1; nx++) {
              var dx = nx - x, dy = ny - y;
              if (dx * dx + dy * dy <= r2) {
                var ti = ny * w + nx;
                if (edgeActive && gradMap[ti] > gradThresh) continue;
                out[ti] = 1;
              }
            }
          }
        }
      }
    }
    return out;
  }

  function edgeAwareErode(binary, w, h, radius, gradMap, edgeThreshold) {
    var out = new Uint8Array(w * h);
    var r2 = radius * radius;
    var edgeActive = edgeThreshold > 0 && gradMap;
    var gradThresh = edgeThreshold * 2.55;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (binary[y * w + x] === 0) continue;
        var allSet = true;
        var y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
        var x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
        outer:
        for (var ny = y0; ny <= y1; ny++) {
          for (var nx = x0; nx <= x1; nx++) {
            var dx = nx - x, dy = ny - y;
            if (dx * dx + dy * dy <= r2) {
              var ti = ny * w + nx;
              // Skip neighbors beyond strong edges
              if (edgeActive && gradMap[ti] > gradThresh) continue;
              if (binary[ti] === 0) { allSet = false; break outer; }
            }
          }
        }
        if (allSet) out[y * w + x] = 1;
      }
    }
    return out;
  }

  // =====================
  // Morphological operations
  // =====================
  function dilate(binary, w, h, radius) {
    var out = new Uint8Array(w * h);
    var r2 = radius * radius;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (binary[y * w + x] === 1) {
          // Expand this pixel
          var y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
          var x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
          for (var ny = y0; ny <= y1; ny++) {
            for (var nx = x0; nx <= x1; nx++) {
              var dx = nx - x, dy = ny - y;
              if (dx * dx + dy * dy <= r2) out[ny * w + nx] = 1;
            }
          }
        }
      }
    }
    return out;
  }

  function erode(binary, w, h, radius) {
    var out = new Uint8Array(w * h);
    var r2 = radius * radius;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (binary[y * w + x] === 0) continue;
        var allSet = true;
        var y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
        var x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
        outer:
        for (var ny = y0; ny <= y1; ny++) {
          for (var nx = x0; nx <= x1; nx++) {
            var dx = nx - x, dy = ny - y;
            if (dx * dx + dy * dy <= r2 && binary[ny * w + nx] === 0) {
              allSet = false;
              break outer;
            }
          }
        }
        if (allSet) out[y * w + x] = 1;
      }
    }
    return out;
  }

  // =====================
  // Step 3: Select contours
  // =====================
  function setupStep3() {
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

      var bestDist = Infinity, bestIdx = -1;
      for (var i = 0; i < contours.length; i++) {
        if (pointInPolygon(mx, my, contours[i].points)) {
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
        item.className = 'contour-item' + (c.selected ? ' selected' : '') + (c.isHole ? ' hole' : '');
        var label = c.isHole ? 'H\u00e5l ' + (idx + 1) : 'Kontur ' + (idx + 1);
        item.innerHTML =
          '<input type="checkbox"' + (c.selected ? ' checked' : '') + '>' +
          '<span class="contour-info">' + label + '</span>' +
          '<span class="contour-area">' + Math.round(c.area) + ' px\u00B2 \u2022 ' + c.points.length + ' punkter</span>';
        item.addEventListener('click', function (e) {
          var newState;
          if (e.target.tagName === 'INPUT') {
            newState = e.target.checked;
          } else {
            newState = !c.selected;
          }
          c.selected = newState;
          // Toggle all direct children when toggling an outer contour
          if (!c.isHole) {
            for (var ci = 0; ci < contours.length; ci++) {
              if (contours[ci].parentIdx === idx) contours[ci].selected = newState;
            }
          }
          renderSelectStep();
        });
        list.appendChild(item);
      })(i);
    }
  }

  // =====================
  // Step 4: Calibration
  // =====================
  function setupStep4() {
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

    $('btn-skip-cal').addEventListener('click', function () {
      pixPerMm = 0;
      goToStep(5);
    });
  }

  function renderCalStep() { drawCalOverlay(); }

  function drawCalOverlay() {
    var canvas = $('canvas-cal');
    canvas.width = imgW;
    canvas.height = imgH;
    var ctx = canvas.getContext('2d');

    ctx.drawImage(srcImage, 0, 0, imgW, imgH);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, imgW, imgH);

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
  // Step 5: Export
  // =====================
  function setupStep5() {
    $('btn-download').addEventListener('click', downloadDXF);
  }

  function renderExportStep() {
    var selected = contours.filter(function (c) { return c.selected; });
    var totalPts = selected.reduce(function (s, c) { return s + c.points.length; }, 0);

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
      ctx.strokeStyle = selected[i].isHole ? '#2a5a9e' : '#6b4c2a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    var outerCount = selected.filter(function (c) { return !c.isHole; }).length;
    var holeCount = selected.filter(function (c) { return c.isHole; }).length;

    var scaleStr = pixPerMm > 0
      ? pixPerMm.toFixed(2) + ' px/mm'
      : 'Ej kalibrerad (1 px = 1 enhet)';
    var unitStr = pixPerMm > 0 ? 'mm' : 'px';

    $('export-info').innerHTML =
      '<div class="export-info-row"><span>Konturer:</span><span>' + outerCount + (holeCount > 0 ? ' + ' + holeCount + ' h\u00e5l' : '') + '</span></div>' +
      '<div class="export-info-row"><span>Totalt punkter:</span><span>' + totalPts + '</span></div>' +
      '<div class="export-info-row"><span>Skala:</span><span>' + scaleStr + '</span></div>' +
      '<div class="export-info-row"><span>Enheter i DXF:</span><span>' + unitStr + '</span></div>' +
      (holeCount > 0 ? '<div class="export-info-row" style="margin-top:0.5rem"><span>H\u00e5l exporteras p\u00e5 lager HOLES med omv\u00e4nd riktning.</span><span></span></div>' : '') +
      (pixPerMm === 0 ? '<div class="export-info-row" style="color:#9e3030;margin-top:0.5rem"><span>OBS: Utan kalibrering exporteras koordinaterna i pixlar.</span><span></span></div>' : '');
  }

  function downloadDXF() {
    var selected = contours.filter(function (c) { return c.selected; });
    if (selected.length === 0) return;

    var dxf = generateDXF(selected, pixPerMm);
    var today = new Date().toISOString().slice(0, 10);
    var filename = 'kontur_' + today + '.dxf';

    var zipBlob = createZip(filename, dxf);
    var url = URL.createObjectURL(zipBlob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'kontur_' + today + '.zip';
    a.click();
    URL.revokeObjectURL(url);
  }

  // Minimal ZIP file creator (STORE, no compression — no dependencies)
  function createZip(name, content) {
    var encoder = new TextEncoder();
    var fileData = encoder.encode(content);
    var nameData = encoder.encode(name);
    var fileLen = fileData.length;
    var nameLen = nameData.length;

    var now = new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    var crc = crc32(fileData);

    // Local file header (30 + nameLen + fileLen)
    var localHeader = new Uint8Array(30 + nameLen);
    var lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);   // signature
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 0, true);             // flags
    lv.setUint16(8, 0, true);             // compression (STORE)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, fileLen, true);      // compressed size
    lv.setUint32(22, fileLen, true);      // uncompressed size
    lv.setUint16(26, nameLen, true);
    lv.setUint16(28, 0, true);            // extra field length
    localHeader.set(nameData, 30);

    var centralOffset = 0;
    var centralStart = localHeader.length + fileLen;

    // Central directory header (46 + nameLen)
    var centralHeader = new Uint8Array(46 + nameLen);
    var cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);    // signature
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);             // flags
    cv.setUint16(10, 0, true);            // compression
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, fileLen, true);
    cv.setUint32(24, fileLen, true);
    cv.setUint16(28, nameLen, true);
    cv.setUint16(30, 0, true);            // extra
    cv.setUint16(32, 0, true);            // comment
    cv.setUint16(34, 0, true);            // disk
    cv.setUint16(36, 0, true);            // internal attr
    cv.setUint32(38, 0, true);            // external attr
    cv.setUint32(42, centralOffset, true);// local header offset
    centralHeader.set(nameData, 46);

    // End of central directory (22)
    var endRecord = new Uint8Array(22);
    var ev = new DataView(endRecord.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);             // disk
    ev.setUint16(6, 0, true);             // disk with central dir
    ev.setUint16(8, 1, true);             // entries on disk
    ev.setUint16(10, 1, true);            // total entries
    ev.setUint32(12, centralHeader.length, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true);            // comment length

    return new Blob([localHeader, fileData, centralHeader, endRecord], { type: 'application/zip' });
  }

  function crc32(data) {
    var table = crc32.table;
    if (!table) {
      table = new Uint32Array(256);
      for (var i = 0; i < 256; i++) {
        var c = i;
        for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
      }
      crc32.table = table;
    }
    var crc = 0xFFFFFFFF;
    for (var k = 0; k < data.length; k++) crc = table[(crc ^ data[k]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // =====================
  // Image processing
  // =====================
  // Smooth a binary mask: box blur (radius r, 2 passes) then re-threshold at 0.5
  // This rounds off jagged pixel-staircase edges without changing the overall shape
  function smoothBinaryMask(mask, w, h, r) {
    if (r <= 0) return mask;
    // Convert binary to float for blur
    var src = new Float32Array(w * h);
    for (var i = 0; i < mask.length; i++) src[i] = mask[i] ? 1.0 : 0.0;
    var dst = new Float32Array(w * h);
    // Two passes of box blur (approximates gaussian)
    for (var pass = 0; pass < 2; pass++) {
      // Horizontal pass
      for (var y = 0; y < h; y++) {
        var sum = 0;
        var count = 0;
        // Init window
        for (var x = 0; x <= r && x < w; x++) { sum += src[y * w + x]; count++; }
        for (var x = 0; x < w; x++) {
          dst[y * w + x] = sum / count;
          // Expand right
          var right = x + r + 1;
          if (right < w) { sum += src[y * w + right]; count++; }
          // Shrink left
          var left = x - r;
          if (left >= 0) { sum -= src[y * w + left]; count--; }
        }
      }
      // Vertical pass
      for (var x = 0; x < w; x++) {
        var sum = 0;
        var count = 0;
        for (var y = 0; y <= r && y < h; y++) { sum += dst[y * w + x]; count++; }
        for (var y = 0; y < h; y++) {
          src[y * w + x] = sum / count;
          var bottom = y + r + 1;
          if (bottom < h) { sum += dst[bottom * w + x]; count++; }
          var top = y - r;
          if (top >= 0) { sum -= dst[top * w + x]; count--; }
        }
      }
    }
    // Re-threshold
    var out = new Uint8Array(w * h);
    for (var i = 0; i < out.length; i++) {
      if (src[i] > 0.5) out[i] = 1;
    }
    return out;
  }

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

  function thresholdBinary(data, w, h, thresh, invert) {
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
          if (sk0 === endKey) { chain.push(seg[1]); used[idx] = 1; extended = true; break; }
          else if (sk1 === endKey) { chain.push(seg[0]); used[idx] = 1; extended = true; break; }
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
          if (sk0b === startKey) { chain.unshift(seg2[1]); used[idx2] = 1; extended = true; break; }
          else if (sk1b === startKey) { chain.unshift(seg2[0]); used[idx2] = 1; extended = true; break; }
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
  // Contour hierarchy (hole detection)
  // =====================
  function buildContourHierarchy(cList) {
    // cList must be sorted by area descending (largest first).
    // A contour whose first point is inside a larger contour is a child.
    // Depth toggles: outer(0) → hole(1) → island(2) → hole(3) → ...
    for (var i = 0; i < cList.length; i++) {
      cList[i].isHole = false;
      cList[i].parentIdx = -1;
    }
    for (var i = 1; i < cList.length; i++) {
      var testPt = cList[i].points[0];
      // Find smallest enclosing contour (nearest parent by area)
      for (var j = i - 1; j >= 0; j--) {
        if (pointInPolygon(testPt.x, testPt.y, cList[j].points)) {
          cList[i].parentIdx = j;
          break;
        }
      }
      // Compute depth to determine hole vs island
      var depth = 0;
      var pi = cList[i].parentIdx;
      while (pi >= 0) {
        depth++;
        pi = cList[pi].parentIdx;
      }
      cList[i].isHole = (depth % 2 === 1);
    }
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
    }
    return [first, last];
  }

  function perpDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((p.x - a.x) * (p.x - a.x) + (p.y - a.y) * (p.y - a.y));
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(lenSq);
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
  // Brush-assisted foreground detection
  // =====================
  function detectForegroundBrush(rgba, w, h, bMask, bgCenters, fgCenters) {
    var fg = new Uint8Array(w * h);
    for (var i = 0; i < fg.length; i++) {
      // Brushed pixels are always foreground
      if (bMask[i]) { fg[i] = 1; continue; }
      var off = i * 4;
      var r = rgba[off], g = rgba[off + 1], b = rgba[off + 2];
      // Distance to nearest background cluster (squared, faster)
      var minBgSq = Infinity;
      for (var c = 0; c < bgCenters.length; c++) {
        var dr = r - bgCenters[c][0], dg = g - bgCenters[c][1], db = b - bgCenters[c][2];
        var d = dr * dr + dg * dg + db * db;
        if (d < minBgSq) minBgSq = d;
      }
      // Distance to nearest foreground cluster (squared)
      var minFgSq = Infinity;
      for (var f = 0; f < fgCenters.length; f++) {
        var dr2 = r - fgCenters[f][0], dg2 = g - fgCenters[f][1], db2 = b - fgCenters[f][2];
        var d2 = dr2 * dr2 + dg2 * dg2 + db2 * db2;
        if (d2 < minFgSq) minFgSq = d2;
      }
      // Classify: foreground if closer to fg clusters (using squared distances to avoid sqrt)
      // Threshold 0.5 = neutral boundary, pixel must be closer to fg than bg
      if (minFgSq < minBgSq) fg[i] = 1;
    }
    return fg;
  }

  function brushCircle(mask, w, h, cx, cy, r) {
    var r2 = r * r;
    var x0 = Math.max(0, Math.floor(cx - r));
    var x1 = Math.min(w - 1, Math.ceil(cx + r));
    var y0 = Math.max(0, Math.floor(cy - r));
    var y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) mask[y * w + x] = 1;
      }
    }
  }

  function brushLine(mask, w, h, x0, y0, x1, y1, r) {
    var dx = x1 - x0, dy = y1 - y0;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.max(1, Math.ceil(dist / Math.max(1, r * 0.5)));
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      brushCircle(mask, w, h, x0 + dx * t, y0 + dy * t, r);
    }
  }

  function drawBrushStrokes(canvasId) {
    if (brushStrokes.length === 0) return;
    var canvas = $(canvasId);
    var ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var s = 0; s < brushStrokes.length; s++) {
      var stroke = brushStrokes[s];
      var strokeR = stroke[0].r || 10;
      ctx.strokeStyle = 'rgba(50,205,50,0.35)';
      ctx.lineWidth = strokeR * 2;
      if (stroke.length < 2) {
        ctx.beginPath();
        ctx.arc(stroke[0].x, stroke[0].y, strokeR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(50,205,50,0.35)';
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (var p = 1; p < stroke.length; p++) {
        ctx.lineTo(stroke[p].x, stroke[p].y);
      }
      ctx.stroke();
    }
  }

  // =====================
  // Arc fitting: convert point sequences to arcs where possible
  // =====================

  // Remove collinear points (angle deviation < threshold in radians)
  function removeCollinear(pts, threshold) {
    if (pts.length <= 3) return pts;
    if (!threshold) threshold = 0.02; // ~1 degree
    var out = [];
    var n = pts.length;
    for (var i = 0; i < n; i++) {
      var prev = pts[(i - 1 + n) % n];
      var curr = pts[i];
      var next = pts[(i + 1) % n];
      var dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
      var dx2 = next.x - curr.x, dy2 = next.y - curr.y;
      var cross = Math.abs(dx1 * dy2 - dy1 * dx2);
      var dot = dx1 * dx2 + dy1 * dy2;
      var len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      var len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if (len1 < 1e-9 || len2 < 1e-9) continue; // degenerate
      var sinAngle = cross / (len1 * len2);
      if (sinAngle > threshold || dot < 0) {
        out.push(curr); // significant bend — keep
      }
      // else: nearly collinear — skip
    }
    return out.length >= 3 ? out : pts;
  }

  // Fit circle through 3 points, returns {cx, cy, r} or null
  function circleFrom3(p1, p2, p3) {
    var ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
    var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-10) return null; // collinear
    var ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    var uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    var dx = ax - ux, dy = ay - uy;
    return { cx: ux, cy: uy, r: Math.sqrt(dx * dx + dy * dy) };
  }

  // Calculate bulge for arc from p1 to p2 through circle {cx, cy, r}
  // Bulge = tan(included_angle / 4), sign indicates direction
  function calcBulge(p1, p2, circle) {
    var dx1 = p1.x - circle.cx, dy1 = p1.y - circle.cy;
    var dx2 = p2.x - circle.cx, dy2 = p2.y - circle.cy;
    // Signed angle from p1 to p2 around center
    var angle = Math.atan2(dx1 * dy2 - dy1 * dx2, dx1 * dx2 + dy1 * dy2);
    return Math.tan(angle / 4);
  }

  // Fit arcs to a closed polygon. Returns array of {x, y, bulge} vertices.
  // tolerance = max deviation from arc in same units as points (pixels or mm)
  function fitArcs(pts, tolerance) {
    if (!tolerance) tolerance = 0.8; // pixels
    var n = pts.length;
    if (n <= 3) {
      var out = [];
      for (var i = 0; i < n; i++) out.push({ x: pts[i].x, y: pts[i].y, bulge: 0 });
      return out;
    }

    var result = [];
    var i = 0;
    var maxR = 1e6; // ignore arcs with huge radius (nearly straight)
    var maxSpan = Math.min(n - 1, Math.floor(n / 2)); // never span more than half the polygon

    while (i < n) {
      var bestSpan = 0;
      var bestCircle = null;

      // Extend arc window as far as possible (only forward, no wrap-around)
      // Start at span=4: need enough intermediate points not on the defining circle
      for (var span = 4; span <= maxSpan; span++) {
        var endIdx = i + span;
        if (endIdx >= n) break; // don't wrap around

        var midIdx = i + Math.floor(span / 2);
        var circ = circleFrom3(pts[i], pts[midIdx], pts[endIdx]);
        if (!circ || circ.r > maxR) break;

        // Check all intermediate points against the circle
        var ok = true;
        for (var k = i + 1; k < endIdx; k++) {
          var dx = pts[k].x - circ.cx, dy = pts[k].y - circ.cy;
          var dist = Math.abs(Math.sqrt(dx * dx + dy * dy) - circ.r);
          if (dist > tolerance) { ok = false; break; }
        }
        if (!ok) break;

        bestSpan = span;
        bestCircle = circ;
      }

      if (bestSpan >= 4 && bestCircle) {
        var bulge = calcBulge(pts[i], pts[i + bestSpan], bestCircle);
        result.push({ x: pts[i].x, y: pts[i].y, bulge: bulge });
        i += bestSpan; // advance to end of arc (it becomes next start)
      } else {
        result.push({ x: pts[i].x, y: pts[i].y, bulge: 0 });
        i++;
      }
    }

    return result;
  }

  // =====================
  // DXF R12 generation (LWPOLYLINE with bulge for arcs)
  // =====================
  function generateDXF(selected, ppm) {
    var scale = ppm > 0 ? (1 / ppm) : 1;
    var arcTol = ppm > 0 ? 0.3 : 0.8; // 0.3mm or 0.8px
    var lines = [];

    lines.push('0', 'SECTION', '2', 'HEADER');
    lines.push('9', '$INSUNITS', '70', ppm > 0 ? '4' : '0');
    lines.push('0', 'ENDSEC');
    lines.push('0', 'SECTION', '2', 'ENTITIES');

    for (var i = 0; i < selected.length; i++) {
      var c = selected[i];
      var pts = c.points.slice();
      // DXF Y-flip inverts winding: image CW → DXF CCW, image CCW → DXF CW
      var a = contourArea(pts);
      if (!c.isHole && a < 0) pts.reverse();
      if (c.isHole && a > 0) pts.reverse();

      // Clean up: remove collinear nodes, then fit arcs
      pts = removeCollinear(pts);
      var verts = fitArcs(pts, arcTol);

      var layer = c.isHole ? 'HOLES' : '0';
      // LWPOLYLINE: modern, compact, supports bulge per vertex
      lines.push('0', 'LWPOLYLINE');
      lines.push('8', layer);
      lines.push('90', String(verts.length)); // vertex count
      lines.push('70', '1'); // closed polyline

      for (var j = 0; j < verts.length; j++) {
        lines.push('10', (verts[j].x * scale).toFixed(4));
        lines.push('20', (-verts[j].y * scale).toFixed(4));
        if (Math.abs(verts[j].bulge) > 1e-6) {
          // Y-flip inverts arc direction
          lines.push('42', (-verts[j].bulge).toFixed(6));
        }
      }
    }

    lines.push('0', 'ENDSEC', '0', 'EOF');
    return lines.join('\n');
  }

})();
