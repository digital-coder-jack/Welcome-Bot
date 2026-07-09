/**
 * database/jsonStore.js
 * ---------------------------------------------------------------------------
 * Generic, dependency-free JSON persistence factory.
 *
 * Extracted from warningStore/memberStore so every store in the bot shares
 * one battle-tested implementation:
 *   - Lazy, race-safe loading (single load promise).
 *   - In-memory cache for fast reads.
 *   - Debounced, atomic (write-then-rename) flushes so a crash mid-write can
 *     never corrupt the file.
 *
 * Usage:
 *   const store = createJsonStore('settings.json');
 *   const data = await store.read();     // whole object (mutable reference)
 *   data.foo = 'bar';
 *   store.flush();                       // schedule debounced persist
 * ---------------------------------------------------------------------------
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

/**
 * Create a JSON-file-backed store.
 * @param {string} filename  File name inside src/database/data/.
 * @returns {{ read: () => Promise<object>, flush: () => void }}
 */
export function createJsonStore(filename) {
  const file = path.join(DATA_DIR, filename);

  let cache = null;
  let loadingPromise = null;
  let writeTimer = null;

  async function read() {
    if (cache) return cache;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const raw = await fs.readFile(file, 'utf8');
        cache = JSON.parse(raw);
      } catch {
        cache = {}; // First run or corrupt file: start fresh.
      }
      return cache;
    })();

    return loadingPromise;
  }

  function flush() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
      writeTimer = null;
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
        await fs.rename(tmp, file); // atomic on POSIX filesystems.
      } catch {
        // Non-fatal: in-memory state stays valid; next flush retries.
      }
    }, 250);
  }

  return { read, flush };
}
