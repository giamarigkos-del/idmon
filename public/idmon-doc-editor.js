/* public/idmon-doc-editor.js (4 Οκτ 2026)
 * Ο επεξεργαστής εγγράφων του SMB (editor.html): Tiptap (public/vendor/editor.js) με την κοινή γραμμή εργαλείων (public/idmon-toolbar.js), αντί για το Toast UI.
 * Δίνει στη σελίδα ΜΙΑ συνάρτηση που επιστρέφει αντικείμενο με getMarkdown(), setMarkdown(), focus() και destroy(): όσα χρειαζόταν το Toast.
 *
 *   var ed = IdmonDocEditor.create(hostElement, { markdown: "...", onChange: function () { ... } });
 *   ed.getMarkdown();   // πάντα Markdown (όπως πριν), ed.destroy();
 *
 * Αποφάσεις (δεν ξανασυζητούνται):
 *  - ΧΩΡΙΣ εικόνες στο SMB για την ώρα: δεν υπάρχει κουμπί «Εικόνα» και δεν υπάρχει χειριστής ανεβάσματος. Εικόνα base64 μέσα στο κείμενο έσπαγε τη δημοσίευση
 *    (ένα chunk με εικόνα ξεπερνά τα 10 KiB metadata του Vectorize). Το πρόβλημα λύνεται με το ότι η μηχανή δεν δέχεται πια τέτοιες εικόνες.
 *  - Αν σύρεις ή επικολλήσεις αρχείο εικόνας, ο χρήστης βλέπει μήνυμα. Χωρίς χειριστή, ο browser θα άνοιγε την εικόνα και θα έφευγε από τη σελίδα (θα χανόταν το κείμενο).
 *  - Ο ορθογράφος του browser διαλέγει μόνος του γλώσσα (lang: null), γιατί τα έγγραφα του SMB είναι σε ελληνικά ΚΑΙ αγγλικά.
 *  - Αν ο Tiptap ή η γραμμή δεν φορτώσουν (ή σκάσουν), πέφτουμε σε απλό πεδίο κειμένου: ο πελάτης δεν μένει ποτέ χωρίς τρόπο να γράψει. */
(function () {
  "use strict";

  var TEXT = {
    en: {
      label: "Document text",
      imagesNotYet: "Images aren't supported in these documents yet. Describe the image in words instead.",
      embeddedImages: "This document contains embedded images, which can stop it from being published. Remove them or replace them with a text description."
    },
    el: {
      label: "Κείμενο εγγράφου",
      imagesNotYet: "Οι εικόνες δεν υποστηρίζονται ακόμα σε αυτά τα έγγραφα. Περίγραψε την εικόνα με λόγια.",
      embeddedImages: "Αυτό το έγγραφο περιέχει ενσωματωμένες εικόνες, που μπορεί να εμποδίσουν τη δημοσίευσή του. Αφαίρεσέ τες ή αντικατέστησέ τες με περιγραφή σε κείμενο."
    }
  };
  // Η σελίδα είναι αγγλική από προεπιλογή. Το shared.js αλλάζει το lang του <html> στη γλώσσα του χρήστη, γι' αυτό διαβάζεται ΤΗ ΣΤΙΓΜΗ που φτιάχνεται ο επεξεργαστής.
  function langNow() { return String(document.documentElement.getAttribute("lang") || "en").toLowerCase().slice(0, 2) === "el" ? "el" : "en"; }
  function T(key) { return TEXT[langNow()][key]; }
  var EMBEDDED_IMAGE = /\]\(\s*data:image\//i;

  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  function richEditor(host, markdown, onChange) {
    var bar = window.IdmonToolbar.create({}); // χωρίς onImage: ΔΕΝ υπάρχει κουμπί «Εικόνα»
    var body = el("div", "rte-body");
    var wrap = el("div", "rte");
    wrap.appendChild(bar.toolbar); wrap.appendChild(bar.tableTools); wrap.appendChild(bar.linkBar); wrap.appendChild(bar.note); wrap.appendChild(body);
    host.appendChild(wrap);
    var imagesBlocked = function () { bar.say("err", T("imagesNotYet")); };
    var ed = window.IdmonEditor.create(body, {
      markdown: markdown, ariaLabel: T("label"), lang: null,
      onChange: onChange,
      onState: function (s) { bar.update(s); },
      onImageFiles: imagesBlocked,      // εικόνα σε σύρσιμο ή επικόλληση: μήνυμα, ΟΧΙ εισαγωγή
      onRejectedFiles: imagesBlocked    // άλλο αρχείο (pdf, svg...): το ίδιο μήνυμα, ώστε ο browser να μην το ανοίξει
    });
    bar.attach(ed);
    if (EMBEDDED_IMAGE.test(markdown)) bar.say("err", T("embeddedImages"));
    return {
      kind: "rich",
      getMarkdown: function () { return ed.getMarkdown(); },
      setMarkdown: function (md) { ed.setMarkdown(md); },
      focus: function () { ed.focus(); },
      destroy: function () {
        try { bar.destroy(); } catch (e) { /* ήδη καθαρισμένο */ }
        try { ed.destroy(); } catch (e) { /* ήδη κατεστραμμένος */ }
        host.textContent = "";
      }
    };
  }

  function plainEditor(host, markdown, onChange) {
    var ta = el("textarea", "doc-fallback");
    ta.value = markdown; ta.setAttribute("aria-label", T("label")); ta.rows = 18;
    ta.addEventListener("input", function () { onChange(); });
    host.appendChild(ta);
    return {
      kind: "plain",
      getMarkdown: function () { return ta.value; },
      setMarkdown: function (md) { ta.value = md; },
      focus: function () { ta.focus(); },
      destroy: function () { host.textContent = ""; }
    };
  }

  function create(host, opts) {
    opts = opts || {};
    var markdown = String(opts.markdown == null ? "" : opts.markdown);
    var onChange = typeof opts.onChange === "function" ? opts.onChange : function () {};
    host.textContent = "";
    var ready = window.IdmonEditor && typeof window.IdmonEditor.create === "function" && window.IdmonToolbar && typeof window.IdmonToolbar.create === "function";
    if (ready) {
      try { return richEditor(host, markdown, onChange); }
      catch (e) { host.textContent = ""; /* ο επεξεργαστής δεν ξεκίνησε: απλό πεδίο παρακάτω */ }
    }
    return plainEditor(host, markdown, onChange);
  }

  window.IdmonDocEditor = { create: create, version: 1 };
})();
