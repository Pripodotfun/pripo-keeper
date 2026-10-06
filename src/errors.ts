/** Only locally authored messages may be emitted; provider errors can contain RPC credentials. */
export class KeeperError extends Error {
  override name = 'KeeperError';
}
export class JournalError extends KeeperError {
  override name = 'JournalError';
}
