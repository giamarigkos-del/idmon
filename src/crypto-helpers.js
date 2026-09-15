// src/crypto-helpers.js
//
// Κρυπτογράφηση/αποκρυπτογράφηση ευαίσθητων strings (OAuth tokens) πριν
// αποθηκευτούν στη D1. Χρησιμοποιεί AES-GCM μέσω του ενσωματωμένου Web
// Crypto API του Cloudflare Workers runtime (δεν χρειάζεται εξωτερική
// βιβλιοθήκη).
//
// Το κλειδί έρχεται από το secret TOKEN_ENCRYPTION_KEY (64 hex χαρακτήρες
// = 32 bytes = AES-256). Το ίδιο κλειδί χρησιμοποιείται και για encrypt
// και για decrypt (symmetric).

/**
 * Μετατρέπει το hex string του secret σε πραγματικό CryptoKey object.
 * @param {string} hexKey - 64 hex χαρακτήρες (32 bytes)
 * @returns {Promise<CryptoKey>}
 */
async function importEncryptionKey(hexKey) {
  if (!hexKey || hexKey.length !== 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY πρέπει να είναι ακριβώς 64 hex χαρακτήρες (32 bytes)"
    );
  }

  const rawBytes = new Uint8Array(
    hexKey.match(/.{2}/g).map((byte) => parseInt(byte, 16))
  );

  return crypto.subtle.importKey(
    "raw",
    rawBytes,
    { name: "AES-GCM" },
    false, // δεν χρειάζεται να είναι εξαγώγιμο
    ["encrypt", "decrypt"]
  );
}

/**
 * Κρυπτογραφεί ένα plaintext string (π.χ. ένα OAuth access/refresh token).
 * Επιστρέφει ένα string ασφαλές για αποθήκευση σε στήλη TEXT της D1:
 * μορφή "<iv_hex>:<ciphertext_hex>".
 *
 * @param {string} plaintext
 * @param {string} hexKey - το TOKEN_ENCRYPTION_KEY secret
 * @returns {Promise<string>}
 */
export async function encryptToken(plaintext, hexKey) {
  const key = await importEncryptionKey(hexKey);

  // Το IV (initialization vector) πρέπει να είναι διαφορετικό σε κάθε
  // encryption call, γι' αυτό παράγεται τυχαία κάθε φορά. Το αποθηκεύουμε
  // μαζί με το ciphertext (δεν είναι μυστικό, απλά πρέπει να είναι μοναδικό).
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encodedPlaintext = new TextEncoder().encode(plaintext);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encodedPlaintext
  );

  const ivHex = bufferToHex(iv);
  const ciphertextHex = bufferToHex(new Uint8Array(ciphertextBuffer));

  return `${ivHex}:${ciphertextHex}`;
}

/**
 * Αποκρυπτογραφεί ένα string που φτιάχτηκε με encryptToken().
 *
 * @param {string} encryptedValue - μορφή "<iv_hex>:<ciphertext_hex>"
 * @param {string} hexKey - το TOKEN_ENCRYPTION_KEY secret
 * @returns {Promise<string>} το αρχικό plaintext
 */
export async function decryptToken(encryptedValue, hexKey) {
  const key = await importEncryptionKey(hexKey);

  const [ivHex, ciphertextHex] = encryptedValue.split(":");
  if (!ivHex || !ciphertextHex) {
    throw new Error("Μη έγκυρη μορφή κρυπτογραφημένου token");
  }

  const iv = hexToBuffer(ivHex);
  const ciphertext = hexToBuffer(ciphertextHex);

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintextBuffer);
}

function bufferToHex(buffer) {
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBuffer(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
}