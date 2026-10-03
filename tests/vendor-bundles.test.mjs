// tests\vendor-bundles.test.mjs
// ΓΡΗΓΟΡΑ τεστ των δύο αρχείων public\vendor (reader.js: ο αυστηρός αναγνώστης άρθρων, editor.js: ο WYSIWYG επεξεργαστής). Χωρίς Worker, χωρίς βάση, χωρίς δίκτυο:
// τρέχουν σε καθαρό jsdom, σε λίγα δευτερόλεπτα. Τρέξε:  node tests\vendor-bundles.test.mjs
// Τα ίδια αυτά αρχεία δοκιμάζονται και μέσα στις σελίδες (tests\team.test.mjs, ενότητες 35 και 36).
// Για μεταλλάξεις: IDMON_READER_BUNDLE και IDMON_EDITOR_BUNDLE δείχνουν σε άλλο αρχείο bundle (διαφορετικό από το public\vendor).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { JSDOM: JSDOMu, VirtualConsole: VCu } = await import("jsdom");

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failures.push(name); console.log("  FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}
const section = (t) => console.log("\n" + t);

const READER_SRC = readFileSync(process.env.IDMON_READER_BUNDLE || join(REPO, "public", "vendor", "reader.js"), "utf8");
const EDITOR_SRC = readFileSync(process.env.IDMON_EDITOR_BUNDLE || join(REPO, "public", "vendor", "editor.js"), "utf8");
const JSDOM_POLY = "Range.prototype.getClientRects = function () { return { length: 0, item: function () { return null; }, [Symbol.iterator]: function* () {} }; };\nRange.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; };\ndocument.elementFromPoint = function () { return null; };";

section("A. Αναγνώστης άρθρων (reader.js): ΑΥΣΤΗΡΟΣ καθαρισμός, επιθέσεις XSS, τίτλοι");
{
  const rw = () => { const w = new JSDOMu("<!DOCTYPE html><html><body><div id='r'></div></body></html>", { runScripts: "outside-only", pretendToBeVisual: true }).window; w.eval(READER_SRC); return w; };
  const w0 = rw();
  const R = w0.IdmonReader;
  check("αναγνώστης: φορτώνει και δίνει render, renderInto", !!R && typeof R.render === "function" && typeof R.renderInto === "function");
  const holder = (html) => { const d = w0.document.createElement("div"); d.innerHTML = html; return d; };
  const dangerous = (html) => {
    const d = holder(html);
    const tags = d.querySelectorAll("script,iframe,style,svg,video,audio,object,embed,form,input,button,link,meta,base,math").length;
    const attrs = [...d.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.name + "=" + a.value)).filter((a) => /^on|^style|javascript:|data:|vbscript:/i.test(a));
    const imgs = [...d.querySelectorAll("img")].map((i) => i.getAttribute("src")).filter((s) => !/^\/team\/media\/[A-Za-z0-9_-]{1,64}$/.test(s));
    const hrefs = [...d.querySelectorAll("a")].map((a) => a.getAttribute("href")).filter((h) => !/^(https?:\/\/|mailto:|#)/i.test(h));
    return { tags, attrs, imgs, hrefs };
  };
  const ATTACKS = [
    ["script", "Πριν <script>window.__x=1</script> μετά"],
    ["img onerror", "<img src=x onerror=\"window.__x=1\"> κείμενο"],
    ["javascript: σύνδεσμος", "[κλικ](javascript:window.__x=1)"],
    ["javascript: εικόνα", "![x](javascript:window.__x=1)"],
    ["html a javascript:", "<a href=\"javascript:window.__x=1\">x</a>"],
    ["iframe", "<iframe src=\"https://evil.example\"></iframe>"],
    ["div onclick", "<div onclick=\"window.__x=1\">δοκιμή</div>"],
    ["svg onload", "<svg onload=\"window.__x=1\"></svg>"],
    ["εικόνα data: svg", "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)"],
    ["εικόνα από άλλο site", "![x](https://evil.example/a.png)"],
    ["σύνδεσμος με attribute", "[x](https://a.gr \"t\" onmouseover=\"window.__x=1\")"],
    ["style", "<style>body{display:none}</style>κείμενο"],
    ["video onerror", "<video src=x onerror=1></video>"],
    ["σύνδεσμος vbscript:", "[x](vbscript:msgbox(1))"],
    ["σύνδεσμος με κενά/κεφαλαία JaVaScRiPt:", "[x]( JaVaScRiPt:alert(1))"],
    ["form και input", "<form action=\"https://evil.example\"><input name=p></form>"],
    ["math/mXSS", "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>"],
    ["meta refresh", "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\">"],
    ["base", "<base href=\"https://evil.example/\">"],
    ["εικόνα με /team/media/ και path traversal", "![x](/team/media/../../etc/passwd)"],
    ["εικόνα /team/media/ με παραμέτρους", "![x](/team/media/ok?x=1&y=2)"],
  ];
  const bad = [];
  for (const [name, md] of ATTACKS) { const r = dangerous(R.render(md)); if (r.tags || r.attrs.length || r.imgs.length || r.hrefs.length) bad.push([name, r]); }
  check("αναγνώστης: " + ATTACKS.length + " επιθέσεις (script, onerror, javascript:, iframe, svg, style, εικόνες από άλλο site, κ.ά.) ΚΑΜΙΑ δεν δίνει επικίνδυνο στοιχείο, attribute ή διεύθυνση", bad.length === 0, bad);
  // ΔΕΥΤΕΡΗ ΓΡΑΜΜΗ ΑΜΥΝΑΣ: το DOMPurify ΜΟΝΟ του, με ωμό HTML (ο renderer το κόβει πριν φτάσει εκεί, γι' αυτό δοκιμάζεται ξεχωριστά)
  {
    const S = (h) => holder(R.sanitize(h));
    const cases = [
      ["iframe", "<iframe src=\"https://evil.example\"></iframe>x", (d) => !d.querySelector("iframe")],
      ["script", "<script>window.__x=1</script>x", (d) => !d.querySelector("script")],
      ["img onerror με εξωτερικό src", "<img src=x onerror=\"window.__x=1\">", (d) => !d.querySelector("img")],
      ["εικόνα από άλλο site (https)", "<img src=\"https://evil.example/a.png\" alt=\"y\">", (d) => !d.querySelector("img")],
      ["εικόνα /team/media/ κρατιέται, χωρίς onerror, με lazy", "<img src=\"/team/media/ok\" alt=\"y\" onerror=\"window.__x=1\">", (d) => d.querySelectorAll("img").length === 1 && d.querySelector("img").getAttribute("src") === "/team/media/ok" && !d.querySelector("img").hasAttribute("onerror") && d.querySelector("img").getAttribute("loading") === "lazy"],
      ["javascript: href", "<a href=\"javascript:window.__x=1\">x</a>", (d) => !d.querySelector("a[href]")],
      ["vbscript: href", "<a href=\"vbscript:msgbox(1)\">x</a>", (d) => !d.querySelector("a[href]")],
      ["data: href", "<a href=\"data:text/html,<script>1</script>\">x</a>", (d) => !d.querySelector("a[href]")],
      ["svg onload", "<svg onload=\"window.__x=1\"><circle/></svg>", (d) => !d.querySelector("svg") && ![...d.querySelectorAll("*")].some((e) => e.hasAttribute("onload"))],
      ["form και input", "<form action=\"https://evil.example\"><input name=p></form>", (d) => !d.querySelector("form,input")],
      ["class, id και style δεν περνούν", "<div class=\"user-menu\" id=\"logout\" style=\"position:fixed\">y</div>", (d) => !d.querySelector("[class],[id],[style]")],
      ["data-* και ARIA δεν περνούν", "<p data-x=\"1\" aria-hidden=\"true\" contenteditable=\"true\">t</p>", (d) => ![...d.querySelectorAll("*")].some((e) => [...e.attributes].some((a) => /^(data-|aria-|contenteditable)/.test(a.name)))],
      ["onclick σε σύνδεσμο φεύγει, rel μπαίνει", "<a href=\"https://a.gr\" onclick=\"window.__x=1\">z</a>", (d) => d.querySelector("a").getAttribute("href") === "https://a.gr" && !d.querySelector("a").hasAttribute("onclick") && d.querySelector("a").getAttribute("rel") === "noopener noreferrer nofollow" && d.querySelector("a").getAttribute("target") === "_blank"],
      ["style, link, meta, base, math, object, embed, video, audio", "<style>x{}</style><link rel=stylesheet href=x><meta http-equiv=refresh content=0><base href=x><math><mi>x</mi></math><object data=x></object><embed src=x><video src=x></video><audio src=x></audio>ok", (d) => !d.querySelector("style,link,meta,base,math,object,embed,video,audio") && /ok/.test(d.textContent)],
      ["το table-wrap κρατά ΜΟΝΟ τη δική μας κλάση", "<div class=\"table-wrap\"><table><tr><td class=\"x\">a</td></tr></table></div>", (d) => d.querySelectorAll("[class]").length === 1 && d.querySelector("[class]").getAttribute("class") === "table-wrap" && !!d.querySelector("td")],
      ["επιτρεπτά στοιχεία μένουν (h2, p, strong, ul, li, blockquote, pre, code)", "<h2>a</h2><p><strong>b</strong></p><ul><li>c</li></ul><blockquote>d</blockquote><pre><code>e</code></pre>", (d) => !!d.querySelector("h2") && !!d.querySelector("strong") && !!d.querySelector("li") && !!d.querySelector("blockquote") && !!d.querySelector("pre code")],
    ];
    const failed = cases.filter(([, h, ok]) => { try { return !ok(S(h)); } catch { return true; } }).map(([n]) => n);
    check("αναγνώστης, ΔΕΥΤΕΡΗ ΓΡΑΜΜΗ ΑΜΥΝΑΣ (DOMPurify ΜΟΝΟ του, ωμό HTML): " + cases.length + " περιπτώσεις (iframe, script, εικόνες εκτός /team/media/, javascript:, vbscript:, data:, svg, form, class, id, style, data-*, onclick, style/link/meta/base/math/object/embed/video/audio) κόβονται, τα επιτρεπτά μένουν", failed.length === 0, failed);
  }
  check("αναγνώστης: το ωμό HTML δεν χάνεται σιωπηλά, εμφανίζεται ως ΚΕΙΜΕΝΟ (ο συντάκτης βλέπει τι έγραψε)", /<script>window\.__x=1<\/script>/.test(holder(R.render("Πριν <script>window.__x=1</script> μετά")).textContent));
  check("αναγνώστης: εικόνα από /team/media/<id> επιτρέπεται, με alt και lazy", /<img src="\/team\/media\/m-1" alt="Στιγμιότυπο" loading="lazy">/.test(R.render("![Στιγμιότυπο](/team/media/m-1)")), R.render("![Στιγμιότυπο](/team/media/m-1)"));
  check("αναγνώστης: εικόνα από άλλο site ΔΕΝ γίνεται εικόνα (μένει η περιγραφή της)", !/<img/.test(R.render("![Εξωτερική](https://evil.example/a.png)")) && /Εξωτερική/.test(R.render("![Εξωτερική](https://evil.example/a.png)")));
  const linkHtml = R.render("[οδηγίες](https://example.com/x) και [mail](mailto:a@b.gr)");
  check("αναγνώστης: οι σύνδεσμοι http, https, mailto δουλεύουν και ανοίγουν σε νέα καρτέλα με rel=noopener noreferrer nofollow", holder(linkHtml).querySelectorAll("a[target=_blank][rel='noopener noreferrer nofollow']").length === 2, linkHtml);
  const tbl = R.render("| Α | Β |\n| --- | --- |\n| 1 | 2 |");
  check("αναγνώστης: ο πίνακας μπαίνει μέσα σε περιτύλιγμα .table-wrap (κυλά οριζόντια σε κινητό)", /^<div class="table-wrap"><table>/.test(tbl) && /<th>Α<\/th>/.test(tbl), tbl);
  check("αναγνώστης: ΚΑΜΙΑ κλάση δεν περνά από το κείμενο (ο συντάκτης δεν μπορεί να χρησιμοποιήσει κλάσεις της σελίδας, π.χ. user-menu)", holder(R.render("<div class=\"user-menu\">x</div>\n\n<p class=\"btn\">y</p> ![z](/team/media/a)")).querySelectorAll("[class]").length === 0);
  check("αναγνώστης: παλιό κείμενο σκέτου κειμένου κρατά τις αλλαγές γραμμής του (<br>)", /Βήμα 1: άνοιξε<br>\s*Βήμα 2: πάτα/.test(R.render("Βήμα 1: άνοιξε\nΒήμα 2: πάτα")), R.render("Βήμα 1: άνοιξε\nΒήμα 2: πάτα"));
  check("αναγνώστης: κενό, null και undefined δίνουν κενό", R.render("") === "" && R.render(null) === "" && R.render(undefined) === "");
  const box = w0.document.getElementById("r");
  const hs = R.renderInto(box, "# Τίτλος\n\n## Ένα\n\nκείμενο\n\n### Δύο\n\n## Τρία");
  check("αναγνώστης: renderInto επιστρέφει τους τίτλους h2 και h3 με δικά μας id (h-1, h-2, h-3), όχι τον h1", JSON.stringify(hs) === JSON.stringify([{ id: "h-1", level: 2, text: "Ένα" }, { id: "h-2", level: 3, text: "Δύο" }, { id: "h-3", level: 2, text: "Τρία" }]) && !!box.querySelector("#h-3"), hs);
  const hs2 = R.renderInto(box, "## <img src=x onerror=1> κακός \"τίτλος\" id=\"x\"");
  check("αναγνώστης: τα id των τίτλων τα βάζουμε ΕΜΕΙΣ (h-N), δεν παίρνονται ποτέ από το κείμενο", hs2.length === 1 && hs2[0].id === "h-1" && !box.querySelector("[id='x']"));
  R.renderInto(box, "πρώτο");
  R.renderInto(box, "δεύτερο");
  check("αναγνώστης: το renderInto αντικαθιστά το προηγούμενο περιεχόμενο (δεν συσσωρεύει)", box.textContent.trim() === "δεύτερο");
}

section("B. Επεξεργαστής άρθρων (editor.js): εντολές μορφοποίησης, Markdown, σύνδεσμοι, πίνακες, επικόλληση εικόνων");
{
  const ew = () => { const w = new JSDOMu("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VCu() }).window; w.eval(JSDOM_POLY); w.eval(EDITOR_SRC); return w; };
  const w1 = ew();
  const mk = (md, extra = {}) => { const host = w1.document.createElement("div"); w1.document.body.appendChild(host); return { host, ed: w1.IdmonEditor.create(host, { markdown: md, ...extra }) }; };
  check("editor: φορτώνει (IdmonEditor.create)", typeof (w1.IdmonEditor || {}).create === "function");
  { const { ed } = mk("Κείμενο"); ed.selectAll(); ed.exec("bold"); check("editor: «Έντονα» δίνει **κείμενο** στο Markdown", ed.getMarkdown() === "**Κείμενο**", ed.getMarkdown()); ed.exec("bold"); ed.exec("italic"); check("editor: «Πλάγια» δίνει *κείμενο*", ed.getMarkdown() === "*Κείμενο*", ed.getMarkdown()); }
  { const { ed } = mk("Κείμενο"); ed.selectAll(); ed.exec("h2"); check("editor: «Τίτλος» δίνει ## και «Υπότιτλος» δίνει ###", /^## Κείμενο/.test(ed.getMarkdown()) && (ed.exec("h2"), ed.exec("h3"), /^### Κείμενο/.test(ed.getMarkdown())), ed.getMarkdown()); }
  { const { ed } = mk("Ένα\n\nΔύο"); ed.selectAll(); ed.exec("bulletList"); check("editor: «Λίστα» δίνει - στοιχεία", /^- Ένα\n- Δύο/.test(ed.getMarkdown()), ed.getMarkdown()); ed.exec("bulletList"); ed.exec("orderedList"); check("editor: «Αρίθμηση» δίνει 1. 2.", /^1\. Ένα\n2\. Δύο/.test(ed.getMarkdown()), ed.getMarkdown()); }
  { const { ed } = mk("Σημαντικό"); ed.selectAll(); ed.exec("blockquote"); check("editor: «Παράθεμα» δίνει > ", /^> Σημαντικό/.test(ed.getMarkdown()), ed.getMarkdown()); }
  { const { ed } = mk("x"); ed.selectAll(); const bad = [ed.setLink("javascript:alert(1)"), ed.setLink("data:text/html,x"), ed.setLink("//evil.example"), ed.setLink("ftp://x.gr"), ed.setLink(""), ed.setLink("   ")];
    check("editor: σύνδεσμος javascript:, data:, //, ftp:, κενός ΑΠΟΡΡΙΠΤΕΤΑΙ", bad.every((r) => r.ok === false) && ed.getMarkdown() === "x", [bad, ed.getMarkdown()]);
    check("editor: σύνδεσμος https:// και mailto: γίνονται δεκτοί", ed.setLink("https://a.gr/x").ok === true && ed.getMarkdown() === "[x](https://a.gr/x)" && (ed.selectAll(), ed.setLink("mailto:a@b.gr").ok === true) && /\(mailto:a@b\.gr\)/.test(ed.getMarkdown()), ed.getMarkdown()); }
  { const { ed } = mk("x"); const r = ed.exec("table"); check("editor: «Πίνακας» βάζει πίνακα 3 επί 3 με γραμμή επικεφαλίδας και το state.table γίνεται true", r === true && ed.state().table === true && /\|\s+\|\s+\|\s+\|\n\| -+ \| -+ \| -+ \|/.test(ed.getMarkdown()), ed.getMarkdown());
    ed.exec("tableAddRow"); ed.exec("tableAddCol"); check("editor: προσθήκη γραμμής και στήλης στον πίνακα", (ed.getMarkdown().match(/^\|/gm) || []).length === 5 && /\|[^\n]*\|[^\n]*\|[^\n]*\|[^\n]*\|/.test(ed.getMarkdown()), ed.getMarkdown());
    ed.exec("tableDelete"); check("editor: «Διαγραφή πίνακα» τον αφαιρεί", ed.state().table === false && !/\|/.test(ed.getMarkdown()), ed.getMarkdown()); }
  { const { ed } = mk("abc"); ed.selectAll(); ed.exec("bold"); ed.exec("undo"); check("editor: «Αναίρεση» και «Επανάληψη»", ed.getMarkdown() === "abc" && ed.state().canRedo === true && (ed.exec("redo"), ed.getMarkdown() === "**abc**")); }
  { const { host, ed } = mk("Βήμα 1: άνοιξε\nΒήμα 2: πάτα\n\nΝέα παράγραφος"); const md = ed.getMarkdown(); check("editor: παλιό κείμενο με αλλαγές γραμμής ΔΕΝ χάνει γραμμές: γίνονται ΑΛΛΑΓΕΣ ΓΡΑΜΜΗΣ (br) μέσα στην παράγραφο, όχι κενό ανάμεσα στις λέξεις", /Βήμα 1: άνοιξε {2}\nΒήμα 2: πάτα/.test(md) && /\n\nΝέα παράγραφος/.test(md) && !!host.querySelector(".ProseMirror p br:not(.ProseMirror-trailingBreak)"), [md, host.innerHTML]);
    const again = w1.document.createElement("div"); w1.document.body.appendChild(again); const ed2 = w1.IdmonEditor.create(again, { markdown: md }); check("editor: δεύτερη αποθήκευση του ίδιου κειμένου δεν αλλάζει τίποτα (σταθερό)", ed2.getMarkdown() === md, [md, ed2.getMarkdown()]); }
  { const { ed } = mk("# Τίτλος\n\n- α\n- β\n\n| Χ | Ψ |\n| --- | --- |\n| 1 | 2 |"); check("editor: ανοίγει Markdown με τίτλο, λίστα και πίνακα και το επιστρέφει ίδιο ως περιεχόμενο", /^# Τίτλος/.test(ed.getMarkdown()) && /- α\n- β/.test(ed.getMarkdown()) && /\| Χ\s+\| Ψ\s+\|/.test(ed.getMarkdown()), ed.getMarkdown()); }
  { const { ed } = mk("Κείμενο με ![Στιγμιότυπο](/team/media/m-1) εικόνα"); check("editor: εικόνα /team/media/ στο Markdown ΔΕΝ χάνεται στην αποθήκευση (καμία απώλεια δεδομένων)", /!\[Στιγμιότυπο\]\(\/team\/media\/m-1\)/.test(ed.getMarkdown()), ed.getMarkdown()); }
  { const { ed } = mk("<script>window.__x=1</script> κείμενο <img src=x onerror=\"window.__x=1\">"); check("editor: ωμό HTML στο κείμενο δεν γίνεται στοιχείο στον editor (καμία script ή img με onerror)", !w1.document.querySelector("script[src],.ProseMirror script") && ![...w1.document.querySelectorAll(".ProseMirror img")].some((i) => i.hasAttribute("onerror")) && w1.__x === undefined); }
  // επικόλληση αρχείων εικόνας
  { const got = []; const { host, ed } = mk("αρχικό", { onImageFiles: (f) => got.push(f.map((x) => x.type)) }); const pm = host.querySelector(".ProseMirror");
    const paste = (files) => { const ev = new w1.Event("paste", { bubbles: true, cancelable: true }); Object.defineProperty(ev, "clipboardData", { value: { files, types: ["Files"], items: [], getData: () => "" } }); pm.dispatchEvent(ev); return ev.defaultPrevented; };
    const rPng = paste([{ type: "image/png", name: "a.png" }]), rJpg = paste([{ type: "image/jpeg", name: "a.jpg" }]), rWebp = paste([{ type: "image/webp", name: "a.webp" }]), rGif = paste([{ type: "image/gif", name: "a.gif" }]);
    const rSvg = paste([{ type: "image/svg+xml", name: "a.svg" }]), rPdf = paste([{ type: "application/pdf", name: "a.pdf" }]), rHtml = paste([{ type: "text/html", name: "a.html" }]);
    check("editor: επικόλληση png, jpeg, webp, gif περνά από το δικό μας σημείο (η Φάση 2 θα τα ανεβάζει) και δεν μπαίνει τίποτα στο κείμενο", rPng && rJpg && rWebp && rGif && got.length === 4 && ed.getMarkdown() === "αρχικό", got);
    check("editor: επικόλληση SVG, PDF ή HTML ως αρχείο ΔΕΝ γίνεται δεκτή ως εικόνα (το SVG μπορεί να φέρει κώδικα)", !rSvg && !rPdf && !rHtml && got.length === 4); }
}

console.log("\n" + "=".repeat(60));
if (failures.length) {
  console.log(`ΑΠΟΤΥΧΙΑ: ${failures.length} τεστ απέτυχαν, ${passed} πέρασαν.`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log(`ΟΛΑ ΤΑ ΤΕΣΤ ΠΕΡΑΣΑΝ: ${passed}`);
