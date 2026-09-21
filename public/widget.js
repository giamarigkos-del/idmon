// widget.js -- embeddable chat widget (Section I: embed layer).
//
// Χρήση σε ξένο site:
//   <script src="https://operations-portal-rag.giamarigkos.workers.dev/widget.js"
//           data-embed-id="emb-xxxxxxxxxxxx"></script>
//
// Προαιρετικά data-* attributes: data-accent-color (hex, π.χ. #111111 -- το
// χρώμα του header/των κουμπιών/της φούσκας του επισκέπτη· το χρώμα του
// κειμένου πάνω του διαλέγεται ΑΥΤΟΜΑΤΑ, άσπρο ή σκούρο, ώστε να διαβάζεται
// ό,τι χρώμα κι αν επιλέξει ο πελάτης), data-bot-name, data-lang ("el"/"en"),
// data-position ("bottom-right"/"bottom-left").
//
// Βήμα 2β: το widget ρωτά τον server για τις ρυθμίσεις του πελάτη (GET
// /embed/{id}/config) και οι ρυθμίσεις του SERVER κερδίζουν τα data-attributes
// (χρώμα, όνομα, λογότυπο, επικοινωνία) -- έτσι ό,τι αλλάζει ο πελάτης στον
// editor φαίνεται χωρίς νέο snippet. Τα attributes μένουν ως εφεδρικά όταν ο
// server δεν απαντά. Ο server αποφασίζει και αν φαίνεται το "Powered by Idmon"
// (Free/Basic ναι, Pro όχι). data-config="off" παραλείπει το αίτημα (για
// προεπισκόπηση/δοκιμές: τότε ισχύουν τα attributes και το badge φαίνεται πάντα).
//
// ΣΚΟΠΙΜΑ ΔΕΝ χρησιμοποιεί iframe: αν το UI έτρεχε μέσα σε iframe που
// δείχνει σε δικό μας domain, κάθε request προς το backend θα είχε ΠΑΝΤΑ
// το δικό μας domain σαν Origin -- όχι το domain του πελάτη -- και όλο το
// CORS/domain-allow-list middleware θα ήταν άχρηστο (θα δούλευε το ίδιο
// από ΟΠΟΙΟΔΗΠΟΤΕ ξένο site). Με Shadow DOM το script τρέχει ΜΕΣΑ στη
// σελίδα του πελάτη -- σωστό Origin, σωστός έλεγχος -- και ταυτόχρονα το
// CSS του widget παραμένει πλήρως απομονωμένο από το CSS του site.
(function () {
  "use strict";

  function findScriptTag() {
    if (document.currentScript) return document.currentScript;
    var all = document.querySelectorAll("script[data-embed-id]");
    return all.length ? all[all.length - 1] : null;
  }

  var scriptTag = findScriptTag();
  if (!scriptTag) {
    console.error("[widget.js] Δεν βρέθηκε το <script> tag (χρειάζεται data-embed-id).");
    return;
  }

  var embedId = scriptTag.getAttribute("data-embed-id");
  if (!embedId) {
    console.error("[widget.js] Λείπει το data-embed-id attribute στο <script> tag.");
    return;
  }

  var BASE_URL = new URL(scriptTag.src).origin;
  // Βήμα 2α: το χρώμα του πελάτη είναι η ΜΙΑ "ετικέτα" (--accent) απ' όπου
  // παίρνουν όλα τα στοιχεία του widget. Δεχόμαστε μόνο hex (#rgb ή #rrggbb),
  // όπως ήδη επιβάλλει το backend στις ρυθμίσεις -- οτιδήποτε άλλο πέφτει
  // στο προεπιλεγμένο, ώστε μια λάθος τιμή στο snippet να μη σπάει το CSS.
  var DEFAULT_ACCENT = "#111111";

  function normalizeHex(value) {
    if (typeof value !== "string") return null;
    var v = value.trim();
    var short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v);
    if (short) return ("#" + short[1] + short[1] + short[2] + short[2] + short[3] + short[3]).toLowerCase();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    return null;
  }

  // Σχετική φωτεινότητα κατά WCAG και επιλογή του χρώματος κειμένου (άσπρο
  // ή σχεδόν μαύρο) με τη μεγαλύτερη αντίθεση πάνω στο χρώμα του πελάτη.
  function readableOn(hex) {
    function channel(i) {
      var c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    var lum = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    var contrastWhite = 1.05 / (lum + 0.05);
    var contrastDark = (lum + 0.05) / 0.05;
    return contrastWhite >= contrastDark ? "#ffffff" : "#111111";
  }

  var accentColor = normalizeHex(scriptTag.getAttribute("data-accent-color")) || DEFAULT_ACCENT;
  var onAccent = readableOn(accentColor);
  var avatarBg = onAccent === "#ffffff" ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.12)";

  // Έλεγχοι για τιμές που έρχονται από τον server. Ο server ήδη τις καθαρίζει
  // (index.js: buildPublicWidgetConfig) και εδώ ξαναελέγχονται ως δεύτερη γραμμή
  // άμυνας -- αντίγραφο των ίδιων κανόνων επίτηδες, το widget.js μένει αυτόνομο.
  function cleanText(value, maxLength) {
    if (typeof value !== "string") return null;
    var trimmed = value.trim();
    return trimmed && trimmed.length <= maxLength ? trimmed : null;
  }
  function isCleanUrl(value, maxLength) {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u0020\u007f]/.test(value);
  }
  function isSafeLogoUrl(value) {
    if (!isCleanUrl(value, 500)) return false;
    try { return new URL(value).protocol === "https:"; } catch (e) { return false; }
  }
  function isSafeContactUrl(value) {
    if (!isCleanUrl(value, 500)) return false;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
    return !/^(javascript|vbscript|data):/i.test(value);
  }
  function validPhone(value) {
    return typeof value === "string" && /^[0-9+()\-.\s#*,]{3,30}$/.test(value.trim());
  }

  var ICON_CHAT =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
  var ICON_AVATAR =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z"/>' +
    '<path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/></svg>';
  var ICON_CLOSE =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var botName = scriptTag.getAttribute("data-bot-name") || "Assistant";
  var lang = (scriptTag.getAttribute("data-lang") || "el").toLowerCase();
  var position = scriptTag.getAttribute("data-position") === "bottom-left" ? "bottom-left" : "bottom-right";
  var configMode = scriptTag.getAttribute("data-config") === "off" ? "off" : "server";

  // Section J: human handoff -- προαιρετικά, ο πελάτης μπορεί να μην έχει
  // ρυθμίσει τίποτα από αυτά ακόμα (backward compatible, καμία αλλαγή UI
  // αν λείπουν).
  var contactLabel = scriptTag.getAttribute("data-contact-label");
  var contactUrl = scriptTag.getAttribute("data-contact-url");
  var contactPhone = scriptTag.getAttribute("data-contact-phone");
  var hasContactLink = !!(contactLabel && contactUrl);
  var hasContact = hasContactLink || !!contactPhone;

  var STRINGS = {
    el: {
      disclosure: "Απαντήσεις από AI",
      placeholder: "Γράψε την ερώτησή σου…",
      send: "Αποστολή",
      genericError: "Κάτι πήγε στραβά. Δοκίμασε ξανά σε λίγο.",
      unavailable: "Ο βοηθός δεν είναι διαθέσιμος αυτή τη στιγμή.",
      openLabel: "Άνοιγμα βοηθού",
      closeLabel: "Κλείσιμο",
      fallbackContactPrompt: "Δεν βρήκες αυτό που ήθελες;",
      // Section Q: pricing tiers -- γενικό μήνυμα προς τον επισκέπτη όταν ο
      // πελάτης-ιδιοκτήτης έχει εξαντλήσει το μηνιαίο του όριο μηνυμάτων.
      // Σκόπιμα ΧΩΡΙΣ καμία αναφορά σε "όριο"/"πλάνο"/Idmon -- ίδιο κείμενο
      // με το limitReachedMessage του shared.js (index.html), κρατημένο
      // εδώ σαν δικό του αντίγραφο επειδή το widget.js πρέπει να μείνει
      // αυτόνομο, χωρίς εξάρτηση σε shared.js.
      limitReached: "Αντιμετωπίζουμε προσωρινά τεχνικό πρόβλημα. Επικοινώνησε απευθείας μαζί μας:",
      poweredBy: "Powered by Idmon",
    },
    en: {
      disclosure: "AI-generated answers",
      placeholder: "Type your question…",
      send: "Send",
      genericError: "Something went wrong. Please try again shortly.",
      unavailable: "This assistant is currently unavailable right now.",
      openLabel: "Open assistant",
      closeLabel: "Close",
      fallbackContactPrompt: "Didn't find what you needed?",
      limitReached: "We're experiencing technical difficulties right now. Please contact us directly:",
      poweredBy: "Powered by Idmon",
    },
  };
  var t = STRINGS[lang] || STRINGS.el;

  // ---- Host element + Shadow DOM -------------------------------------
  var host = document.createElement("div");
  host.id = "rag-embed-widget-host";
  host.style.all = "initial"; // απομόνωση ακόμα και από inherited στυλ του <body>
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  var sideProp = position === "bottom-left" ? "left" : "right";

  var style = document.createElement("style");
  style.textContent = [
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}",
    // Οι "ετικέτες" χρώματος: ΜΙΑ φορά ορισμένες, όλα τα υπόλοιπα τις διαβάζουν.
    // (οι "ετικέτες" χρώματος --accent/--on-accent/--avatar-bg ορίζονται στο ξεχωριστό themeStyle παρακάτω)
    ".bubble.pending{visibility:hidden;}",
    ".avatar img{width:100%;height:100%;object-fit:cover;display:block;}",
    ".powered{padding:0 12px 10px;text-align:center;font-size:11px;background:#fff;}",
    ".powered[hidden]{display:none;}",
    ".powered a{color:#8a8a93;text-decoration:none;}",
    ".powered a:hover{text-decoration:underline;}",
    ".powered a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}",
    ".bubble{position:fixed;bottom:20px;" + sideProp + ":20px;width:56px;height:56px;border-radius:50%;",
    "background:var(--accent);color:var(--on-accent);border:none;cursor:pointer;padding:0;",
    "box-shadow:0 6px 20px rgba(0,0,0,.28);z-index:2147483647;display:flex;align-items:center;justify-content:center;}",
    ".panel{position:fixed;bottom:88px;" + sideProp + ":20px;width:360px;max-width:calc(100vw - 32px);",
    "height:520px;max-height:calc(100vh - 110px);background:#fff;border-radius:20px;",
    "box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:2147483647;}",
    ".panel.open{display:flex;animation:pop .16s ease-out;}",
    "@keyframes pop{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}",
    "@media (prefers-reduced-motion:reduce){.panel.open{animation:none;}}",
    // Header: σκούρα ζώνη, ίσια άκρη πάνω στο λευκό σώμα.
    ".header{background:var(--accent);color:var(--on-accent);padding:14px 14px 14px 16px;display:flex;align-items:center;gap:12px;}",
    ".avatar{flex:none;width:38px;height:38px;border-radius:50%;background:var(--avatar-bg);",
    "display:flex;align-items:center;justify-content:center;overflow:hidden;}",
    ".avatar svg{width:20px;height:20px;}",
    ".header-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}",
    ".header-title{font-size:15px;font-weight:700;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".header-sub{font-size:12px;line-height:1.25;opacity:.75;}",
    ".close-btn{flex:none;background:none;border:none;color:var(--on-accent);cursor:pointer;line-height:0;padding:8px;border-radius:50%;opacity:.85;}",
    ".close-btn:hover{opacity:1;background:var(--avatar-bg);}",
    // Σώμα: λευκό, δύο ξεχωριστά στυλ φούσκας (επισκέπτης = χρώμα πελάτη, bot = ανοιχτό γκρι).
    ".messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:#fff;scrollbar-width:thin;}",
    ".msg{max-width:84%;padding:10px 14px;border-radius:18px;font-size:14px;line-height:1.5;word-wrap:break-word;}",
    ".msg.user{align-self:flex-end;background:var(--accent);color:var(--on-accent);border-bottom-right-radius:5px;}",
    ".msg.bot{align-self:flex-start;background:#f1f1f3;color:#1a1a1a;border-bottom-left-radius:5px;}",
    ".msg.fallback-contact{align-self:flex-start;max-width:92%;background:#f1f1f3;color:#1a1a1a;",
    "border-left:3px solid var(--accent);border-bottom-left-radius:5px;}",
    ".msg ul,.msg ol{margin:6px 0;padding-left:20px;}",
    ".msg li{margin:2px 0;}",
    ".msg li>ul{margin:2px 0;}",
    ".msg>ul:first-child,.msg>ol:first-child{margin-top:0;}",
    ".msg>ul:last-child,.msg>ol:last-child{margin-bottom:0;}",
    ".fallback-contact-text{margin-bottom:8px;}",
    ".contact-bar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;background:#fff;border-bottom:1px solid #ececef;}",
    // Pill κουμπιά παντού: πλήρως στρογγυλεμένες άκρες.
    ".contact-link{display:inline-block;font-size:12px;font-weight:700;color:var(--on-accent);background:var(--accent);",
    "padding:6px 14px;border-radius:999px;text-decoration:none;white-space:nowrap;}",
    ".contact-link:hover{opacity:.85;}",
    ".input-row{display:flex;gap:8px;padding:12px;border-top:1px solid #ececef;background:#fff;}",
    ".input-row input{flex:1;min-width:0;border:1px solid #d8d8dc;border-radius:999px;padding:10px 16px;font-size:14px;",
    "outline:none;background:#fff;color:#1a1a1a;}",
    ".input-row input:focus{border-color:var(--accent);}",
    ".input-row button{flex:none;background:var(--accent);color:var(--on-accent);border:none;border-radius:999px;",
    "padding:0 18px;font-size:13.5px;font-weight:600;cursor:pointer;}",
    ".input-row button:disabled{opacity:.5;cursor:default;}",
    // Προσβασιμότητα: ορατό focus για χρήστες πληκτρολογίου.
    ".bubble:focus-visible,.input-row button:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}",
    ".close-btn:focus-visible{outline:2px solid var(--on-accent);outline-offset:1px;}",
  ].join("");
  root.appendChild(style);

  // Οι ετικέτες χρώματος σε δικό τους <style>: όταν έρθουν οι ρυθμίσεις του
  // server ξαναγράφεται ΜΟΝΟ αυτό και όλα τα στοιχεία αλλάζουν μαζί.
  var themeStyle = document.createElement("style");
  function applyTheme(hex) {
    accentColor = hex;
    onAccent = readableOn(hex);
    avatarBg = onAccent === "#ffffff" ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.12)";
    themeStyle.textContent =
      ".bubble,.panel{--accent:" + accentColor + ";--on-accent:" + onAccent + ";--avatar-bg:" + avatarBg + ";}";
  }
  applyTheme(accentColor);
  root.appendChild(themeStyle);

  function escapeAttr(str) {
    return String(str).replace(/"/g, "&quot;");
  }

  // Χρησιμοποιείται ΚΑΙ στο πάντα-ορατό contact-bar κάτω από τον τίτλο, ΚΑΙ
  // στο πιο έντονο μήνυμα που εμφανίζεται κάτω από κάθε "δεν γνωρίζω"
  // απάντηση, ΚΑΙ (Section Q) στο μήνυμα ορίου -- ίδιο HTML, τρία σημεία
  // εμφάνισης, μία υλοποίηση.
  function contactLinksHtml() {
    var parts = [];
    if (hasContactLink) {
      parts.push(
        '<a class="contact-link" href="' + escapeAttr(contactUrl) + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(contactLabel) + "</a>"
      );
    }
    if (contactPhone) {
      parts.push('<a class="contact-link" href="tel:' + escapeAttr(contactPhone) + '">📞 ' + escapeHtml(contactPhone) + "</a>");
    }
    return parts.join(" ");
  }

  var bubble = document.createElement("button");
  // "pending": κρυφό μέχρι να έρθουν οι ρυθμίσεις του server (ή να περάσουν 1,5"),
  // ώστε ο επισκέπτης να μη δει ένα γκρι widget να αλλάζει χρώμα μπροστά του.
  bubble.className = "bubble pending";
  bubble.type = "button";
  bubble.setAttribute("aria-label", t.openLabel);
  bubble.innerHTML = ICON_CHAT;
  root.appendChild(bubble);

  var panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML =
    '<div class="header">' +
    '  <div class="avatar"></div>' +
    '  <div class="header-text">' +
    '    <span class="header-title"></span>' +
    '    <span class="header-sub"></span>' +
    "  </div>" +
    '  <button type="button" class="close-btn" aria-label=""></button>' +
    "</div>" +
    (hasContact ? '<div class="contact-bar">' + contactLinksHtml() + "</div>" : "") +
    '<div class="messages"></div>' +
    '<div class="input-row">' +
    '  <input type="text" />' +
    "  <button type=\"button\"></button>" +
    "</div>" +
    '<div class="powered" hidden><a href="https://idmon.app" target="_blank" rel="noopener noreferrer"></a></div>';
  root.appendChild(panel);

  panel.querySelector(".header-title").textContent = botName;
  panel.querySelector(".header-sub").textContent = t.disclosure;
  panel.querySelector(".avatar").innerHTML = ICON_AVATAR;
  panel.querySelector(".close-btn").innerHTML = ICON_CLOSE;
  panel.querySelector(".close-btn").setAttribute("aria-label", t.closeLabel);
  var poweredEl = panel.querySelector(".powered");
  poweredEl.querySelector("a").textContent = t.poweredBy;
  var messagesEl = panel.querySelector(".messages");
  var inputEl = panel.querySelector(".input-row input");
  var sendBtn = panel.querySelector(".input-row button");
  inputEl.placeholder = t.placeholder;
  sendBtn.textContent = t.send;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Μορφοποίηση απαντήσεων. Αντιγραμμένη επίτηδες από το shared.js (η ΙΔΙΑ λογική) -- το
  // widget.js πρέπει να μείνει ένα αυτόνομο αρχείο, χωρίς εξωτερικές εξαρτήσεις (φορτώνεται
  // σε ξένο site, όχι στο δικό μας).
  // --- formatAnswer (Βήμα 2δ) -- ΑΡΧΗ ---
  // Ελάχιστος και ΑΣΦΑΛΗΣ μορφοποιητής markdown για τις απαντήσεις (Βήμα 2δ). Το Gemini
  // γράφει λίστες (`* κείμενο`, `1. κείμενο`), πλάγια (`*κείμενο*`) και έντονα (`**κείμενο**`).
  // ΙΔΙΑ λογική στο widget.js και στο shared.js (demo σελίδα, test panel του editor).
  // Πρώτα ξεφεύγουν ΟΛΟΙ οι ειδικοί χαρακτήρες HTML και μετά προστίθενται μόνο οι δικές μας
  // ετικέτες (strong, em, ul, ol, li, br): τίποτα από το κείμενο δεν γίνεται ποτέ ετικέτα.
  // Ημιτελές markdown (π.χ. ένα `**` που δεν έκλεισε ακόμα ενώ γίνεται streaming) μένει
  // σαν κείμενο μέχρι να ολοκληρωθεί, χωρίς σφάλμα.
  function formatInline(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
  }

  function formatAnswer(text) {
    var lines = escapeHtml(text).replace(/\r\n?/g, "\n").split("\n");
    var blocks = []; // { kind: "p" | "list", html }
    var para = [];
    var list = null; // { type: "ul" | "ol", start, items: [{ html, children: [] }] }

    function flushPara() {
      if (para.length) {
        blocks.push({ kind: "p", html: para.join("<br>") });
        para = [];
      }
    }
    function flushList() {
      if (!list) return;
      var html = "<" + list.type + (list.type === "ol" && list.start > 1 ? ' start="' + list.start + '"' : "") + ">";
      list.items.forEach(function (item) {
        html += "<li>" + item.html;
        if (item.children.length) {
          html += "<ul>" + item.children.map(function (c) { return "<li>" + c + "</li>"; }).join("") + "</ul>";
        }
        html += "</li>";
      });
      blocks.push({ kind: "list", html: html + "</" + list.type + ">" });
      list = null;
    }

    lines.forEach(function (line) {
      if (!line.trim()) {
        flushPara();
        flushList();
        return;
      }
      var bullet = /^(\s*)[*\-\u2022]\s+(\S.*)$/.exec(line);
      var numbered = bullet ? null : /^(\s*)(\d{1,2})[.)]\s+(\S.*)$/.exec(line);
      var heading = bullet || numbered ? null : /^\s{0,3}#{1,6}\s+(\S.*)$/.exec(line);

      if (bullet) {
        // Εσοχή 2+ χαρακτήρων μέσα σε υπάρχουσα λίστα = υπο-κουκκίδα (ένα επίπεδο).
        if (bullet[1].length >= 2 && list && list.items.length) {
          list.items[list.items.length - 1].children.push(formatInline(bullet[2]));
          return;
        }
        flushPara();
        if (!list || list.type !== "ul") {
          flushList();
          list = { type: "ul", start: 1, items: [] };
        }
        list.items.push({ html: formatInline(bullet[2]), children: [] });
      } else if (numbered) {
        flushPara();
        if (!list || list.type !== "ol") {
          flushList();
          list = { type: "ol", start: parseInt(numbered[2], 10), items: [] };
        }
        list.items.push({ html: formatInline(numbered[3]), children: [] });
      } else if (heading) {
        flushPara();
        flushList();
        blocks.push({ kind: "p", html: "<strong>" + formatInline(heading[1]) + "</strong>" });
      } else {
        flushList();
        para.push(formatInline(line.trim()));
      }
    });
    flushPara();
    flushList();

    // Κενή γραμμή ανάμεσα σε δύο παραγράφους = οπτικός διαχωρισμός (όπως πριν)· γύρω από λίστες
    // αρκούν τα περιθώρια του CSS.
    var out = "";
    blocks.forEach(function (b, i) {
      if (i > 0 && b.kind === "p" && blocks[i - 1].kind === "p") out += "<br><br>";
      out += b.html;
    });
    return out;
  }

  // --- formatAnswer (Βήμα 2δ) -- ΤΕΛΟΣ ---

  function addMessage(role, html) {
    var el = document.createElement("div");
    el.className = "msg " + role;
    el.innerHTML = html;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  // Ξεχωριστό, πιο έντονο "μήνυμα" (όχι σκέτο bot bubble) που εμφανίζεται
  // ΜΟΝΟ κάτω από μια "δεν γνωρίζω" απάντηση -- σύμφωνα με τις βέλτιστες
  // πρακτικές human handoff: πάντα ορατή επιλογή επικοινωνίας, αλλά πιο
  // επιτακτική/εμφανής ακριβώς εκεί που το bot αποτυγχάνει.
  function addFallbackContactPrompt() {
    var el = document.createElement("div");
    el.className = "msg fallback-contact";
    el.innerHTML =
      '<div class="fallback-contact-text">' + escapeHtml(t.fallbackContactPrompt) + "</div>" + contactLinksHtml();
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  // Section Q: το ίδιο "μήνυμα ορίου" με το index.html (showLimitReachedMessage),
  // απλά χτισμένο απευθείας μέσα στο ήδη υπάρχον bot bubble (botEl) αντί για
  // ξεχωριστό μήνυμα -- ο επισκέπτης βλέπει ΕΝΑ μήνυμα, όχι δύο διαδοχικά.
  // Χρησιμοποιεί το ίδιο contactLinksHtml() με το fallback-contact prompt.
  function renderLimitReachedInto(botEl) {
    botEl.className = "msg bot";
    var html = escapeHtml(t.limitReached);
    var links = contactLinksHtml();
    if (links) html += " " + links;
    botEl.innerHTML = html;
  }

  function setOpen(open) {
    panel.classList.toggle("open", open);
    if (open) inputEl.focus();
  }

  bubble.addEventListener("click", function () {
    setOpen(!panel.classList.contains("open"));
  });
  panel.querySelector(".close-btn").addEventListener("click", function () {
    setOpen(false);
  });

  // ---- Βήμα 2β: ρυθμίσεις από τον server ---------------------------------
  function recomputeContact() {
    hasContactLink = !!(contactLabel && contactUrl);
    hasContact = hasContactLink || !!contactPhone;
  }

  // Δημιουργεί/ενημερώνει/αφαιρεί το contact-bar ώστε να ταιριάζει με τις τρέχουσες τιμές.
  function syncContactBar() {
    var bar = panel.querySelector(".contact-bar");
    if (!hasContact) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "contact-bar";
      panel.insertBefore(bar, messagesEl);
    }
    bar.innerHTML = contactLinksHtml();
  }

  function applyLogo(url) {
    var avatar = panel.querySelector(".avatar");
    if (!url) {
      avatar.innerHTML = ICON_AVATAR;
      return;
    }
    var img = document.createElement("img");
    img.alt = "";
    img.setAttribute("referrerpolicy", "no-referrer"); // ο ιστότοπος που φιλοξενεί το λογότυπο δεν μαθαίνει από πού ήρθε ο επισκέπτης
    img.decoding = "async";
    img.onerror = function () { avatar.innerHTML = ICON_AVATAR; }; // αν δεν φορτώσει: το προεπιλεγμένο εικονίδιο
    img.src = url;
    avatar.innerHTML = "";
    avatar.appendChild(img);
  }

  function setBranding(show) {
    poweredEl.hidden = !show;
  }

  // Οι έγκυρες τιμές του server κερδίζουν. Μια άκυρη τιμή αγνοείται και μένει
  // ό,τι ισχύει ήδη (attribute ή προεπιλογή).
  function applyServerConfig(cfg) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("bad config");

    var hex = normalizeHex(cfg.accentColor);
    if (hex) applyTheme(hex);

    var name = cleanText(cfg.botName, 60);
    if (name) panel.querySelector(".header-title").textContent = name;

    applyLogo(isSafeLogoUrl(cfg.logoUrl) ? cfg.logoUrl : null);

    // Η επικοινωνία ακολουθεί ΠΛΗΡΩΣ τον server: αν ο πελάτης την αφαίρεσε από τις
    // ρυθμίσεις, φεύγει και από το widget, ακόμα κι αν το παλιό snippet την έχει.
    contactLabel = cleanText(cfg.contactLabel, 40);
    contactUrl = isSafeContactUrl(cfg.contactUrl) ? cfg.contactUrl : null;
    contactPhone = validPhone(cfg.contactPhone) ? cfg.contactPhone.trim() : null;
    recomputeContact();
    syncContactBar();

    // Το badge κρύβεται ΜΟΝΟ με ρητό boolean false από τον server (Pro).
    setBranding(cfg.showBranding !== false);
  }

  var CONFIG_TIMEOUT_MS = 1500;
  var configApplied = false;

  function revealLauncher() {
    bubble.classList.remove("pending");
  }

  function loadServerConfig() {
    if (configMode === "off" || typeof fetch !== "function") {
      setBranding(true);
      revealLauncher();
      return;
    }
    // Αν ο server αργεί: εμφανίζουμε το widget με τα attributes και το badge
    // (ασφαλής προεπιλογή). Αν η απάντηση έρθει αργότερα, εφαρμόζεται τότε.
    var timer = setTimeout(function () {
      if (!configApplied) setBranding(true);
      revealLauncher();
    }, CONFIG_TIMEOUT_MS);

    fetch(BASE_URL + "/embed/" + encodeURIComponent(embedId) + "/config", { method: "GET", credentials: "omit" })
      .then(function (res) {
        if (!res.ok) throw new Error("config " + res.status);
        return res.json();
      })
      .then(function (cfg) {
        clearTimeout(timer);
        applyServerConfig(cfg);
        configApplied = true;
        revealLauncher();
      })
      .catch(function () {
        clearTimeout(timer);
        if (!configApplied) setBranding(true);
        revealLauncher();
      });
  }

  // Βήμα 1: ιστορικό συζήτησης. Το Gemini δεν θυμάται τίποτα από μόνο του,
  // οπότε στέλνουμε μαζί με κάθε νέα ερώτηση τα τελευταία μηνύματα (ρόλοι
  // "user"/"assistant", ίδιοι με το backend). Μένει ΜΟΝΟ στη μνήμη της
  // σελίδας: κλείσιμο/ανανέωση = νέα συζήτηση, τίποτα δεν αποθηκεύεται.
  // Θυμόμαστε μόνο ολοκληρωμένες ανταλλαγές -- όχι σφάλματα ή μήνυμα ορίου.
  var MAX_HISTORY_MESSAGES = 6;
  var MAX_HISTORY_MESSAGE_CHARS = 500;
  var chatHistory = [];

  function rememberExchange(question, answer) {
    chatHistory.push({ role: "user", text: question.slice(0, MAX_HISTORY_MESSAGE_CHARS) });
    chatHistory.push({ role: "assistant", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) });
    if (chatHistory.length > MAX_HISTORY_MESSAGES) chatHistory = chatHistory.slice(-MAX_HISTORY_MESSAGES);
  }

  async function sendQuestion() {
    var question = inputEl.value.trim();
    if (!question) return;
    inputEl.value = "";
    inputEl.disabled = true;
    sendBtn.disabled = true;

    addMessage("user", escapeHtml(question));
    var botEl = addMessage("bot", "…");
    var accumulatedText = "";

    try {
      var res = await fetch(BASE_URL + "/embed/" + encodeURIComponent(embedId) + "/query/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Χωρίς ιστορικό (πρώτη ερώτηση) το body μένει ακριβώς όπως πριν.
        body: JSON.stringify(chatHistory.length ? { question: question, history: chatHistory } : { question: question }),
      });

      // Section Q: το backend επιστρέφει 429 + {limitReached:true} ΠΡΙΝ
      // ξεκινήσει το SSE stream όταν ο πελάτης-ιδιοκτήτης έχει εξαντλήσει
      // το μηνιαίο του όριο μηνυμάτων -- το ελέγχουμε εδώ, πριν το γενικό
      // "!res.ok" branch παρακάτω, ώστε ο επισκέπτης να δει το σωστό,
      // γενικό μήνυμα (με τα στοιχεία επικοινωνίας του καταστήματος) αντί
      // για το ουδέτερο t.unavailable.
      if (res.status === 429) {
        var limitData = {};
        try {
          limitData = await res.json();
        } catch (parseErr) {
          // αγνόησε -- συνεχίζουμε στο γενικό unavailable branch παρακάτω
        }
        if (limitData.limitReached) {
          renderLimitReachedInto(botEl);
          return;
        }
      }

      if (!res.ok || !res.body) {
        botEl.innerHTML = escapeHtml(t.unavailable);
        return;
      }

      // Αυτόνομος SSE parser -- ΙΔΙΟ πρωτόκολλο με το backend
      // (buildStreamingQueryResponse στο index.js) και με το streamSSE()
      // του shared.js, αλλά αντιγραμμένο εδώ επίτηδες. Το widget.js πρέπει
      // να μείνει ένα αυτόνομο αρχείο, χωρίς εξωτερικές εξαρτήσεις.
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var finalEvent = null;

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        var boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          var rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          var line = rawEvent.trim();
          if (line.indexOf("data:") !== 0) continue;
          var jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;

          var evt;
          try {
            evt = JSON.parse(jsonStr);
          } catch (parseErr) {
            continue;
          }

          if (evt.type === "chunk") {
            accumulatedText += evt.text;
            botEl.innerHTML = formatAnswer(accumulatedText);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (evt.type === "done" || evt.type === "error") {
            finalEvent = evt;
          }
        }
      }

      if (!finalEvent || finalEvent.type === "error") {
        if (!accumulatedText) botEl.innerHTML = escapeHtml(t.unavailable);
      } else if (finalEvent.isFallback && hasContact) {
        addFallbackContactPrompt();
      }

      if (finalEvent && finalEvent.type === "done" && accumulatedText) {
        rememberExchange(question, accumulatedText);
      }
    } catch (err) {
      botEl.innerHTML = escapeHtml(t.genericError);
    } finally {
      inputEl.disabled = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  sendBtn.addEventListener("click", sendQuestion);
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") sendQuestion();
  });

  loadServerConfig();
})();