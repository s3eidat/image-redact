/* Image Redact — covers are burned into a freshly drawn canvas and re-encoded locally. Nothing is uploaded. */
(function () {
  "use strict";
  const $ = S3.$, $$ = S3.$$;
  const saved = S3.store("redact") || {};
  const st = {
    tool: saved.tool === "free" ? "free" : "rect", style: ["black", "color", "pixelate", "blur"].indexOf(saved.style) >= 0 ? saved.style : "black",
    color: saved.color || "#ffffff", brush: saved.brush || 24, fmt: saved.fmt === "jpeg" ? "jpeg" : "png",
    img: null, name: "image", shapes: [], sel: null, undo: []
  };
  function save() { S3.store("redact", { tool: st.tool, style: st.style, color: st.color, brush: st.brush, fmt: st.fmt }); }
  function canvas(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; }

  // ---------- effects (pure; image-pixel units scaled by `k`) ----------
  function effectSizes(W, H) { const L = Math.max(W, H); return { block: Math.max(8, Math.round(L / 90)), radius: Math.max(6, Math.round(L / 120)) }; }
  // flat average colour per block, on a grid anchored at the region's top-left corner
  function pixelate(src, x, y, w, h, block) {
    const d = src.getContext("2d").getImageData(x, y, w, h), p = d.data;
    for (let by = 0; by < h; by += block) for (let bx = 0; bx < w; bx += block) {
      const ex = Math.min(w, bx + block), ey = Math.min(h, by + block);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = by; yy < ey; yy++) for (let xx = bx; xx < ex; xx++) { const i = (yy * w + xx) * 4; r += p[i]; g += p[i + 1]; b += p[i + 2]; a += p[i + 3]; n++; }
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n); a = Math.round(a / n);
      for (let yy = by; yy < ey; yy++) for (let xx = bx; xx < ex; xx++) { const i = (yy * w + xx) * 4; p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = a; }
    }
    const out = canvas(w, h); out.getContext("2d").putImageData(d, 0, 0);
    return out;
  }
  // three box-blur passes ≈ gaussian; works in every browser (no ctx.filter needed)
  function blur(src, x, y, w, h, r) {
    const pad = r * 3, X = Math.max(0, x - pad), Y = Math.max(0, y - pad);
    const X2 = Math.min(src.width, x + w + pad), Y2 = Math.min(src.height, y + h + pad), W = X2 - X, H = Y2 - Y;
    const tmp = canvas(W, H), t = tmp.getContext("2d");
    t.drawImage(src, X, Y, W, H, 0, 0, W, H);
    const img = t.getImageData(0, 0, W, H), a = img.data, b = new Uint8ClampedArray(a.length);
    function pass(from, to, horiz) {
      const n = horiz ? W : H, m = horiz ? H : W, step = horiz ? 4 : W * 4, line = horiz ? W * 4 : 4, win = r * 2 + 1;
      for (let l = 0; l < m; l++) {
        const base = l * line;
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let k = -r; k <= r; k++) sum += from[base + Math.min(n - 1, Math.max(0, k)) * step + c];
          for (let i = 0; i < n; i++) {
            to[base + i * step + c] = sum / win;
            sum += from[base + Math.min(n - 1, i + r + 1) * step + c] - from[base + Math.max(0, i - r) * step + c];
          }
        }
      }
    }
    for (let k = 0; k < 3; k++) { pass(a, b, true); pass(b, a, false); }
    t.putImageData(img, 0, 0);
    const out = canvas(w, h);
    out.getContext("2d").drawImage(tmp, x - X, y - Y, w, h, 0, 0, w, h);
    return out;
  }
  function bounds(s) {
    if (s.type === "rect") return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    s.pts.forEach(p => { x1 = Math.min(x1, p[0]); y1 = Math.min(y1, p[1]); x2 = Math.max(x2, p[0]); y2 = Math.max(y2, p[1]); });
    const r = s.size / 2;
    return { x: x1 - r, y: y1 - r, w: x2 - x1 + s.size, h: y2 - y1 + s.size };
  }
  function tracePath(c, s, k, ox, oy) {
    c.beginPath();
    s.pts.forEach((p, i) => { const X = p[0] * k - ox, Y = p[1] * k - oy; if (i) c.lineTo(X, Y); else c.moveTo(X, Y); });
    if (s.pts.length === 1) c.lineTo(s.pts[0][0] * k - ox + 0.01, s.pts[0][1] * k - oy);
  }
  // Burn all shapes into ctx, whose content is the image drawn at scale k (canvas = image * k).
  function burn(ctx, shapes, k, W, H) {
    const fx = effectSizes(W, H), cv = ctx.canvas;
    shapes.forEach(s => {
      const b = bounds(s);
      const x = Math.max(0, Math.floor(b.x * k)), y = Math.max(0, Math.floor(b.y * k));
      const x2 = Math.min(cv.width, Math.ceil((b.x + b.w) * k)), y2 = Math.min(cv.height, Math.ceil((b.y + b.h) * k)), w = x2 - x, h = y2 - y;
      if (w <= 0 || h <= 0) return;
      if (s.style === "black" || s.style === "color") {
        ctx.save(); ctx.fillStyle = ctx.strokeStyle = s.style === "black" ? "#000000" : s.color;
        if (s.type === "rect") ctx.fillRect(x, y, w, h);
        else { ctx.lineWidth = s.size * k; ctx.lineCap = ctx.lineJoin = "round"; tracePath(ctx, s, k, 0, 0); ctx.stroke(); }
        ctx.restore(); return;
      }
      const eff = s.style === "pixelate" ? pixelate(cv, x, y, w, h, Math.max(2, Math.round(fx.block * k))) : blur(cv, x, y, w, h, Math.max(1, Math.round(fx.radius * k)));
      if (s.type === "free") {
        const e = eff.getContext("2d");
        e.globalCompositeOperation = "destination-in"; e.lineWidth = s.size * k; e.lineCap = e.lineJoin = "round"; e.strokeStyle = "#000";
        tracePath(e, s, k, x, y); e.stroke();
      }
      ctx.drawImage(eff, x, y);
    });
  }
  function exportCanvas(img, shapes) {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height, c = canvas(W, H), x = c.getContext("2d");
    x.drawImage(img, 0, 0, W, H);
    burn(x, shapes, 1, W, H);
    return c;
  }
  function toBlob(c, type) {
    return new Promise((res, rej) => {
      let src = c;
      if (type === "image/jpeg") { src = canvas(c.width, c.height); const x = src.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(c, 0, 0); }
      src.toBlob(b => b ? res(b) : rej(new Error("Could not encode the image (too large?)")), type, 0.92);
    });
  }

  // ---------- stage ----------
  const stage = $("#stage"), wrap = $("#stageWrap");
  let view = null, base = null; // view: {k (image->canvas px), dpr}; base: image drawn at view scale
  function layout() {
    if (!st.img) { stage.width = stage.height = 0; stage.style.width = stage.style.height = "0"; view = null; return; }
    const W = st.img.naturalWidth, H = st.img.naturalHeight, cw = Math.max(200, wrap.clientWidth - 2), maxH = Math.max(320, window.innerHeight * 0.7);
    const s = Math.min(cw / W, maxH / H, 1.5), dpr = window.devicePixelRatio || 1;
    const cssW = Math.round(W * s), cssH = Math.round(H * s);
    stage.style.width = cssW + "px"; stage.style.height = cssH + "px";
    stage.width = Math.round(cssW * dpr); stage.height = Math.round(cssH * dpr);
    view = { k: stage.width / W, css: s };
    base = canvas(stage.width, stage.height);
    const b = base.getContext("2d"); b.imageSmoothingQuality = "high"; b.drawImage(st.img, 0, 0, stage.width, stage.height);
    draw();
  }
  function draw(live) {
    if (!view) return;
    const x = stage.getContext("2d"), k = view.k;
    x.clearRect(0, 0, stage.width, stage.height);
    x.drawImage(base, 0, 0);
    burn(x, live ? st.shapes.concat([live]) : st.shapes, k, st.img.naturalWidth, st.img.naturalHeight);
    // outlines for non-solid covers (so they're visible while editing) + selection
    const dpr = stage.width / parseFloat(stage.style.width);
    st.shapes.concat(live ? [live] : []).forEach(s => {
      const b = bounds(s), sel = s === st.sel;
      if (!sel && s.style !== "pixelate" && s.style !== "blur") return;
      x.save();
      x.setLineDash(sel ? [] : [4 * dpr, 4 * dpr]); x.lineWidth = (sel ? 2 : 1) * dpr;
      x.strokeStyle = sel ? "#3dd6d0" : "rgba(255,255,255,.7)";
      x.strokeRect(b.x * k, b.y * k, b.w * k, b.h * k);
      if (sel && s.type === "rect") {
        x.fillStyle = "#3dd6d0"; x.strokeStyle = "#04201f"; x.lineWidth = dpr;
        corners(s).forEach(p => { const hs = 5 * dpr; x.fillRect(p[0] * k - hs, p[1] * k - hs, hs * 2, hs * 2); x.strokeRect(p[0] * k - hs, p[1] * k - hs, hs * 2, hs * 2); });
      }
      x.restore();
    });
  }
  function corners(s) { const b = bounds(s); return [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]; }
  function toImg(e) { const r = stage.getBoundingClientRect(); return [(e.clientX - r.left) / view.css, (e.clientY - r.top) / view.css]; }
  function hitShape(p) {
    for (let i = st.shapes.length - 1; i >= 0; i--) {
      const s = st.shapes[i], b = bounds(s);
      if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) {
        if (s.type === "rect") return s;
        const r2 = (s.size / 2 + 4 / view.css) ** 2;
        if (s.pts.some(q => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 <= r2)) return s;
      }
    }
    return null;
  }
  function hitHandle(p) {
    if (!st.sel || st.sel.type !== "rect") return -1;
    const tol = 9 / view.css;
    return corners(st.sel).findIndex(c => Math.abs(c[0] - p[0]) <= tol && Math.abs(c[1] - p[1]) <= tol);
  }

  function snapshot() { st.undo.push(JSON.stringify(st.shapes)); if (st.undo.length > 100) st.undo.shift(); }
  function doUndo() {
    if (!st.undo.length) return;
    st.shapes = JSON.parse(st.undo.pop()); st.sel = null; ui(); draw();
  }
  function ui() {
    $("#undo").disabled = !st.undo.length; $("#del").disabled = !st.sel; $("#clearAll").disabled = !st.shapes.length;
    $("#save").disabled = $("#copy").disabled = !st.img;
    $("#warn").hidden = !(st.style === "pixelate" || st.style === "blur" || st.shapes.some(s => s.style === "pixelate" || s.style === "blur"));
    const shown = st.sel ? st.sel.style : st.style;
    press($("#style"), shown);
    if (st.sel && st.sel.style === "color") $("#color").value = st.sel.color; else $("#color").value = st.color;
    $("#colorWrap").hidden = shown !== "color";
    $("#brushWrap").hidden = st.tool !== "free";
    if (st.img) $("#meta").textContent = st.name + " · " + st.img.naturalWidth + "×" + st.img.naturalHeight + " · " + st.shapes.length + (st.shapes.length === 1 ? " cover" : " covers");
  }

  let drag = null;
  stage.addEventListener("pointerdown", e => {
    if (!view || e.button > 0) return;
    stage.focus({ preventScroll: true });
    stage.setPointerCapture(e.pointerId);
    const p = toImg(e), h = hitHandle(p);
    if (h >= 0) { snapshot(); const b = bounds(st.sel); const opp = [[b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [b.x + b.w, b.y], [b.x, b.y]][h]; drag = { kind: "resize", opp }; return; }
    if (st.tool === "rect") {
      const hit = hitShape(p);
      if (hit) { snapshot(); select(hit); drag = { kind: "move", last: p, moved: false }; ui(); draw(); return; }
      drag = { kind: "new", live: { type: "rect", x: p[0], y: p[1], w: 0, h: 0, style: st.style, color: st.color } };
    } else {
      drag = { kind: "new", live: { type: "free", pts: [p], size: st.brush / view.css, style: st.style, color: st.color } };
    }
    st.sel = null; ui(); draw(drag.live);
  });
  stage.addEventListener("pointermove", e => {
    if (!view) return;
    const p = toImg(e);
    if (!drag) { stage.style.cursor = hitHandle(p) >= 0 ? "nwse-resize" : st.tool === "rect" && hitShape(p) ? "move" : "crosshair"; return; }
    const W = st.img.naturalWidth, H = st.img.naturalHeight, cx = Math.max(0, Math.min(W, p[0])), cy = Math.max(0, Math.min(H, p[1]));
    if (drag.kind === "new") {
      const L = drag.live;
      if (L.type === "rect") { L.w = cx - L.x; L.h = cy - L.y; } else L.pts.push([p[0], p[1]]);
      draw(L);
    } else if (drag.kind === "move") {
      const dx = p[0] - drag.last[0], dy = p[1] - drag.last[1]; drag.last = p; drag.moved = true;
      moveShape(st.sel, dx, dy); draw();
    } else if (drag.kind === "resize") {
      const o = drag.opp, s = st.sel;
      s.x = Math.min(o[0], cx); s.y = Math.min(o[1], cy); s.w = Math.abs(cx - o[0]); s.h = Math.abs(cy - o[1]); draw();
    }
  });
  // selecting a cover shows its style in the toolbar; new covers keep the style you picked yourself
  function select(s) { st.sel = s; }
  function moveShape(s, dx, dy) { if (s.type === "rect") { s.x += dx; s.y += dy; } else s.pts.forEach(q => { q[0] += dx; q[1] += dy; }); }
  function endDrag() {
    if (!drag) return;
    if (drag.kind === "new") {
      const L = drag.live, b = bounds(L);
      if (L.type === "rect") { L.x = b.x; L.y = b.y; L.w = b.w; L.h = b.h; }
      const tiny = L.type === "rect" ? b.w * view.css < 4 || b.h * view.css < 4 : false;
      if (!tiny) { snapshot(); st.shapes.push(L); st.sel = L; }
    } else if (drag.kind === "move" && !drag.moved) st.undo.pop();
    drag = null; ui(); draw();
  }
  stage.addEventListener("pointerup", endDrag); stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("keydown", e => {
    if ((e.key === "Delete" || e.key === "Backspace") && st.sel) { e.preventDefault(); removeSel(); return; }
    if (e.key === "Escape") { st.sel = null; ui(); draw(); return; }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (d && st.sel) { e.preventDefault(); const m = e.shiftKey ? 10 : 1; snapshot(); moveShape(st.sel, d[0] * m, d[1] * m); draw(); ui(); }
  });
  document.addEventListener("keydown", e => {
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "b" || e.key === "f")) pickTool(e.key === "b" ? "rect" : "free");
  });
  function removeSel() { if (!st.sel) return; snapshot(); st.shapes = st.shapes.filter(s => s !== st.sel); st.sel = null; ui(); draw(); }

  // ---------- controls ----------
  function seg(el, value, onPick) {
    $$("button", el).forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.v === value));
      b.addEventListener("click", () => onPick(b.dataset.v));
    });
  }
  function press(el, v) { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x.dataset.v === v))); }
  function pickTool(v) { st.tool = v; press($("#tool"), v); save(); ui(); }
  function pickStyle(v) {
    st.style = v; press($("#style"), v); save();
    if (st.sel) { snapshot(); st.sel.style = v; st.sel.color = st.color; draw(); }
    ui();
  }
  seg($("#tool"), st.tool, pickTool);
  seg($("#style"), st.style, pickStyle);
  seg($("#fmt"), st.fmt, v => { st.fmt = v; press($("#fmt"), v); save(); });
  $("#color").value = st.color;
  $("#color").addEventListener("input", e => { st.color = e.target.value; save(); if (st.sel && st.sel.style === "color") { st.sel.color = st.color; draw(); } });
  $("#brush").value = st.brush; $("#brushV").textContent = st.brush;
  $("#brush").addEventListener("input", e => { st.brush = +e.target.value; $("#brushV").textContent = st.brush; save(); });
  $("#undo").addEventListener("click", doUndo);
  $("#del").addEventListener("click", removeSel);
  $("#clearAll").addEventListener("click", () => { if (!st.shapes.length) return; snapshot(); st.shapes = []; st.sel = null; ui(); draw(); });

  function loadImage(blob) {
    const url = URL.createObjectURL(blob), img = new Image();
    img.src = url;
    return img.decode().then(() => img).catch(() => { URL.revokeObjectURL(url); throw new Error("Can't read this image"); });
  }
  async function useFile(file) {
    try {
      const img = await loadImage(file);
      if (st.img && st.img.src.indexOf("blob:") === 0) URL.revokeObjectURL(st.img.src);
      st.img = img; st.name = (file.name || "image").replace(/\.[^.]+$/, "") || "image";
      st.shapes = []; st.sel = null; st.undo = [];
      $("#drop").hidden = true; wrap.classList.add("has-img");
      layout(); ui();
    } catch (e) { S3.toast(e.message, "error"); }
  }
  S3.drop($("#drop"), fs => useFile(fs[0]), { accept: "image/*", multiple: false });
  $("#open input").addEventListener("change", e => { const f = e.target.files[0]; if (f) useFile(f); e.target.value = ""; });
  document.addEventListener("paste", e => {
    const f = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(x => /^image\//.test(x.type))[0];
    if (f) { e.preventDefault(); useFile(f.name && f.name !== "image.png" ? f : new File([f], "screenshot.png", { type: f.type })); }
  });
  wrap.addEventListener("dragover", e => { if (st.img) e.preventDefault(); });
  wrap.addEventListener("drop", e => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (st.img && f && /^image\//.test(f.type)) { e.preventDefault(); useFile(f); } });

  $("#save").addEventListener("click", async () => {
    if (!st.img) return;
    const type = st.fmt === "jpeg" ? "image/jpeg" : "image/png";
    try {
      const b = await toBlob(exportCanvas(st.img, st.shapes), type);
      S3.download(b, st.name + "-redacted." + (type === "image/png" ? "png" : "jpg")); S3.done();
    } catch (e) { S3.toast(e.message, "error"); }
  });
  $("#copy").addEventListener("click", async () => {
    if (!st.img) return;
    try {
      const b = await toBlob(exportCanvas(st.img, st.shapes), "image/png");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
      S3.toast("Redacted image copied ✓"); S3.done();
    } catch (e) { S3.toast("Your browser blocked copying images. Use Save instead.", "error"); }
  });
  if (window.ResizeObserver) new ResizeObserver(S3.debounce(layout, 80)).observe(wrap);
  else window.addEventListener("resize", S3.debounce(layout, 100));
  ui();

  // ---------- sample: a made-up screenshot (no real data) ----------
  function sampleShot() {
    const W = 1100, H = 640, c = canvas(W, H), x = c.getContext("2d");
    x.fillStyle = "#f4f6f9"; x.fillRect(0, 0, W, H);
    x.fillStyle = "#1f2a44"; x.fillRect(0, 0, W, 64);
    x.fillStyle = "#fff"; x.font = "600 24px Inter, Arial, sans-serif"; x.fillText("Order #20417 · Confirmation", 32, 41);
    x.fillStyle = "#ffffff"; x.fillRect(32, 96, W - 64, 500);
    x.strokeStyle = "#dde2ea"; x.strokeRect(32.5, 96.5, W - 65, 499);
    x.fillStyle = "#c7d2e3"; x.beginPath(); x.arc(110, 180, 46, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#8193b2"; x.beginPath(); x.arc(110, 168, 18, 0, Math.PI * 2); x.fill(); x.beginPath(); x.ellipse(110, 212, 30, 18, 0, Math.PI, 0); x.fill();
    const rows = [["Name", "Sara Example"], ["Email", "sara.example@example.com"], ["Phone", "+962 7 9000 0000"], ["Card", "•••• •••• •••• 4242"], ["Address", "12 Sample Street, Amman"]];
    rows.forEach((r, i) => {
      const y = 290 + i * 56;
      x.fillStyle = "#6b7685"; x.font = "500 18px Inter, Arial, sans-serif"; x.fillText(r[0], 72, y);
      x.fillStyle = "#151b26"; x.font = "600 22px Inter, Arial, sans-serif"; x.fillText(r[1], 240, y);
    });
    x.fillStyle = "#151b26"; x.font = "700 26px Inter, Arial, sans-serif"; x.fillText("Sara Example", 180, 172);
    x.fillStyle = "#6b7685"; x.font = "500 18px Inter, Arial, sans-serif"; x.fillText("Customer since 2021", 180, 202);
    x.fillStyle = "#0e9f9a"; x.fillRect(W - 280, 140, 200, 52);
    x.fillStyle = "#fff"; x.font = "600 20px Inter, Arial, sans-serif"; x.fillText("Track parcel", W - 245, 173);
    return c;
  }
  async function loadSample() {
    const b = await toBlob(sampleShot(), "image/png");
    await useFile(new File([b], "order-confirmation.png", { type: "image/png" }));
  }

  window.S3_DEMO = async function () {
    await loadSample();
    st.shapes = [
      { type: "rect", x: 228, y: 266, w: 260, h: 32, style: "black", color: "#000" },
      { type: "rect", x: 228, y: 322, w: 330, h: 32, style: "black", color: "#000" },
      { type: "rect", x: 228, y: 378, w: 230, h: 32, style: "pixelate", color: "#000" },
      { type: "rect", x: 60, y: 130, w: 100, h: 100, style: "blur", color: "#000" },
      { type: "free", pts: [[235, 505], [300, 500], [380, 507], [470, 503], [520, 506]], size: 30, style: "black", color: "#000" }
    ];
    select(st.shapes[2]); ui(); draw();
  };

  // Self-test run by scripts/smoke.py: export for real, decode the file, inspect pixels.
  window.S3_SELFTEST = async function () {
    // busy random-colour image, so "unchanged" and "replaced" are easy to tell apart
    const W = 240, H = 160, src = canvas(W, H), sx = src.getContext("2d"), d = sx.createImageData(W, H);
    let seed = 42;
    for (let i = 0; i < d.data.length; i += 4) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d.data[i] = 30 + seed % 200; d.data[i + 1] = 30 + (seed >> 8) % 200; d.data[i + 2] = 30 + (seed >> 16) % 200; d.data[i + 3] = 255; }
    sx.putImageData(d, 0, 0);
    const srcPx = sx.getImageData(0, 0, W, H).data;
    const img = await loadImage(await toBlob(src, "image/png"));
    const shapes = [
      { type: "rect", x: 10, y: 12, w: 50, h: 30, style: "black" },
      { type: "rect", x: 100, y: 20, w: 40, h: 40, style: "color", color: "#ff0000" },
      { type: "rect", x: 160, y: 80, w: 64, h: 48, style: "pixelate" },
      { type: "rect", x: 20, y: 90, w: 60, h: 50, style: "blur" },
      { type: "free", pts: [[100, 120], [140, 120]], size: 10, style: "black" }
    ];
    async function decoded(type) {
      const b = await toBlob(exportCanvas(img, shapes), type), im = await loadImage(b), c = canvas(im.naturalWidth, im.naturalHeight), x = c.getContext("2d");
      x.drawImage(im, 0, 0);
      return { w: im.naturalWidth, h: im.naturalHeight, px: x.getImageData(0, 0, im.naturalWidth, im.naturalHeight).data, type: b.type };
    }
    const png = await decoded("image/png"), at = (o, X, Y) => o.px.subarray((Y * W + X) * 4, (Y * W + X) * 4 + 4);
    // 1) every pixel under the black box is pure black, in the exported PNG
    let allBlack = true;
    for (let y = 12; y < 42; y++) for (let x = 10; x < 60; x++) { const p = at(png, x, y); if (p[0] || p[1] || p[2] || p[3] !== 255) allBlack = false; }
    // 2) right outside the box: original pixels untouched; colour box exact; freehand line black on its centre
    const same = (X, Y) => { const p = at(png, X, Y), i = (Y * W + X) * 4; return p[0] === srcPx[i] && p[1] === srcPx[i + 1] && p[2] === srcPx[i + 2]; };
    const outsideOk = same(9, 20) && same(60, 20) && same(30, 11) && same(30, 42) && same(200, 10);
    const red = at(png, 120, 40), line = at(png, 120, 120);
    const ok2 = outsideOk && red[0] === 255 && red[1] === 0 && red[2] === 0 && !line[0] && !line[1] && !line[2] && png.w === W && png.h === H && png.type === "image/png";
    // 3) pixelate: flat blocks, none equal to the original; blur: changed and smoother than the original
    const blk = effectSizes(W, H).block;
    let flat = true, changed = 0;
    for (let y = 80; y < 80 + blk; y++) for (let x = 160; x < 160 + blk; x++) { const p = at(png, x, y), q = at(png, 160, 80); if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2]) flat = false; }
    let dOrig = 0, dBlur = 0;
    for (let y = 100; y < 130; y++) for (let x = 30; x < 70; x++) {
      if (!same(x, y)) changed++;
      const i = (y * W + x) * 4; dOrig += Math.abs(srcPx[i] - srcPx[i + 4]); dBlur += Math.abs(at(png, x, y)[0] - at(png, x + 1, y)[0]);
    }
    const ok3 = flat && changed > 1100 && dBlur * 4 < dOrig;
    // 4) JPEG export: still black inside the box (lossy: near-black, edges can bleed a little)
    const jpg = await decoded("image/jpeg");
    let jMax = 0;
    for (let y = 20; y < 34; y++) for (let x = 18; x < 52; x++) { const p = at(jpg, x, y); jMax = Math.max(jMax, p[0], p[1], p[2]); }
    const ok4 = jpg.type === "image/jpeg" && jMax <= 12;
    return (allBlack && ok2 && ok3 && ok4) || { allBlack, ok2, ok3, ok4, outsideOk, red: [].slice.call(red), line: [].slice.call(line), flat, changed, dOrig, dBlur, jMax };
  };
})();
