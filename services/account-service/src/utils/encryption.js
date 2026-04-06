// Envelope Encryption — two-key hierarchy
// Layer 1: Master Encryption Key (MEK) — from environment (HSM/KMS in prod)
// Layer 2: Data Encryption Key (DEK) — generated per record, encrypted by MEK
// Raw PII never written to DB in plaintext

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const MEK = Buffer.from(
  process.env.ENCRYPTION_KEY ||
    "a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3",
  "hex"
);

/**
 * Encrypts a plaintext string using envelope encryption.
 * Returns a JSON envelope: { encryptedDek, iv, tag, ciphertext }
 */
function encrypt(plaintext) {
  if (!plaintext) return null;

  // Generate a fresh 256-bit DEK for this record
  const dek = crypto.randomBytes(32);

  // Encrypt the DEK with the MEK (AES-256-GCM)
  const dekIv = crypto.randomBytes(12);
  const dekCipher = crypto.createCipheriv(ALGORITHM, MEK, dekIv);
  const encryptedDek = Buffer.concat([
    dekCipher.update(dek),
    dekCipher.final(),
  ]);
  const dekTag = dekCipher.getAuthTag();

  // Encrypt the plaintext with the DEK
  const dataIv = crypto.randomBytes(12);
  const dataCipher = crypto.createCipheriv(ALGORITHM, dek, dataIv);
  const ciphertext = Buffer.concat([
    dataCipher.update(plaintext, "utf8"),
    dataCipher.final(),
  ]);
  const dataTag = dataCipher.getAuthTag();

  const envelope = {
    encryptedDek: encryptedDek.toString("base64"),
    dekIv: dekIv.toString("base64"),
    dekTag: dekTag.toString("base64"),
    iv: dataIv.toString("base64"),
    tag: dataTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };

  return JSON.stringify(envelope);
}

/**
 * Decrypts an envelope string produced by encrypt().
 */
function decrypt(envelopeStr) {
  if (!envelopeStr) return null;

  const envelope = JSON.parse(envelopeStr);

  // Decrypt the DEK using MEK
  const dekDecipher = crypto.createDecipheriv(
    ALGORITHM,
    MEK,
    Buffer.from(envelope.dekIv, "base64")
  );
  dekDecipher.setAuthTag(Buffer.from(envelope.dekTag, "base64"));
  const dek = Buffer.concat([
    dekDecipher.update(Buffer.from(envelope.encryptedDek, "base64")),
    dekDecipher.final(),
  ]);

  // Decrypt the data using DEK
  const dataDecipher = crypto.createDecipheriv(
    ALGORITHM,
    dek,
    Buffer.from(envelope.iv, "base64")
  );
  dataDecipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    dataDecipher.update(Buffer.from(envelope.ciphertext, "base64")),
    dataDecipher.final(),
  ]);

  return plaintext.toString("utf8");
}

module.exports = { encrypt, decrypt };
