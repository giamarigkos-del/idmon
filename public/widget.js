// widget.js -- embeddable chat widget (Section I: embed layer).
//
// Χρήση σε ξένο site:
//   <script src="https://operations-portal-rag.giamarigkos.workers.dev/widget.js"
//           data-embed-id="emb-xxxxxxxxxxxx"></script>
//
// Προαιρετικά data-* attributes: data-accent-color, data-bot-name, data-lang
// ("el"/"en"), data-position ("bottom-right"/"bottom-left").
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
  var accentColor = scriptTag.getAttribute("data-accent-color") || "#6B7280";
  var botName = scriptTag.getAttribute("data-bot-name") || "Assistant";
  var lang = (scriptTag.getAttribute("data-lang") || "el").toLowerCase();
  var position = scriptTag.getAttribute("data-position") === "bottom-left" ? "bottom-left" : "bottom-right";

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
  style.textContent =
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}" +
    ".bubble{position:fixed;bottom:20px;" + sideProp + ":20px;width:56px;height:56px;border-radius:50%;" +
    "background:" + accentColor + ";color:#fff;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);" +
    "z-index:2147483647;display:flex;align-items:center;justify-content:center;font-size:26px;}" +
    ".panel{position:fixed;bottom:88px;" + sideProp + ":20px;width:340px;max-width:calc(100vw - 40px);" +
    "height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:12px;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;" +
    "z-index:2147483647;}" +
    ".panel.open{display:flex;}" +
    ".header{background:" + accentColor + ";color:#fff;padding:14px 16px;display:flex;" +
    "flex-direction:column;gap:2px;}" +
    ".header-top{display:flex;align-items:center;justify-content:space-between;}" +
    ".header-title{font-size:14.5px;font-weight:700;}" +
    ".header-sub{font-size:11px;opacity:.85;}" +
    ".close-btn{background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;padding:2px 4px;}" +
    ".messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f7f7f8;}" +
    ".msg{max-width:82%;padding:9px 12px;border-radius:10px;font-size:13.5px;line-height:1.45;word-wrap:break-word;}" +
    ".msg.user{align-self:flex-end;background:" + accentColor + ";color:#fff;border-bottom-right-radius:2px;}" +
    ".msg.bot{align-self:flex-start;background:#fff;color:#1a1a1a;border:1px solid #e3e3e6;border-bottom-left-radius:2px;}" +
    ".msg.fallback-contact{align-self:flex-start;max-width:92%;background:#fff;color:#1a1a1a;" +
    "border:1px solid #e3e3e6;border-left:3px solid " + accentColor + ";border-bottom-left-radius:2px;}" +
    ".fallback-contact-text{margin-bottom:6px;}" +
    ".contact-bar{display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px;background:#fff;border-bottom:1px solid #e3e3e6;}" +
    ".contact-link{display:inline-block;font-size:11.5px;font-weight:700;color:#fff;background:" + accentColor + ";" +
    "padding:4px 10px;border-radius:12px;text-decoration:none;white-space:nowrap;}" +
    ".contact-link:hover{opacity:.85;}" +
    ".input-row{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e3e6;background:#fff;}" +
    ".input-row input{flex:1;border:1px solid #d8d8dc;border-radius:8px;padding:9px 10px;font-size:13.5px;outline:none;}" +
    ".input-row input:focus{border-color:" + accentColor + ";}" +
    ".input-row button{background:" + accentColor + ";color:#fff;border:none;border-radius:8px;" +
    "padding:0 14px;font-size:13px;font-weight:600;cursor:pointer;}" +
    ".input-row button:disabled{opacity:.5;cursor:default;}";
  root.appendChild(style);

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
  bubble.className = "bubble";
  bubble.type = "button";
  bubble.setAttribute("aria-label", t.openLabel);
  bubble.textContent = "💬";
  root.appendChild(bubble);

  var panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML =
    '<div class="header">' +
    '  <div class="header-top">' +
    '    <span class="header-title"></span>' +
    '    <button type="button" class="close-btn" aria-label=""></button>' +
    "  </div>" +
    '  <span class="header-sub"></span>' +
    "</div>" +
    (hasContact ? '<div class="contact-bar">' + contactLinksHtml() + "</div>" : "") +
    '<div class="messages"></div>' +
    '<div class="input-row">' +
    '  <input type="text" />' +
    "  <button type=\"button\"></button>" +
    "</div>";
  root.appendChild(panel);

  panel.querySelector(".header-title").textContent = botName;
  panel.querySelector(".header-sub").textContent = "🤖 " + t.disclosure;
  panel.querySelector(".close-btn").textContent = "✕";
  panel.querySelector(".close-btn").setAttribute("aria-label", t.closeLabel);
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

  // Ελάχιστη μορφοποίηση **bold** -> <strong>, ίδια λογική με το
  // formatAnswer() του κύριου εργαλείου (shared.js), αντιγραμμένη εδώ
  // επίτηδες -- το widget.js πρέπει να μείνει ένα αυτόνομο αρχείο, χωρίς
  // εξωτερικές εξαρτήσεις (φορτώνεται σε ξένο site, όχι στο δικό μας).
  function formatAnswer(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

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
        body: JSON.stringify({ question: question }),
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
})();