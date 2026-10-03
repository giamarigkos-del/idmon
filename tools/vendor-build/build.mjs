// tools\vendor-build\build.mjs
// Φτιάχνει τα public\vendor\editor.js, reader.js και MANIFEST.json (εκδόσεις, μέγεθος, SHA-256).
// Χρήση (ΜΟΝΟ όταν αλλάζουν βιβλιοθήκες ή κανόνες, από τον φάκελο tools\vendor-build):  npm install   και μετά   npm run build
// Το deploy και ο πελάτης ΔΕΝ το χρειάζονται: το public\vendor\*.js είναι ήδη φτιαγμένο και μπαίνει στο repo.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.VENDOR_OUT ? resolve(process.env.VENDOR_OUT) : resolve(HERE, "..", "..", "public", "vendor");
const SRC = process.env.VENDOR_SRC ? resolve(process.env.VENDOR_SRC) : join(HERE, "src");
mkdirSync(OUT, { recursive: true });

const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const installed = (name) => { try { return JSON.parse(readFileSync(join(HERE, "node_modules", name, "package.json"), "utf8")); } catch { return null; } };

for (const [entry, out] of [["editor-entry.js", "editor.js"], ["reader-entry.js", "reader.js"]]) {
  await build({
    entryPoints: [join(SRC, entry)], bundle: true, minify: true, format: "iife", target: ["es2020"], legalComments: "none", logLevel: "error",
    outfile: join(OUT, out), absWorkingDir: HERE, banner: { js: "/* Idmon vendor bundle: " + out + ". ΜΗΝ το επεξεργάζεσαι: φτιάχνεται από tools/vendor-build. Δες MANIFEST.json */" },
  });
}

const files = {};
for (const name of ["editor.js", "reader.js"]) {
  const buf = readFileSync(join(OUT, name));
  files[name] = { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}
const deps = {};
for (const name of Object.keys(pkg.dependencies).concat(Object.keys(pkg.devDependencies))) {
  const p = installed(name);
  deps[name] = { requested: (pkg.dependencies[name] || pkg.devDependencies[name]), installed: p ? p.version : null, license: p ? (typeof p.license === "string" ? p.license : JSON.stringify(p.license || null)) : null };
}
writeFileSync(join(OUT, "MANIFEST.json"), JSON.stringify({ note: "Παράγεται από tools/vendor-build/build.mjs. Το τεστ της σουίτας ελέγχει ότι τα αρχεία δεν άλλαξαν με το χέρι.", files, dependencies: deps }, null, 2) + "\n");
console.log(JSON.stringify(files, null, 1));
