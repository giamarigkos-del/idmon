// Κοινός τρόπος να φορτωθεί ο ΠΡΑΓΜΑΤΙΚΟΣ src/index.js μέσα στο Node, για τα tests
// που τρέχουν χωρίς wrangler dev (π.χ. upgrade-offer, billing-plan-change,
// billing-reconcile). Μία υλοποίηση εδώ, αντί για αντίγραφο σε κάθε test.
//
// Δύο εμπόδια που λύνει:
//  1. Το repo έχει package.json με "type": "commonjs", οπότε το Node αρνείται να
//     φορτώσει το src/index.js (είναι ES module). Αντιγράφουμε τα src/*.js σε
//     προσωρινό φάκελο με δικό του package.json { "type": "module" }.
//  2. Από 22 Σεπ 2026 το index.js φορτώνει το Argon2id με στατικά imports .wasm
//     (import argon2WASM from "...argon2.wasm"), που τα καταλαβαίνει μόνο ο
//     Cloudflare runtime. Στο ΠΡΟΣΩΡΙΝΟ αντίγραφο αυτά τα δύο imports γίνονται
//     "διάβασε το ίδιο .wasm από τον δίσκο" -- ΠΡΑΓΜΑΤΙΚΟ Argon2id, όχι ψεύτικο,
//     οπότε ένα test μπορεί να κάνει κανονικά signup/login αν χρειαστεί.
// Τα αρχικά αρχεία δεν αγγίζονται ποτέ.
//
// Ο προσωρινός φάκελος μπαίνει ΜΕΣΑ στο node_modules του repo (αγνοείται ήδη από
// το git), ώστε το import "argon2-wasm-edge" να βρίσκει το πακέτο χωρίς symlinks
// (τα symlinks θέλουν admin δικαιώματα στα Windows). Σβήνεται στο τέλος του test.
//
// Προαιρετικά: $env:INDEX_PATH = "C:\\...\\index.js" για άλλο αρχείο.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function loadWorker() {
  const indexPath = path.resolve(process.env.INDEX_PATH || path.join(repoRoot, "src", "index.js"));
  const srcDir = path.dirname(indexPath);

  // Πού είναι εγκατεστημένο το πακέτο (χρειάζεται npm install μία φορά).
  const require = createRequire(path.join(repoRoot, "package.json"));
  let wasmDir;
  try {
    wasmDir = path.join(path.dirname(require.resolve("argon2-wasm-edge/package.json")), "wasm");
  } catch (err) {
    throw new Error("Λείπει το πακέτο argon2-wasm-edge. Τρέξε πρώτα: npm install");
  }

  const tmpParent = path.join(repoRoot, "node_modules");
  const tmpDir = fs.mkdtempSync(path.join(tmpParent, ".idmon-test-"));
  process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));

  for (const name of fs.readdirSync(srcDir)) {
    if (name.endsWith(".js")) fs.copyFileSync(path.join(srcDir, name), path.join(tmpDir, name));
  }
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));

  const tmpIndex = path.join(tmpDir, path.basename(indexPath));
  let source = fs.readFileSync(tmpIndex, "utf8");
  let replaced = 0;
  source = source.replace(
    /^import (argon2WASM|blake2bWASM) from "argon2-wasm-edge\/wasm\/([a-z0-9]+\.wasm)";\r?$/gm,
    (_match, name, file) => {
      replaced++;
      const fileUrl = pathToFileURL(path.join(wasmDir, file)).href;
      return `const ${name} = new WebAssembly.Module(__idmonTestFs.readFileSync(new URL(${JSON.stringify(fileUrl)})));`;
    }
  );
  if (replaced !== 2) {
    // Άλλαξε ο τρόπος που το index.js φορτώνει το Argon2: καλύτερα ένα καθαρό μήνυμα
    // εδώ παρά ένα ακατανόητο σφάλμα του Node.
    throw new Error(`load-worker: περίμενα 2 imports .wasm στο index.js, βρήκα ${replaced}. Άλλαξε η φόρτωση του Argon2;`);
  }
  source = 'import __idmonTestFs from "node:fs";\n' + source;
  fs.writeFileSync(tmpIndex, source);

  return (await import(pathToFileURL(tmpIndex).href)).default;
}
