/* public/idmon-toolbar.js (4 Οκτ 2026)
 * Κοινή γραμμή εργαλείων για τον επεξεργαστή κειμένου (Tiptap, vendor/editor.js). Τη φορτώνουν και η σελίδα του editor των ομάδων και (στο στάδιο 2) ο editor του SMB.
 * Δεν ξέρει τίποτα για εικόνες, αποθήκευση ή σελίδες: η σελίδα της δίνει επιλογές (options) και της συνδέει τον επεξεργαστή με το attach(ed).
 *
 *   var bar = IdmonToolbar.create({ onImage: function () { ... }, hide: ["image"], lang: "en" });   // onImage λείπει ή hide περιέχει "image": το κουμπί δεν φαίνεται
 *   // bar.toolbar, bar.tableTools, bar.linkBar, bar.note: τα στοιχεία που η σελίδα βάζει στη θέση που θέλει (με αυτή τη σειρά)
 *   var ed = IdmonEditor.create(host, { onState: function (s) { bar.update(s); ... } });
 *   bar.attach(ed);                                                                      // μετά τη δημιουργία του επεξεργαστή
 *
 * Κείμενα: ελληνικά και αγγλικά (TB_TEXT). Η γλώσσα έρχεται από το lang του <html> τη στιγμή της δημιουργίας (ή από την επιλογή lang). Νέα γλώσσα = νέο μπλοκ στο TB_TEXT με ΤΑ ΙΔΙΑ κλειδιά (το ελέγχει τεστ).
 * Εμφάνιση: tokens CSS (--accent, --surface κ.λπ.) μέσα από το public/idmon-editor.css. */
(function () {
  "use strict";
  var TB_TEXT = {
    el: {
      toolbar: "Μορφοποίηση κειμένου", more: "Περισσότερα εργαλεία", moreTip: "Περισσότερα εργαλεία",
      group0: "Κείμενο", group1: "Λίστες και παράθεμα", group2: "Εισαγωγή", group3: "Αναίρεση και επανάληψη",
      heading: "Επικεφαλίδα", headingTip: "Επικεφαλίδα: διάλεξε μέγεθος τίτλου", headingMenu: "Μέγεθος τίτλου",
      paragraph: "Κανονικό κείμενο", h2: "Τίτλος", h3: "Υπότιτλος",
      bold: "Έντονα", boldTip: "Έντονα (Ctrl+B)", italic: "Πλάγια", italicTip: "Πλάγια (Ctrl+I)", strike: "Διαγραμμένο", strikeTip: "Διαγραμμένο κείμενο",
      bulletList: "Λίστα", bulletListTip: "Λίστα με κουκκίδες", orderedList: "Αρίθμηση", orderedListTip: "Λίστα με αριθμούς",
      blockquote: "Παράθεμα", blockquoteTip: "Παράθεμα ή σημαντική σημείωση",
      link: "Σύνδεσμος", linkTip: "Βάλε σύνδεσμο στο επιλεγμένο κείμενο",
      image: "Εικόνα", imageTip: "Βάλε εικόνα από τον υπολογιστή ή το κινητό (ή επικόλλησέ την, ή σύρε την μέσα στο κείμενο)",
      table: "Πίνακας", tableTip: "Βάλε πίνακα 3 επί 3", hr: "Οριζόντια γραμμή", hrTip: "Βάλε οριζόντια γραμμή για να χωρίσεις ενότητες",
      undo: "Αναίρεση", undoTip: "Αναίρεση (Ctrl+Z)", redo: "Επανάληψη", redoTip: "Επανάληψη (Ctrl+Y)",
      tableTools: "Εργαλεία πίνακα", tableLabel: "Πίνακας:",
      linkUrl: "Διεύθυνση συνδέσμου", linkApply: "Εφαρμογή", linkRemove: "Αφαίρεση συνδέσμου", linkClose: "Κλείσιμο", linkBad: "Η διεύθυνση πρέπει να ξεκινά με https://, http:// ή mailto:",
      tableAddRow: "Γραμμή από κάτω", tableAddCol: "Στήλη δεξιά", tableDelRow: "Διαγραφή γραμμής", tableDelCol: "Διαγραφή στήλης", tableDelete: "Διαγραφή πίνακα"
    },
    en: {
      toolbar: "Text formatting", more: "More tools", moreTip: "More tools",
      group0: "Text", group1: "Lists and quote", group2: "Insert", group3: "Undo and redo",
      heading: "Heading", headingTip: "Heading: choose a title size", headingMenu: "Title size",
      paragraph: "Normal text", h2: "Title", h3: "Subtitle",
      bold: "Bold", boldTip: "Bold (Ctrl+B)", italic: "Italic", italicTip: "Italic (Ctrl+I)", strike: "Strikethrough", strikeTip: "Strikethrough text",
      bulletList: "List", bulletListTip: "Bulleted list", orderedList: "Numbered", orderedListTip: "Numbered list",
      blockquote: "Quote", blockquoteTip: "Quote or important note",
      link: "Link", linkTip: "Add a link to the selected text",
      image: "Image", imageTip: "Add an image from your computer or phone (or paste it, or drag it into the text)",
      table: "Table", tableTip: "Insert a 3 by 3 table", hr: "Horizontal line", hrTip: "Insert a horizontal line to separate sections",
      undo: "Undo", undoTip: "Undo (Ctrl+Z)", redo: "Redo", redoTip: "Redo (Ctrl+Y)",
      tableTools: "Table tools", tableLabel: "Table:",
      linkUrl: "Link address", linkApply: "Apply", linkRemove: "Remove link", linkClose: "Close", linkBad: "The address must start with https://, http:// or mailto:",
      tableAddRow: "Row below", tableAddCol: "Column to the right", tableDelRow: "Delete row", tableDelCol: "Delete column", tableDelete: "Delete table"
    }
  };
  // Γλώσσα: διαβάζεται ΤΗ ΣΤΙΓΜΗ που φτιάχνεται μια γραμμή (όχι όταν φορτώνει το αρχείο), γιατί σελίδες όπως ο editor του SMB αλλάζουν το lang του <html> αφού φορτώσουν τα scripts.
  // Ή δίνεται ρητά: IdmonToolbar.create({ lang: "en" }). Σειρά προτίμησης: η ρητή επιλογή, μετά το lang της σελίδας, μετά τα ελληνικά.
  // Υποστηρίζεται ΟΠΟΙΑΔΗΠΟΤΕ γλώσσα έχει μπλοκ στο TB_TEXT (νέα γλώσσα = νέο μπλοκ): ό,τι δεν έχει μπλοκ παραβλέπεται.
  function langOf(explicit) {
    var cands = [explicit, document.documentElement.getAttribute("lang")];
    for (var i = 0; i < cands.length; i++) { var c = String(cands[i] || "").toLowerCase().slice(0, 2); if (c && TB_TEXT[c]) return c; }
    return "el";
  }
  function tx(key, lang) { var L = lang && TB_TEXT[lang] ? lang : langOf(); return (TB_TEXT[L] && TB_TEXT[L][key]) || TB_TEXT.el[key] || key; }

  // Εικονίδια: λίστα στοιχείων SVG. Κείμενο (string) = path d. [tag, attrs, text] = άλλο στοιχείο (circle, rect, text).
  var TB_ICONS = {
    heading: ["M4 5v14", "M12 5v14", "M4 12h8", "M16 11l3 3 3-3"],
    bold: ["M7 5h6a3.5 3.5 0 0 1 0 7H7z", "M7 12h7a3.5 3.5 0 0 1 0 7H7z"],
    italic: ["M19 4h-9", "M14 20H5", "M15 4L9 20"],
    bulletList: ["M10 6h11", "M10 12h11", "M10 18h11", ["circle", { cx: 4.5, cy: 6, r: 1.2, fill: "currentColor" }], ["circle", { cx: 4.5, cy: 12, r: 1.2, fill: "currentColor" }], ["circle", { cx: 4.5, cy: 18, r: 1.2, fill: "currentColor" }]],
    orderedList: ["M11 6h10", "M11 12h10", "M11 18h10", "M3.5 4.5L5 3.5V8.5", "M3.2 11.5a1.6 1.4 0 1 1 2.6 1L3.2 15.5H6", "M3.2 17.2H6L4.6 18.6a1.4 1.3 0 1 1-1.4 2"],
    blockquote: ["M5 8h4v4c0 2.5-1.2 4-3.5 4.5", "M14 8h4v4c0 2.5-1.2 4-3.5 4.5"],
    link: ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"],
    image: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ["circle", { cx: 8.5, cy: 9, r: 1.5 }], "M21 16l-5-5-8 9"],
    table: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], "M3 10h18", "M3 15h18", "M9 4v16", "M15 4v16"],
    strike: ["M4 12h16", "M16.5 7a4.3 3.2 0 0 0-4.5-2.4C9.6 4.6 8 5.7 8 7.3c0 1.7 1.8 2.6 4 3", "M8 17a4.3 3.2 0 0 0 4.4 2.4c2.4 0 4.1-1.1 4.1-2.8 0-.7-.3-1.3-.9-1.8"],
    hr: ["M4 12h16", "M9 6h6", "M9 18h6"],
    undo: ["M9 14L4 9l5-5", "M4 9h10a6 6 0 0 1 0 12h-3"],
    redo: ["M15 14l5-5-5-5", "M20 9H10a6 6 0 0 0 0 12h3"],
    more: [["circle", { cx: 5, cy: 12, r: 1.4, fill: "currentColor" }], ["circle", { cx: 12, cy: 12, r: 1.4, fill: "currentColor" }], ["circle", { cx: 19, cy: 12, r: 1.4, fill: "currentColor" }]]
  };
  function tbIcon(name) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    [["viewBox", "0 0 24 24"], ["width", "20"], ["height", "20"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"], ["focusable", "false"]]
      .forEach(function (a) { svg.setAttribute(a[0], a[1]); });
    (TB_ICONS[name] || []).forEach(function (item) {
      var el;
      if (typeof item === "string") { el = document.createElementNS(NS, "path"); el.setAttribute("d", item); }
      else { el = document.createElementNS(NS, item[0]); Object.keys(item[1]).forEach(function (k) { el.setAttribute(k, item[1][k]); }); }
      svg.appendChild(el);
    });
    return svg;
  }
  // Σειρά ομάδων, σαν του Toast UI: [επικεφαλίδα, έντονα, πλάγια, διαγραμμένο] | [λίστες, παράθεμα] | [σύνδεσμος, εικόνα, πίνακας, οριζόντια γραμμή] | [αναίρεση, επανάληψη].
  var TB_GROUPS = [["heading", "bold", "italic", "strike"], ["bulletList", "orderedList", "blockquote"], ["link", "image", "table", "hr"], ["undo", "redo"]];
  var TB_CMD = { bold: "bold", italic: "italic", strike: "strike", hr: "hr", bulletList: "bulletList", orderedList: "orderedList", blockquote: "blockquote", table: "table", undo: "undo", redo: "redo" };
  var TB_TOGGLE = ["bold", "italic", "strike", "bulletList", "orderedList", "blockquote", "link"];
  var TB_MORE = ["strike", "orderedList", "blockquote", "table", "hr", "undo", "redo"]; // στο κινητό κρύβονται πίσω από το «⋯»
  var TB_HEADING_ITEMS = [["paragraph", "paragraph"], ["h2", "h2"], ["h3", "h3"]];
  var TABLE_TOOLS = ["tableAddRow", "tableAddCol", "tableDelRow", "tableDelCol", "tableDelete"];

  function h(tag, props, children) {
    var node = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      if (k === "class") node.className = props[k];
      else if (k === "text") node.textContent = props[k];
      else if (k === "value") node.value = props[k];
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }
  // Τα κουμπιά της γραμμής ΔΕΝ παίρνουν την εστίαση όταν τα πατάς (ποντίκι ή αφή): ο κέρσορας μένει στο κείμενο και ο συντάκτης συνεχίζει να γράφει αμέσως.
  // Αλλιώς το πρώτο πλήκτρο (π.χ. κενό) έπεφτε στο ίδιο το κουμπί και το ενεργοποιούσε ξανά. Με πληκτρολόγιο (Tab, Enter) δουλεύουν κανονικά.
  function keepFocus(b) { b.addEventListener("mousedown", function (e) { e.preventDefault(); }); return b; }

  function create(options) {
    options = options || {};
    var LANG = langOf(options.lang);
    function T(key) { return tx(key, LANG); }
    var hidden = {};
    (options.hide || []).forEach(function (id) { hidden[id] = true; });
    if (typeof options.onImage !== "function") hidden.image = true; // χωρίς χειριστή ανεβάσματος δεν υπάρχει κουμπί «Εικόνα»
    var ed = null, buttons = {};
    var note = h("div", { class: "rte-note", id: "rte-note", role: "status", "aria-live": "polite" });
    note.hidden = true;
    function say(kind, text) { note.className = "rte-note" + (kind ? " " + kind : ""); note.textContent = text; note.hidden = !text; }

    var toolbar = h("div", { class: "rte-toolbar", role: "toolbar", "aria-label": T("toolbar") });
    function makeButton(id, extraClass) {
      var label = T(id);
      var b = keepFocus(h("button", { class: "btn secondary tb" + (extraClass ? " " + extraClass : ""), type: "button", id: "tb-" + id, "aria-label": label, "data-tip": T(id + "Tip") === id + "Tip" ? label : T(id + "Tip") }, [tbIcon(id)]));
      if (TB_TOGGLE.indexOf(id) >= 0) b.setAttribute("aria-pressed", "false");
      if (TB_MORE.indexOf(id) >= 0) b.className += " tb-more-item";
      return b;
    }
    // Επικεφαλίδα: ένα κουμπί που ανοίγει μικρή λίστα (Κανονικό κείμενο, Τίτλος, Υπότιτλος). Τα στοιχεία κρατούν τα id tb-h2 και tb-h3.
    var headingMenu = h("div", { class: "tb-menu", id: "tb-heading-menu", role: "menu", "aria-label": T("headingMenu") });
    headingMenu.hidden = true;
    var headingBtn = null;
    function closeHeadingMenu(refocus) { headingMenu.hidden = true; if (headingBtn) { headingBtn.setAttribute("aria-expanded", "false"); if (refocus) headingBtn.focus(); } }
    TB_HEADING_ITEMS.forEach(function (it) {
      var item = keepFocus(h("button", { class: "tb-menu-item tb-menu-" + it[0], type: "button", id: it[0] === "paragraph" ? "tb-paragraph" : "tb-" + it[0], role: "menuitemradio", "aria-checked": "false", text: T(it[1]) }));
      item.addEventListener("click", function () {
        say("", "");
        var s = ed.state();
        if (it[0] === "paragraph") { if (s.h2) ed.exec("h2"); else if (s.h3) ed.exec("h3"); }
        else if (!s[it[0]]) ed.exec(it[0]);
        closeHeadingMenu(false);
      });
      buttons[it[0]] = item; headingMenu.appendChild(item);
    });
    var shownGroups = 0;
    TB_GROUPS.forEach(function (g, gi) {
      var box = h("div", { class: "tb-buttons" });
      g.forEach(function (id) {
        if (hidden[id]) return;
        if (id === "heading") {
          headingBtn = keepFocus(h("button", { class: "btn secondary tb tb-heading", type: "button", id: "tb-heading", "aria-label": T("heading"), "data-tip": T("headingTip"), "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "tb-heading-menu", "aria-pressed": "false" }, [tbIcon("heading")]));
          headingBtn.addEventListener("click", function () {
            var open = headingMenu.hidden;
            headingMenu.hidden = !open; headingBtn.setAttribute("aria-expanded", open ? "true" : "false");
          });
          buttons.heading = headingBtn;
          box.appendChild(h("div", { class: "tb-menuwrap" }, [headingBtn, headingMenu]));
          return;
        }
        var b = makeButton(id);
        b.addEventListener("click", function () {
          if (id === "link") { openLinkBar(); return; }
          if (id === "image") { options.onImage(); return; }
          say("", ""); ed.exec(TB_CMD[id]);
        });
        buttons[id] = b; box.appendChild(b);
      });
      if (!box.firstChild) return; // ομάδα χωρίς ορατά εργαλεία (όλα κρυμμένα): δεν φαίνεται ούτε ο διαχωριστής της
      if (shownGroups > 0) toolbar.appendChild(h("span", { class: "tb-sep", "aria-hidden": "true" }));
      shownGroups++;
      toolbar.appendChild(h("div", { class: "tb-group", role: "group", id: "tb-group-" + gi, "aria-label": T("group" + gi) }, [box]));
    });
    // «⋯»: φαίνεται μόνο στο κινητό και ανοίγει τα εργαλεία που κρύβονται για να χωράει η γραμμή σε μία σειρά.
    var moreBtn = keepFocus(h("button", { class: "btn secondary tb tb-morebtn", type: "button", id: "tb-more", "aria-label": T("more"), "data-tip": T("moreTip"), "aria-expanded": "false" }, [tbIcon("more")]));
    moreBtn.addEventListener("click", function () {
      var open = !toolbar.classList.contains("tb-expanded");
      toolbar.classList.toggle("tb-expanded", open); moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    toolbar.appendChild(moreBtn);
    // ---- Tooltip: ένα στοιχείο για όλη τη γραμμή. Hover: μετά από 450ms. Πληκτρολόγιο (Tab): μετά από 250ms. Αφή: παρατεταμένο πάτημα 500ms (και το κλικ που θα ακολουθούσε ακυρώνεται).
    // Κλείνει με Escape, με φευγιό του ποντικιού ή της εστίασης και με κλικ. Είναι μόνο οπτικό (aria-hidden): τον ήχο για τον αναγνώστη οθόνης τον δίνει το aria-label.
    var tip = h("div", { class: "tb-tip", id: "tb-tip", "aria-hidden": "true" });
    tip.hidden = true;
    toolbar.appendChild(tip);
    var tipTimer = null, tipHideTimer = null, swallowClick = false, tipFor = null, tipVia = "", lastTouch = 0; // lastTouch: ώρα του τελευταίου αγγίγματος (οι browsers στέλνουν «ψεύτικα» γεγονότα ποντικιού μετά από αφή, και δεν πρέπει να ανοίγουν tooltip hover) // tipFor/tipVia: ποιο κουμπί και με ποιον τρόπο (hover, focus, touch) ζήτησε το tooltip: μόνο ο ίδιος τρόπος και το ίδιο κουμπί μπορούν να το κλείσουν
    function hideTip() { if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; } if (tipHideTimer) { clearTimeout(tipHideTimer); tipHideTimer = null; } tip.hidden = true; tipFor = null; tipVia = ""; }
    function showTip(btn) {
      var text = btn.getAttribute("data-tip");
      if (!text) return;
      tip.textContent = text; tip.hidden = false;
      var tr = toolbar.getBoundingClientRect(), br = btn.getBoundingClientRect();
      var left = br.left - tr.left + br.width / 2 - tip.offsetWidth / 2;
      left = Math.max(4, Math.min(left, Math.max(4, tr.width - tip.offsetWidth - 4)));
      tip.style.left = Math.round(left) + "px"; tip.style.top = Math.round(br.bottom - tr.top + 6) + "px";
    }
    function later(btn, ms, via) { hideTip(); tipFor = btn; tipVia = via; tipTimer = setTimeout(function () { tipTimer = null; showTip(btn); }, ms); }
    function tipButton(e) { return e.target && e.target.closest ? e.target.closest("button[data-tip]") : null; }
    toolbar.addEventListener("mouseover", function (e) { if (Date.now() - lastTouch < 1000) return; var b = tipButton(e); if (b && !(e.relatedTarget && b.contains(e.relatedTarget))) later(b, 450, "hover"); });
    toolbar.addEventListener("mouseout", function (e) { var b = tipButton(e); if (b && tipVia === "hover" && b === tipFor && !(e.relatedTarget && b.contains(e.relatedTarget))) hideTip(); });
    toolbar.addEventListener("focusin", function (e) { var b = tipButton(e); if (b) later(b, 250, "focus"); });
    toolbar.addEventListener("focusout", function (e) { if (tipVia === "focus" && e.target === tipFor) hideTip(); });
    toolbar.addEventListener("touchstart", function (e) {
      lastTouch = Date.now();
      var b = tipButton(e); if (!b) return;
      hideTip(); swallowClick = false; tipFor = b; tipVia = "touch";
      tipTimer = setTimeout(function () { tipTimer = null; showTip(b); swallowClick = true; tipHideTimer = setTimeout(hideTip, 1800); }, 500);
    }, { passive: true });
    toolbar.addEventListener("touchmove", function () { if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; } }, { passive: true });
    toolbar.addEventListener("touchend", function () { lastTouch = Date.now(); if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; } }, { passive: true });
    toolbar.addEventListener("click", function (e) {
      if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); return; }
      hideTip();
    }, true);
    // η λίστα επικεφαλίδας κλείνει με Escape (η εστίαση γυρίζει στο κουμπί) και με κλικ έξω από αυτήν
    toolbar.addEventListener("keydown", function (e) { if (e.key !== "Escape") return; if (!tip.hidden) hideTip(); if (!headingMenu.hidden) { e.preventDefault(); closeHeadingMenu(true); } });
    function outsideClose(e) {
      if (!document.body.contains(toolbar)) { document.removeEventListener("mousedown", outsideClose); return; } // η γραμμή έφυγε από τη σελίδα (άλλο έγγραφο): ο ακροατής σβήνεται
      if (!headingMenu.hidden && !(e.target && e.target.closest && e.target.closest(".tb-menuwrap"))) closeHeadingMenu(false);
    }
    document.addEventListener("mousedown", outsideClose);
    var ctx = h("div", { class: "rte-context", id: "rte-table-tools", role: "toolbar", "aria-label": T("tableTools") }, [h("span", { class: "lbl", text: T("tableLabel") })]);
    ctx.hidden = true;
    TABLE_TOOLS.forEach(function (id) {
      var b = keepFocus(h("button", { class: "btn secondary tb" + (id === "tableDelete" ? " danger" : ""), type: "button", id: "tb-" + id, text: T(id) }));
      b.addEventListener("click", function () { ed.exec(id); });
      ctx.appendChild(b);
    });
    var url = h("input", { type: "text", id: "rte-link-url", placeholder: "https://…", "aria-label": T("linkUrl"), autocomplete: "off" });
    var linkbar = h("div", { class: "rte-linkbar", id: "rte-linkbar" }, [
      url,
      h("button", { class: "btn", type: "button", id: "rte-link-apply", text: T("linkApply"), onclick: function () {
        var r = ed.setLink(url.value);
        if (!r.ok) { say("err", T("linkBad")); return; }
        say("", ""); linkbar.hidden = true;
      } }),
      h("button", { class: "btn secondary", type: "button", id: "rte-link-remove", text: T("linkRemove"), onclick: function () { ed.exec("unsetLink"); say("", ""); linkbar.hidden = true; } }),
      h("button", { class: "btn secondary", type: "button", id: "rte-link-close", text: T("linkClose"), onclick: function () { linkbar.hidden = true; ed.focus(); } }),
    ]);
    linkbar.hidden = true;
    url.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); document.getElementById("rte-link-apply").click(); } });
    function openLinkBar() {
      var s = ed.state();
      url.value = s.linkHref || "";
      linkbar.hidden = false; url.focus();
    }
    // Ενημέρωση από τον επεξεργαστή (onState): ενεργά κουμπιά, ανενεργά Αναίρεση και Επανάληψη, μπάρα πίνακα μόνο όσο ο κέρσορας είναι σε πίνακα.
    function update(s) {
      Object.keys(buttons).forEach(function (k) {
        if (k === "undo") buttons[k].disabled = !s.canUndo;
        else if (k === "redo") buttons[k].disabled = !s.canRedo;
        else if (k === "heading") buttons[k].setAttribute("aria-pressed", s.h2 || s.h3 ? "true" : "false");
        else if (k === "paragraph") buttons[k].setAttribute("aria-checked", !s.h2 && !s.h3 ? "true" : "false");
        else if (k === "h2" || k === "h3") buttons[k].setAttribute("aria-checked", s[k] ? "true" : "false");
        else if (k !== "table" && k !== "image" && k !== "hr") buttons[k].setAttribute("aria-pressed", s[k] ? "true" : "false"); // το «Πίνακας», το «Εικόνα» και η «Οριζόντια γραμμή» ΔΕΝ είναι κουμπιά ενεργοποίησης
      });
      ctx.hidden = !s.table;
    }
    return {
      toolbar: toolbar, tableTools: ctx, linkBar: linkbar, note: note, buttons: buttons,
      attach: function (editor) { ed = editor; },
      update: update, say: say, openLinkBar: openLinkBar,
      destroy: function () { document.removeEventListener("mousedown", outsideClose); },
    };
  }

  window.IdmonToolbar = { create: create, keepFocus: keepFocus, text: tx, version: 2 };
})();
