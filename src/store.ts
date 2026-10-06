import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { isAddress } from 'viem';
import { JournalError } from './errors.js';
import type { Journal, Store } from './types.js';

/** A dedicated process owns this journal. Signed bytes are durable before any RPC submission. */
export class FileStore implements Store {
  private constructor(readonly file: string, readonly state: Journal, private readonly release: () => Promise<void>) {}

  static async open(file: string, identity: string): Promise<FileStore> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Heartbeat lock expires after a killed process. A compromised lock terminates the process.
    const release = await lockfile.lock(file, { realpath: false, stale: 30_000, update: 10_000, retries: 0 });
    try {
      let state: Journal;
      try { state = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = { version: 1, identity, pending: [], completedAt: {} };
      }
      validateJournal(state, identity);
      return new FileStore(file, state, release);
    } catch (error) { await release(); throw error; }
  }

  async save(): Promise<void> {
    try {
      const temporary = `${this.file}.${process.pid}.tmp`;
      const handle = await open(temporary, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(this.state, null, 2) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
      const directory = await open(dirname(this.file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw new JournalError('Journal persistence failed; restart after checking storage'); }
  }
  async close(): Promise<void> { await this.release(); }
}

function validateJournal(state: Journal, identity: string): void {
  const invalid = () => { throw new JournalError('Journal identity or schema mismatch'); };
  const decimal = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
  if (!state || state.version !== 1 || state.identity !== identity || !Array.isArray(state.pending)
    || state.pending.length > 8 || !state.completedAt || typeof state.completedAt !== 'object'
    || Array.isArray(state.completedAt) || !Object.values(state.completedAt).every(decimal)) invalid();
  const nonces = new Set<number>();
  for (const p of state.pending) {
    if (!p || !Number.isSafeInteger(p.nonce) || p.nonce < 0 || nonces.has(p.nonce)
      || typeof p.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(p.hash)
      || typeof p.raw !== 'string' || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(p.raw)
      || !decimal(p.cost) || !decimal(p.createdBlock) || !decimal(p.lastBroadcastBlock)) invalid();
    nonces.add(p.nonce);
    const j = p.job;
    if (!j || !['liquidate', 'completeAdl', 'poke', 'sweep', 'topUp'].includes(j.kind)) invalid();
    if (j.kind === 'sweep') {
      if (!Array.isArray(j.markets) || j.markets.length < 1 || j.markets.length > 32
        || !j.markets.every((a) => typeof a === 'string' && isAddress(a))) invalid();
    } else if (typeof j.market !== 'string' || !isAddress(j.market)) invalid();
    if ((j.kind === 'liquidate' || j.kind === 'completeAdl') && (typeof j.user !== 'string' || !isAddress(j.user))) invalid();
    if (j.kind === 'completeAdl' && (!Number.isInteger(j.iterations) || j.iterations < 1 || j.iterations > 64)) invalid();
  }
}
