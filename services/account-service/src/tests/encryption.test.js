const { encrypt, decrypt } = require("../utils/encryption");

describe("Envelope Encryption", () => {
  test("encrypts and decrypts a string correctly", () => {
    const plaintext = "John Doe";
    const envelope = encrypt(plaintext);
    expect(envelope).not.toBe(plaintext);
    expect(typeof envelope).toBe("string");
    const decrypted = decrypt(envelope);
    expect(decrypted).toBe(plaintext);
  });

  test("each encryption produces a unique ciphertext (non-deterministic)", () => {
    const plaintext = "Same input";
    const enc1 = encrypt(plaintext);
    const enc2 = encrypt(plaintext);
    expect(enc1).not.toBe(enc2); // different IVs / DEKs
    expect(decrypt(enc1)).toBe(plaintext);
    expect(decrypt(enc2)).toBe(plaintext);
  });

  test("returns null for null input", () => {
    expect(encrypt(null)).toBeNull();
    expect(decrypt(null)).toBeNull();
  });

  test("tampered ciphertext throws on decryption (auth tag check)", () => {
    const envelope = JSON.parse(encrypt("sensitive data"));
    envelope.ciphertext = Buffer.from("tampered").toString("base64");
    expect(() => decrypt(JSON.stringify(envelope))).toThrow();
  });
});
