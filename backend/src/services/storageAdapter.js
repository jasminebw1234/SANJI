import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// STORAGE ADAPTER — Phase 1 implementation uses local disk.
//
// Per the architecture doc's "swappable services" design: the rest of the
// app only ever calls saveFile() / getFile() / deleteFile() from this file.
// When you're ready to move to Cloudflare R2 or Vercel Blob, you rewrite
// the three functions below to call that provider's SDK instead — nothing
// elsewhere in the app needs to change.

const STORAGE_ROOT = process.env.LOCAL_STORAGE_PATH || './storage';

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Save a file's contents to storage.
 * @param {string} key - logical path, e.g. "documents/{id}/original.pdf"
 * @param {Buffer} data
 * @returns {Promise<string>} the key, for storing as a pointer in the database
 */
export async function saveFile(key, data) {
  const fullPath = path.join(STORAGE_ROOT, key);
  await ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, data);
  return key;
}

/**
 * Retrieve a file's contents from storage.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
export async function getFile(key) {
  const fullPath = path.join(STORAGE_ROOT, key);
  return fs.readFile(fullPath);
}

/**
 * Delete a file from storage.
 * @param {string} key
 */
export async function deleteFile(key) {
  const fullPath = path.join(STORAGE_ROOT, key);
  await fs.rm(fullPath, { force: true });
}
