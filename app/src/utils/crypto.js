import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

export function generateKeypair() {
  return nacl.box.keyPair();
}

export function encryptMessage(message, recipientPublicKey, senderSecretKey) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageUint8 = encodeUTF8(message);
  const encrypted = nacl.box(messageUint8, nonce, recipientPublicKey, senderSecretKey);
  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(encrypted),
  };
}

export function decryptMessage(encryptedObj, senderPublicKey, recipientSecretKey) {
  const nonce = decodeBase64(encryptedObj.nonce);
  const ciphertext = decodeBase64(encryptedObj.ciphertext);
  const decrypted = nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey);
  if (!decrypted) return null;
  return decodeUTF8(decrypted);
}

export function encryptSymmetric(message, key) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageUint8 = encodeUTF8(message);
  const encrypted = nacl.secretbox(messageUint8, nonce, key);
  return { nonce: encodeBase64(nonce), ciphertext: encodeBase64(encrypted) };
}

export function decryptSymmetric(encryptedObj, key) {
  const nonce = decodeBase64(encryptedObj.nonce);
  const ciphertext = decodeBase64(encryptedObj.ciphertext);
  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) return null;
  return decodeUTF8(decrypted);
}
