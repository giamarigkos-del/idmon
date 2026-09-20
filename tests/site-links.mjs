// Έλεγχος της δημόσιας βιτρίνας του idmon.app (site/): (1) το site/ είναι ακριβώς ό,τι θα έφτιαχνε
// το sync από το public/, (2) κανένα εσωτερικό link δεν είναι σπασμένο, (3) δεν διαρρέει τίποτα από
// την εφαρμογή, (4) οι νομικές σελίδες φαίνονται από την πλοήγηση, όπως ζητά το Paddle.
// Χρήση (PowerShell, από τον φάκελο idmon):   node tests/site-links.mjs
// Προαιρετικά: $env:SITE_ROOT = "C:\\...\\idmon"
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(process.env.SITE_ROOT || ".");
const { SITE_FILES, SITE_INDEX_SOURCE, SITE_HEADERS, syncSite } = await import(pathToFileURL(path.join(root, "scripts", "sync-site.mjs")).href);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

const site = path.join(root, "site");
const pub = path.join(root, "public");

console.log("site/ is in sync with public/");
{
  // Φτιάχνουμε ένα φρέσκο site/ σε προσωρινό φάκελο και το συγκρίνουμε με το πραγματικό.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idmon-site-"));
  fs.cpSync(pub, path.join(tmp, "public"), { recursive: true });
  syncSite(tmp);
  const expected = fs.readdirSync(path.join(tmp, "site")).sort();
  const actual = fs.existsSync(site) ? fs.readdirSync(site).sort() : [];
  check("site/ exists", fs.existsSync(site), "τρέξε: node scripts/sync-site.mjs");
  check("site/ has exactly the expected files", JSON.stringify(actual) === JSON.stringify(expected), "actual: " + actual.join(", "));
  let same = true;
  for (const f of expected) {
    if (!fs.existsSync(path.join(site, f)) || !fs.readFileSync(path.join(tmp, "site", f)).equals(fs.readFileSync(path.join(site, f)))) { same = false; console.log("       differs: " + f); }
  }
  check("every file is identical to what the sync produces (nothing edited by hand, nothing stale)", same, "τρέξε: node scripts/sync-site.mjs");
  check("the home page (/) is the pricing page", fs.existsSync(site) && fs.readFileSync(path.join(site, "index.html")).equals(fs.readFileSync(path.join(pub, SITE_INDEX_SOURCE))));
  check("security headers file is present", fs.existsSync(site) && fs.readFileSync(path.join(site, "_headers"), "utf8") === SITE_HEADERS);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("nothing from the app leaks into the public site");
{
  const files = fs.existsSync(site) ? fs.readdirSync(site) : [];
  for (const forbidden of ["editor.html", "landing.html", "index.js", "widget.js", "article.html", "wrangler.toml", ".dev.vars"]) {
    check(`site/ does not contain ${forbidden}`, !files.includes(forbidden));
  }
  const cfg = fs.readFileSync(path.join(root, "wrangler.site.toml"), "utf8");
  check("the site worker has no code, bindings, secrets or vars", !/^\s*main\s*=/m.test(cfg) && !/\[\[(kv_namespaces|d1_databases|vectorize)\]\]/.test(cfg) && !/\[vars\]/.test(cfg));
  check("the site worker is bound to the bare domain idmon.app only", /pattern\s*=\s*"idmon\.app"/.test(cfg) && !/app\.idmon\.app/.test(cfg.replace(/#.*$/gm, "")));
  check("the site worker serves the site/ folder", /directory\s*=\s*"\.\/site"/.test(cfg));
}

console.log("no broken links, and the legal pages are reachable from the navigation");
{
  const pages = ["pricing.html", "privacy.html", "terms.html", "refunds.html"];
  const available = new Set(["/", ...fs.readdirSync(site).map((f) => "/" + f)]);
  for (const page of pages) {
    const html = fs.existsSync(path.join(site, page)) ? fs.readFileSync(path.join(site, page), "utf8") : "";
    const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    const broken = [];
    const external = [];
    for (const r of refs) {
      if (r.startsWith("mailto:") || r.startsWith("#")) continue;
      if (/^https?:\/\//.test(r)) {
        if (!/^https:\/\/app\.idmon\.app(\/|$)/.test(r) && !/^https:\/\/cdn\.paddle\.com(\/|$)/.test(r)) external.push(r);
        continue;
      }
      const p = "/" + r.replace(/^\//, "").split(/[?#]/)[0];
      if (!available.has(p)) broken.push(r);
    }
    check(`${page}: every internal link and file exists on the public site`, broken.length === 0, broken.join(", "));
    check(`${page}: absolute links use approved app/CDN hosts`, external.length === 0, external.join(", "));
    check(`${page}: shows the contact email`, html.includes("info@idmon.app"));
    check(`${page}: links to Terms, Privacy and Refunds (navigation)`, page === "terms.html"
      ? html.includes("/privacy.html") && html.includes("/refunds.html")
      : ["/terms.html", "/privacy.html", "/refunds.html"].filter((l) => !(page === "privacy.html" && l === "/privacy.html") && !(page === "refunds.html" && l === "/refunds.html")).every((l) => html.includes(l)));
  }
  const pricing = fs.readFileSync(path.join(site, "pricing.html"), "utf8");
  check("pricing links to the app for sign-up", pricing.includes("https://app.idmon.app/landing"));
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
