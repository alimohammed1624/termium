// Headless Chromium never paints native <select> popups, so a page's
// dropdowns would open invisibly. This script (injected into every page in
// an isolated world) replaces the popup with an in-page menu that the
// screencast does capture, driven by the same mouse and keys. Styles are
// set through the CSSOM (element.style), which a page's Content-Security-
// Policy can't block, unlike a <style> element.

export const SELECT_POPUP = String.raw`(() => {
  if (window.__termiumSelectPopup) return;
  window.__termiumSelectPopup = true;
  let host = null, cleanup = null;
  // Keys the menu consumed: hide their keyup from the page too.
  const swallowUp = new Set();
  addEventListener("keyup", (e) => {
    if (swallowUp.delete(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  const close = () => { if (cleanup) cleanup(); cleanup = null; if (host) host.remove(); host = null; };
  const choose = (sel, index) => {
    close();
    if (index >= 0 && sel.selectedIndex !== index) {
      sel.selectedIndex = index;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sel.focus();
  };
  const open = (sel) => {
    close();
    const opts = Array.from(sel.options);
    if (!opts.length) return;
    const r = sel.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight, itemH = 24;
    const below = vh - r.bottom, above = r.top;
    const maxH = Math.max(itemH * 3, Math.min(itemH * 12 + 8, Math.max(below, above) - 4));
    host = document.createElement("termium-select");
    const root = host.attachShadow({ mode: "closed" });
    const css = (el, props) => { for (const k in props) el.style.setProperty(k, props[k], "important"); };
    const menu = document.createElement("div");
    css(menu, {
      position: "fixed", "z-index": "2147483647", "box-sizing": "border-box", background: "#fff", color: "#111",
      border: "1px solid #888", "box-shadow": "0 4px 14px rgba(0,0,0,.35)", font: "14px system-ui, sans-serif",
      "overflow-y": "auto", padding: "4px 0", "border-radius": "4px",
    });
    const rowCss = (el, extra) => css(el, Object.assign({
      padding: "0 10px", height: itemH + "px", "line-height": itemH + "px", "white-space": "nowrap",
      overflow: "hidden", "text-overflow": "ellipsis", background: "transparent", color: "#111",
    }, extra));
    const rows = [];
    let active = -1, lastGroup = null;
    const disabled = [];
    const paint = (i, on) => {
      if (!rows[i]) return;
      css(rows[i], on ? { background: "#1a73e8", color: "#fff" } : { background: "transparent", color: disabled[i] ? "#999" : "#111" });
    };
    const setActive = (i) => {
      paint(active, false);
      active = i;
      if (rows[i]) { paint(i, true); rows[i].scrollIntoView({ block: "nearest" }); }
    };
    const enabled = (i) => !!rows[i] && !disabled[i];
    opts.forEach((o, i) => {
      const g = o.parentElement && o.parentElement.tagName === "OPTGROUP" ? o.parentElement : null;
      // Hidden options (hidden attribute or display: none) aren't offered.
      if (o.hidden || (g && g.hidden) || getComputedStyle(o).display === "none") return;
      if (g && g !== lastGroup) {
        const gh = document.createElement("div");
        rowCss(gh, { "font-weight": "600", color: "#555" });
        gh.textContent = g.label;
        menu.appendChild(gh);
      }
      lastGroup = g;
      const d = document.createElement("div");
      disabled[i] = !!(o.disabled || (g && g.disabled));
      rowCss(d, { "padding-left": g ? "22px" : "10px", color: disabled[i] ? "#999" : "#111" });
      d.textContent = o.label || o.text || " ";
      d.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      d.addEventListener("mouseup", (e) => { e.preventDefault(); e.stopPropagation(); if (enabled(i)) choose(sel, i); });
      d.addEventListener("mousemove", () => { if (enabled(i) && active !== i) setActive(i); });
      menu.appendChild(d);
      rows[i] = d;
    });
    const width = Math.max(r.width, 120);
    menu.style.minWidth = width + "px";
    menu.style.maxWidth = Math.max(width, vw - 8) + "px";
    menu.style.left = Math.max(2, Math.min(r.left, vw - width - 2)) + "px";
    menu.style.maxHeight = maxH + "px";
    if (below >= Math.min(maxH, opts.length * itemH + 8) || below >= above) menu.style.top = r.bottom + "px";
    else menu.style.bottom = (vh - r.top) + "px";
    root.append(menu);
    // As a popover the menu is in the top layer, above modal <dialog>s and
    // fullscreen elements; the host itself is a transparent, click-through
    // layer over the viewport.
    css(host, {
      position: "fixed", inset: "0", margin: "0", padding: "0", border: "0", background: "transparent",
      width: "100vw", height: "100vh", "max-width": "none", "max-height": "none", overflow: "visible",
      "pointer-events": "none",
    });
    css(menu, { "pointer-events": "auto" });
    host.setAttribute("popover", "manual");
    document.documentElement.appendChild(host);
    try { host.showPopover(); } catch {}
    setActive(Math.max(0, sel.selectedIndex));
    const step = (dir) => {
      for (let i = active + dir; i >= 0 && i < opts.length; i += dir) if (enabled(i)) return setActive(i);
    };
    const onKey = (e) => {
      const k = e.key;
      if (k === "ArrowDown") step(1);
      else if (k === "ArrowUp") step(-1);
      else if (k === "Home") { active = -1; step(1); }
      else if (k === "End") { active = opts.length; step(-1); }
      else if (k === "PageDown") for (let n = 0; n < 8; n++) step(1);
      else if (k === "PageUp") for (let n = 0; n < 8; n++) step(-1);
      else if (k === "Enter" || k === " ") { if (enabled(active)) choose(sel, active); }
      else if (k === "Escape") close();
      else if (k === "Tab") { close(); return; } // and let Tab move focus as usual
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
        const c = k.toLowerCase();
        for (let n = 1; n <= opts.length; n++) {
          const i = (active + n) % opts.length;
          if (enabled(i) && (opts[i].label || opts[i].text).trim().toLowerCase().startsWith(c)) { setActive(i); break; }
        }
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
      swallowUp.add(e.key);
    };
    const outside = (e) => { if (!e.composedPath().includes(host)) close(); };
    addEventListener("keydown", onKey, true);
    addEventListener("mousedown", outside, true);
    addEventListener("wheel", outside, true);
    addEventListener("blur", close);
    addEventListener("resize", close);
    cleanup = () => {
      removeEventListener("keydown", onKey, true);
      removeEventListener("mousedown", outside, true);
      removeEventListener("wheel", outside, true);
      removeEventListener("blur", close);
      removeEventListener("resize", close);
    };
  };
  const popupSelect = (t) => {
    const s = t && t.closest ? t.closest("select") : null;
    return s && !s.multiple && s.size <= 1 && !s.disabled ? s : null;
  };
  // The real focused element, inside open shadow roots too.
  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  addEventListener("mousedown", (e) => {
    if (host && e.composedPath().includes(host)) return;
    // composedPath()[0] is the real target even inside an (open) shadow root.
    const s = popupSelect(e.composedPath()[0]);
    if (!s || e.button !== 0) return;
    e.preventDefault();
    s.focus();
    if (host) close();
    else open(s);
  }, true);
  addEventListener("keydown", (e) => {
    if (host) return;
    const s = popupSelect(deepActive());
    if (!s) return;
    if (e.key === " " || e.key === "F4" || (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp"))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      swallowUp.add(e.key);
      open(s);
    }
  }, true);
})();`;
