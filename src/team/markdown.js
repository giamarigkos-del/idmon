// src\team\markdown.js
// Από Markdown σε ΚΑΘΑΡΟ κείμενο, για ό,τι "διαβάζει" ο βοηθός και ο έλεγχος αντιφάσεων (ευρετήριο Vectorize, αποσπάσματα, επαλήθευση παραθεμάτων).
// Τα άρθρα αποθηκεύονται σε Markdown (το γράφει ο WYSIWYG editor), αλλά ο βοηθός πρέπει να βλέπει «σε δύο ημέρες» και όχι «σε **δύο** ημέρες»,
// και το παράθεμα ενός LLM («σε δύο ημέρες») πρέπει να ταιριάζει με το κείμενο. Ό,τι ΔΕΝ είναι Markdown (παλιά έγγραφα σκέτου κειμένου) μένει ως έχει.
//
// ΚΑΘΑΡΗ ΣΥΝΑΡΤΗΣΗ: χωρίς κανένα import, χωρίς πρόσβαση σε βάση ή δίκτυο. Δεν αποτελεί ΕΛΕΓΧΟ ΑΣΦΑΛΕΙΑΣ: η εμφάνιση του Markdown στους
// υπαλλήλους περνά από τον αυστηρό αναγνώστη του public\vendor\reader.js (DOMPurify με λίστα επιτρεπόμενων).

const SENTINEL = "\uE000"; // προστατευμένα κομμάτια (κώδικας): δεν αγγίζονται από τους υπόλοιπους κανόνες

// ΑΠΟΔΟΣΗ: κάθε regex που ψάχνει «κλείσιμο» (** ... **) έχει ΑΝΩΤΑΤΟ όριο απόστασης. Χωρίς όριο, ένα κείμενο με χιλιάδες ανοίγματα που δεν κλείνουν
// (**a **a **a ...) κάνει τετραγωνικό χρόνο. Μια μορφοποίηση μεγαλύτερη από MAXSPAN χαρακτήρες μένει όπως γράφτηκε (δεν αφαιρείται η σύνταξή της).
const MAXSPAN = 600;
const MAXLINE = 10000; // γραμμές μεγαλύτερες από αυτό δεν περνούν από τη μορφοποίηση inline (μένουν ως έχουν)

function trimEndBlanks(s) { let n = s.length; while (n > 0 && (s.charCodeAt(n - 1) === 32 || s.charCodeAt(n - 1) === 9)) n--; return n === s.length ? s : s.slice(0, n); }

const NAMED_ENTITIES = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

function decodeEntities(s) {
  return s.replace(/&(?:lt|gt|amp|quot|apos|nbsp|#39);/g, (m) => NAMED_ENTITIES[m] ?? m);
}

function inlineToText(line, codeSpans) {
  if (line.length > MAXLINE) return line;
  let s = line;
  // κώδικας μέσα στη γραμμή: προστατεύεται πρώτα, για να μη "διαβαστούν" ως Markdown τα * και _ που περιέχει
  s = s.replace(/`([^`\n]+)`/g, (_, code) => { codeSpans.push(code); return SENTINEL + "I" + (codeSpans.length - 1) + SENTINEL; });
  // εικόνες: μένει η περιγραφή (alt), ώστε ο βοηθός να ξέρει ότι υπάρχει εικόνα, χωρίς τη διεύθυνσή της
  s = s.replace(/!\[([^\]]*)\]\(\s*[^)\s]*(?:\s+"[^"]*")?\s*\)/g, (_, alt) => (alt.trim() ? "[Εικόνα: " + alt.trim() + "]" : "[Εικόνα]"));
  // σύνδεσμοι: κείμενο και (διεύθυνση), ώστε να μπορεί να τη δώσει ο βοηθός
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_, text, url) => (text.trim() === url ? url : text + " (" + url + ")"));
  s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, "$1");
  // έντονα, πλάγια, διαγραμμένα. Τα * και _ μετράνε ως μορφοποίηση μόνο στα όρια λέξης (όχι μέσα σε «5*3» ή «snake_case»)
  s = s.replace(new RegExp("\\*\\*\\*(?=\\S)([^]{1," + MAXSPAN + "}?)(?<=\\S)\\*\\*\\*", "g"), "$1");
  s = s.replace(new RegExp("\\*\\*(?=\\S)([^]{1," + MAXSPAN + "}?)(?<=\\S)\\*\\*", "g"), "$1");
  s = s.replace(new RegExp("(?<![\\p{L}\\p{N}_])__(?=\\S)([^]{1," + MAXSPAN + "}?)(?<=\\S)__(?![\\p{L}\\p{N}_])", "gu"), "$1");
  s = s.replace(new RegExp("(?<![\\p{L}\\p{N}*\\\\])\\*(?=[^\\s*])([^*\\n]{1," + MAXSPAN + "}?)(?<=[^\\s*])\\*(?![\\p{L}\\p{N}*])", "gu"), "$1");
  s = s.replace(new RegExp("(?<![\\p{L}\\p{N}_\\\\])_(?=[^\\s_])([^_\\n]{1," + MAXSPAN + "}?)(?<=[^\\s_])_(?![\\p{L}\\p{N}_])", "gu"), "$1");
  s = s.replace(new RegExp("~~(?=\\S)([^]{1," + MAXSPAN + "}?)(?<=\\S)~~", "g"), "$1");
  // ξεφευγμένοι χαρακτήρες (\* \_ \# ...): ο ίδιος ο editor τους βάζει για να μη διαβαστούν ως μορφοποίηση
  s = s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  return decodeEntities(s);
}

export function markdownToPlainText(input) {
  let s = String(input == null ? "" : input).replace(/\r\n?/g, "\n").split(SENTINEL).join("");
  if (!s.trim()) return "";

  // 1) πλαισιωμένος κώδικας: μένει το περιεχόμενο, φεύγουν οι ```
  const blocks = [];
  s = s.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]{0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm, (_, _f, body) => {
    blocks.push(body); return SENTINEL + "B" + (blocks.length - 1) + SENTINEL;
  });

  // 2) γραμμή προς γραμμή: τίτλοι, παράθεμα, λίστες, πίνακες, οριζόντιες γραμμές
  const spans = [];
  const out = [];
  let prevWasTableRow = false;
  for (const raw of s.split("\n")) {
    let line = raw;
    // γραμμή διαχωρισμού πίνακα (| --- | --- |). Πρώτα τα φθηνά τεστ και trim: η regex πάνω σε μακριά σειρά από κενά θα ήταν τετραγωνική.
    if (prevWasTableRow && line.length <= MAXLINE) {
      const tl = line.trim();
      if (tl.indexOf("|") >= 0 && tl.indexOf("-") >= 0 && /^\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?$/.test(tl)) { prevWasTableRow = false; continue; }
    }
    if (/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) { prevWasTableRow = false; out.push(""); continue; } // οριζόντια γραμμή
    const isRow = /^[ \t]*\|.*\|[ \t]*$/.test(line);
    if (isRow) {
      line = line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim()).join(" | ");
    }
    prevWasTableRow = isRow;
    line = line.replace(/^[ \t]{0,3}(?:>[ \t]?)+/, "");
    line = line.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/, "$1");
    line = line.replace(/^([ \t]*)[*+][ \t]+/, "$1- ");
    line = inlineToText(line, spans);
    out.push(trimEndBlanks(line).replace(/\\$/, ""));
  }
  s = out.join("\n");

  // 3) επαναφορά κώδικα, καθάρισμα κενών γραμμών
  s = s.replace(new RegExp(SENTINEL + "I(\\d+)" + SENTINEL, "g"), (_, i) => spans[Number(i)]);
  s = s.replace(new RegExp(SENTINEL + "B(\\d+)" + SENTINEL, "g"), (_, i) => blocks[Number(i)]);
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
