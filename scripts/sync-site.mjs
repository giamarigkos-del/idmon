// Φτιάχνει το site/ (τη δημόσια βιτρίνα του idmon.app) από τα αρχεία του public/.
// Χρήση (PowerShell, από τον φάκελο idmon):   node scripts/sync-site.mjs
// Τρέξε το ΠΑΝΤΑ πριν από `wrangler deploy --config wrangler.site.toml`.
// Το site/ δεν επεξεργάζεται ποτέ με το χέρι: κάθε αλλαγή στα κείμενα γίνεται στο public/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Ακριβώς τα αρχεία που επιτρέπεται να βλέπει ο κόσμος στο idmon.app. Ό,τι δεν είναι εδώ
// (editor.html, landing.html, widget.js...) ΔΕΝ πηγαίνει ποτέ στο site/.
export const SITE_FILES = ["pricing.html", "privacy.html", "terms.html", "refunds.html", "shared.css", "shared.js", "favicon.svg"];

// Η αρχική σελίδα του idmon.app (/) είναι η σελίδα τιμολόγησης.
export const SITE_INDEX_SOURCE = "pricing.html";

export const SITE_HEADERS = [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  Referrer-Policy: strict-origin-when-cross-origin",
  "  X-Frame-Options: DENY",
  "",
].join("\n");

export function syncSite(root) {
  const src = path.join(root, "public");
  const dest = path.join(root, "site");
  for (const name of SITE_FILES) {
    if (!fs.existsSync(path.join(src, name))) {
      throw new Error(`Λείπει το public/${name}. Το site/ δεν φτιάχτηκε.`);
    }
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of SITE_FILES) fs.copyFileSync(path.join(src, name), path.join(dest, name));
  fs.copyFileSync(path.join(src, SITE_INDEX_SOURCE), path.join(dest, "index.html"));
  fs.writeFileSync(path.join(dest, "_headers"), SITE_HEADERS);
  return [...SITE_FILES, "index.html", "_headers"];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.env.SITE_ROOT || ".");
  const written = syncSite(root);
  console.log("site/ ενημερώθηκε με " + written.length + " αρχεία:");
  for (const w of written) console.log("  " + w);
}
