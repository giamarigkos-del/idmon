// tools\vendor-build\src\reader-entry.js
// ΑΥΣΤΗΡΟΣ ΑΝΑΓΝΩΣΤΗΣ άρθρων (Markdown -> ασφαλές HTML). Χρησιμοποιείται από τη σελίδα ανάγνωσης και από την ανάγνωση μέσα στον editor.
// ΑΥΤΟ ΕΙΝΑΙ ΤΟ ΣΗΜΕΙΟ ΑΣΦΑΛΕΙΑΣ για ό,τι εμφανίζεται στους υπαλλήλους. Τρία επίπεδα:
//   1) το ωμό HTML μέσα στο Markdown ΔΕΝ γίνεται ποτέ HTML (εμφανίζεται ως κείμενο),
//   2) εικόνες μόνο από τον δικό μας endpoint (/team/media/<id>), σύνδεσμοι μόνο http, https, mailto, #,
//   3) το DOMPurify κόβει ό,τι δεν είναι στη λίστα επιτρεπόμενων ετικετών και attributes.
// Αν αλλάξεις κάτι εδώ, ξανατρέξε το tests\team.test.mjs (ενότητα 35): έχει επιθέσεις XSS και μεταλλάξεις.
import { Marked } from "marked";
import DOMPurify from "dompurify";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MEDIA_RE = /^\/team\/media\/[A-Za-z0-9_-]{1,64}$/;
const LINK_RE = /^(https?:\/\/|mailto:|#)/i;

const marked = new Marked({ gfm: true, breaks: true }); // breaks: τα παλιά έγγραφα (σκέτο κείμενο) κρατούν τις αλλαγές γραμμής τους
marked.use({
  renderer: {
    html(token) { return esc(token.text != null ? token.text : token.raw); },
    image(token) {
      const href = String(token.href || "");
      return MEDIA_RE.test(href) ? '<img src="' + esc(href) + '" alt="' + esc(token.text) + '" loading="lazy">' : esc(token.text);
    },
    link(token) {
      const href = String(token.href || "");
      const inner = this.parser.parseInline(token.tokens);
      return LINK_RE.test(href) ? '<a href="' + esc(href) + '" rel="noopener noreferrer nofollow" target="_blank">' + inner + "</a>" : inner;
    },
    table(token) {
      // ο πίνακας μπαίνει μέσα σε περιτύλιγμα που κυλά οριζόντια, ώστε να μην ξεχειλίζει σε κινητό
      return '<div class="table-wrap">' + Object.getPrototypeOf(this).table.call(this, token) + "</div>";
    },
  },
});

const CONFIG = {
  ALLOWED_TAGS: ["h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "div"],
  ALLOWED_ATTR: ["href", "src", "alt", "rel", "target", "loading", "class", "colspan", "rowspan", "start"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false, // το κείμενο ενός άρθρου δεν χρειάζεται aria-*: ο συντάκτης δεν μπορεί να κρύψει ή να αλλάξει περιεχόμενο για τους αναγνώστες οθόνης
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/team\/media\/)/i,
};

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) { node.setAttribute("rel", "noopener noreferrer nofollow"); node.setAttribute("target", "_blank"); }
  // Εικόνα που ΔΕΝ είναι από τον δικό μας endpoint (/team/media/<id>) αφαιρείται ΑΚΟΜΑ ΚΑΙ ΑΝ έφτασε ως εδώ: δεύτερη γραμμή άμυνας, ανεξάρτητη από τον renderer.
  if (node.tagName === "IMG" && !MEDIA_RE.test(node.getAttribute("src") || "")) { node.remove(); return; }
  if (node.tagName === "IMG") node.setAttribute("loading", "lazy"); // οι εικόνες φορτώνουν όταν πλησιάσει ο αναγνώστης (γρήγορη σελίδα σε κινητό)
  // η κλάση επιτρέπεται ΜΟΝΟ στο περιτύλιγμα πίνακα που φτιάχνουμε εμείς (τίποτε άλλο δεν παίρνει class)
  if (node.hasAttribute && node.hasAttribute("class") && !(node.tagName === "DIV" && node.getAttribute("class") === "table-wrap")) node.removeAttribute("class");
});

// Markdown -> HTML string (ασφαλές)
function render(markdown) { return DOMPurify.sanitize(marked.parse(String(markdown == null ? "" : markdown)), CONFIG); }

// Βάζει το άρθρο μέσα στο στοιχείο και επιστρέφει τους τίτλους (h2, h3) για τα περιεχόμενα. Τα id μπαίνουν από ΕΜΑΣ (h-1, h-2...), ποτέ από το κείμενο.
function renderInto(el, markdown) {
  const frag = DOMPurify.sanitize(marked.parse(String(markdown == null ? "" : markdown)), Object.assign({}, CONFIG, { RETURN_DOM_FRAGMENT: true }));
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(frag);
  const headings = [];
  el.querySelectorAll("h2, h3").forEach((h, i) => {
    h.id = "h-" + (i + 1);
    headings.push({ id: h.id, level: Number(h.tagName.slice(1)), text: h.textContent });
  });
  return headings;
}

// sanitize: ΜΟΝΟ η δεύτερη γραμμή άμυνας (DOMPurify με τη λίστα επιτρεπόμενων) πάνω σε έτοιμο HTML. Υπάρχει για να δοκιμάζεται ΞΕΧΩΡΙΣΤΑ από τον renderer
// (ο renderer κόβει το ωμό HTML πριν φτάσει στο DOMPurify, οπότε χωρίς αυτήν η λίστα επιτρεπόμενων δεν θα ελεγχόταν ποτέ).
function sanitize(html) { return DOMPurify.sanitize(String(html == null ? "" : html), CONFIG); }

globalThis.IdmonReader = { render, renderInto, sanitize, version: 1 };
