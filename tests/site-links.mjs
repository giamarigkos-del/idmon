// Έλεγχος της δημόσιας πλευράς του idmon.app, μετά τη συγχώνευση (23 Σεπτ. 2026): ολόκληρο το
// προϊόν ζει σε ΕΝΑ Worker στο idmon.app. Ελέγχει ότι (1) η δομή είναι σωστή (marketing σελίδα
// στο /, εφαρμογή στο /home.html, κανένα υπόλοιπο από τον παλιό δεύτερο Worker), (2) το
// wrangler.toml και το _redirects είναι όπως πρέπει, (3) κανένα εσωτερικό link δεν είναι
// σπασμένο και οι νομικές σελίδες φαίνονται από την πλοήγηση, όπως ζητά το Paddle, (4) κανένα
// link ή redirect της εφαρμογής δεν στέλνει πια στο "/" (που είναι τώρα η marketing σελίδα).
// Χρήση (PowerShell, από τον φάκελο idmon):   node tests/site-links.mjs
// Προαιρετικά: $env:SITE_ROOT = "C:\\...\\idmon"
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.SITE_ROOT || ".");
const pub = path.join(root, "public");
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

console.log("structure: one Worker, marketing page at /");
{
  const index = read(path.join(pub, "index.html"));
  const home = read(path.join(pub, "home.html"));
  check("public/index.html is the marketing/pricing page", index.includes('id="content-el"') && index.includes(".plans"));
  check("public/index.html never needs a workspace", index.includes("window.__SKIP_WORKSPACE_REDIRECT__ = true"));
  check("public/home.html is the app home (chat)", home.includes('id="questionInput"') || home.includes("launcher"));
  check("public/pricing.html is gone (served by _redirects)", !fs.existsSync(path.join(pub, "pricing.html")));
  for (const leftover of ["site", "wrangler.site.toml", path.join("scripts", "sync-site.mjs")]) {
    check(`old site Worker leftover removed: ${leftover}`, !fs.existsSync(path.join(root, leftover)));
  }
}

console.log("marketing page early redirect");
{
  const index = read(path.join(pub, "index.html"));
  const early = (index.match(/<head>\r?\n<script>([\s\S]*?)<\/script>/) || [])[1] || "";
  check("the early script is the first thing in <head>", early.length > 0);
  check("logged-in visitors go to /home.html", early.includes('location.replace("/home.html")'));
  check("returning, logged-out visitors go to /landing.html", early.includes('location.replace("/landing.html")'));
  check("internal navigation (same-origin referrer) is never redirected", /new URL\(ref\)\.origin === location\.origin\) return/.test(early));
  const home = read(path.join(pub, "home.html"));
  check("home.html marks the browser as returning", home.includes('localStorage.setItem("idmonReturning", "1")'));
}

console.log("wrangler.toml and _redirects");
{
  const cfg = read(path.join(root, "wrangler.toml"));
  const active = cfg.replace(/#.*$/gm, "");
  check("the app Worker is bound to idmon.app", /pattern\s*=\s*"idmon\.app"/.test(active));
  check("app.idmon.app stays bound (for the 308 redirect rule)", /pattern\s*=\s*"app\.idmon\.app"/.test(active));
  check("assets come from ./public", /directory\s*=\s*"\.\/public"/.test(active));
  check("Google redirect URI is on idmon.app", active.includes('GOOGLE_REDIRECT_URI = "https://idmon.app/oauth/google/callback"'));
  const redirects = read(path.join(pub, "_redirects")).replace(/\r/g, "").trim().split("\n").map((l) => l.trim().split(/\s+/).join(" "));
  check("_redirects sends /pricing.html to / (301)", redirects.includes("/pricing.html / 301"));
  check("_redirects sends /pricing to / (301)", redirects.includes("/pricing / 301"));
}

console.log("no broken links, and the legal pages are reachable from the navigation");
{
  const redirectSources = read(path.join(pub, "_redirects")).replace(/\r/g, "").split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  const files = fs.readdirSync(pub);
  // Workers static assets σερβίρουν και "όμορφα" URLs χωρίς .html (π.χ. /landing -> landing.html).
  const available = new Set(["/", ...files.map((f) => "/" + f), ...files.filter((f) => f.endsWith(".html")).map((f) => "/" + f.slice(0, -5)), ...redirectSources]);
  for (const page of ["index.html", "privacy.html", "terms.html", "refunds.html"]) {
    const html = read(path.join(pub, page));
    check(`${page}: exists`, html.length > 0);
    const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    const broken = [];
    const external = [];
    for (const r of refs) {
      if (r.startsWith("mailto:") || r.startsWith("#")) continue;
      if (/^https?:\/\//.test(r)) {
        if (
        !/^https:\/\/cdn\.paddle\.com(\/|$)/.test(r) &&
        // Developer credit in the footer (Sep 24 2026): a known, deliberate external link, not a broken/stray one.
        r !== "https://giamarigkos-del.github.io/portfolio/" &&
        // Self-referencing absolute links (Sep 24 2026 SEO pass): canonical tags, the widget embed
        // example. Not "external" -- they point back at idmon.app itself; checked properly above.
        !/^https:\/\/idmon\.app\//.test(r)
      ) external.push(r);
        continue;
      }
      const p = "/" + r.replace(/^\//, "").split(/[?#]/)[0];
      if (!available.has(p)) broken.push(r);
    }
    check(`${page}: every internal link and file exists`, broken.length === 0, broken.join(", "));
    check(`${page}: absolute links only to the Paddle CDN (no app.idmon.app)`, external.length === 0, external.join(", "));
    check(`${page}: shows the contact email`, html.includes("info@idmon.app"));
    const legal = ["/terms.html", "/privacy.html", "/refunds.html"].filter((l) => l !== "/" + page);
    check(`${page}: links to the other legal pages (navigation)`, legal.every((l) => html.includes(l)), legal.filter((l) => !html.includes(l)).join(", "));
  }
  const index = read(path.join(pub, "index.html"));
  const signups = [...index.matchAll(/<a class="cta[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
  check("every sign-up button on the marketing page goes to /landing", signups.length === 4 && signups.every((h) => h === "/landing"), signups.join(", "));
}

console.log("the app never sends people back to / (now the marketing page)");
{
  for (const page of ["home.html", "landing.html", "editor.html", "article.html"]) {
    const html = read(path.join(pub, page));
    const bad = (html.match(/href="\/"|location\.href\s*=\s*"\/"|location\.replace\("\/"\)/g) || []).length;
    check(`${page}: no link or redirect to "/"`, bad === 0, bad + " found");
  }
}

console.log("robots.txt and sitemap.xml (Sep 24 2026 SEO pass)");
{
  const robots = read(path.join(pub, "robots.txt"));
  check("robots.txt exists", robots.length > 0);
  check("robots.txt allows crawling by default", /^Allow:\s*\/\s*$/m.test(robots), robots);
  check("robots.txt keeps the app-only pages out (editor/home/article)", ["editor.html", "home.html", "article.html"].every((p) => new RegExp("Disallow:\\s*/" + p + "\\s*$", "m").test(robots)), robots);
  check("robots.txt points to the sitemap", robots.includes("Sitemap: https://idmon.app/sitemap.xml"));

  const sitemapPath = path.join(pub, "sitemap.xml");
  check("sitemap.xml exists", fs.existsSync(sitemapPath));
  const sitemap = read(sitemapPath);
  let locs = [];
  try {
    locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    check("sitemap.xml is well-formed XML", true);
  } catch (err) {
    check("sitemap.xml is well-formed XML", false, String(err));
  }
  const expected = ["https://idmon.app/", "https://idmon.app/terms.html", "https://idmon.app/privacy.html", "https://idmon.app/refunds.html"];
  check("sitemap.xml lists exactly the public marketing/legal pages", locs.length === expected.length && expected.every((u) => locs.includes(u)), locs.join(", "));
  check("sitemap.xml does NOT list /landing or any app page (thin/private content)", !locs.some((u) => /landing|editor|home\.html|article\.html/.test(u)), locs.join(", "));
}

console.log("canonical tags on every public page");
{
  const expectedCanonical = {
    "index.html": "https://idmon.app/",
    "landing.html": "https://idmon.app/landing",
    "terms.html": "https://idmon.app/terms.html",
    "privacy.html": "https://idmon.app/privacy.html",
    "refunds.html": "https://idmon.app/refunds.html",
  };
  for (const [page, url] of Object.entries(expectedCanonical)) {
    const html = read(path.join(pub, page));
    const m = html.match(/<link rel="canonical" href="([^"]+)">/);
    check(`${page}: has a canonical tag pointing to itself`, m && m[1] === url, m ? m[1] : "missing");
  }
}

console.log("the Greek content is visible without running JavaScript (AI/read-mode crawlers)");
{
  for (const page of ["index.html", "privacy.html", "refunds.html", "terms.html"]) {
    const html = read(path.join(pub, page));
    check(`${page}: .lang-block still defaults to hidden (English)`, /\.lang-block\{display:none;\}/.test(html));
    check(`${page}: #content-el (Greek) is shown by default, without needing JS`, /#content-el\{display:block;\}/.test(html));
  }
}

console.log("favicon: visible background (Sep 24 2026 fix), PNG + SVG on every page");
{
  for (const png of ["favicon-48.png", "favicon-192.png"]) {
    const p = path.join(pub, png);
    check(`${png}: exists`, fs.existsSync(p));
    const buf = fs.readFileSync(p);
    check(`${png}: is a real PNG file`, buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a", "bad header");
    const size = buf.length;
    check(`${png}: not a tiny/broken placeholder`, size > 300, size + " bytes");
  }
  const svg = read(path.join(pub, "favicon.svg"));
  check("favicon.svg: has an opaque background fill (not just white-on-nothing)", /<rect[^>]*fill="#D97757"/.test(svg), svg);
  for (const page of ["index.html", "landing.html", "privacy.html", "refunds.html", "terms.html"]) {
    const html = read(path.join(pub, page));
    check(`${page}: PNG favicon linked before the SVG one`, html.indexOf('href="/favicon-48.png"') !== -1 && html.indexOf('href="/favicon-48.png"') < html.indexOf('href="/favicon.svg"'), page);
    check(`${page}: 192x192 PNG also linked (crisp on high-DPI, Google recommends >48x48)`, html.includes('sizes="192x192" href="/favicon-192.png"'));
  }
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
