import {
  type ClientCredentials,
  type ClientCredentialsStore,
  Initializer,
} from "@solid/community-server";

/**
 * An in-memory caching decorator for a {@link ClientCredentialsStore}.
 *
 * WHY THIS EXISTS
 * ---------------
 * On the file backend, `ClientCredentialsStore.findByLabel`/`get` resolve through
 * `WrappedIndexedStorage`. Client-credential tokens are a NON-root type (children of
 * `account`), and for non-root types the indexed lookup still walks the on-disk
 * `clientCredentials` index directory (O(n) `getdents`). Every OIDC client lookup that
 * misses the provider's own adapter — which is *every* public Solid client and every
 * `prompt=none` silent refresh — falls through to `findByLabel`, so under normal auth
 * traffic the server does hundreds of full directory scans per second, saturating the
 * (single-worker) event loop's filesystem thread-pool.
 *
 * This decorator keeps the credentials in memory so those lookups become O(1) map reads
 * with zero disk I/O. Both positive AND negative results are cached (a `Map` entry whose
 * value is `undefined` records "this label is not a credential" — the dominant case for
 * public app client-ids — so it is never re-scanned).
 *
 * CORRECTNESS
 * -----------
 * - Single-worker only ({@link SingleThreaded} is not claimed because the cache would be
 *   incoherent across cluster workers — same constraint as the read cache in this package).
 * - All mutations go through this instance: `create` seeds the cache, `delete` evicts it,
 *   so a deleted token can never keep authenticating from a stale entry.
 * - Account deletion cascades do NOT pass through here, but `ClientCredentialsAdapter`
 *   independently re-checks `WebIdStore.isLinked` on every use and self-deletes a token
 *   whose account/WebID link is gone, which backstops that path.
 * - `findByAccount` (account-UI token listing only, not on the hot auth path) is passed
 *   straight through, so it is never stale.
 *
 * It also implements {@link Initializer}: the wrapped store defines its storage type and
 * indexes in its own initialization, so this decorator simply delegates initialization to
 * the source (it is registered in the initializer chain in place of the source).
 */
export class CachingClientCredentialsStore
  extends Initializer
  implements ClientCredentialsStore
{
  private readonly source: ClientCredentialsStore;
  private readonly byLabel = new Map<string, ClientCredentials | undefined>();
  private readonly byId = new Map<string, ClientCredentials | undefined>();
  private readonly maxEntries: number;

  /**
   * @param source - The wrapped store that owns the persistent state.
   * @param maxEntries - Soft cap on cached entries; the cache is cleared wholesale when
   *   exceeded (a cheap bound against unbounded growth from distinct public client-ids).
   */
  public constructor(source: ClientCredentialsStore, maxEntries = 100000) {
    super();
    this.source = source;
    this.maxEntries = maxEntries;
  }

  /** Delegate initialization (type + index definitions) to the wrapped store. */
  public async handle(): Promise<void> {
    await (this.source as unknown as Initializer).handleSafe();
  }

  public async get(id: string): Promise<ClientCredentials | undefined> {
    if (this.byId.has(id)) {
      return this.byId.get(id);
    }
    const result = await this.source.get(id);
    this.remember(result, id, undefined);
    return result;
  }

  public async findByLabel(
    label: string,
  ): Promise<ClientCredentials | undefined> {
    if (this.byLabel.has(label)) {
      return this.byLabel.get(label);
    }
    const result = await this.source.findByLabel(label);
    this.remember(result, undefined, label);
    return result;
  }

  public async findByAccount(accountId: string): Promise<ClientCredentials[]> {
    // Account-UI listing only; rare and not on the hot auth path. Pass through so it is
    // never stale (would otherwise need per-account list invalidation on create/delete).
    return this.source.findByAccount(accountId);
  }

  public async create(
    label: string,
    webId: string,
    accountId: string,
  ): Promise<ClientCredentials> {
    const result = await this.source.create(label, webId, accountId);
    this.remember(result, result.id, result.label);
    return result;
  }

  public async delete(id: string): Promise<void> {
    const existing = this.byId.get(id) ?? (await this.source.get(id));
    await this.source.delete(id);
    this.byId.delete(id);
    if (existing) {
      this.byLabel.delete(existing.label);
    }
  }

  /**
   * Records a lookup result (possibly `undefined` for a negative result) under the id
   * and/or label it was looked up by, plus its own id+label when present.
   */
  private remember(
    cred: ClientCredentials | undefined,
    id: string | undefined,
    label: string | undefined,
  ): void {
    if (this.byLabel.size + this.byId.size > this.maxEntries) {
      this.byLabel.clear();
      this.byId.clear();
    }
    if (id !== undefined) {
      this.byId.set(id, cred);
    }
    if (label !== undefined) {
      this.byLabel.set(label, cred);
    }
    if (cred) {
      this.byId.set(cred.id, cred);
      this.byLabel.set(cred.label, cred);
    }
  }
}
