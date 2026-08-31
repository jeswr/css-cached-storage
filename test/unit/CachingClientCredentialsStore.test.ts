import type {
  ClientCredentials,
  ClientCredentialsStore,
} from "@solid/community-server";
import { CachingClientCredentialsStore } from "../../src/CachingClientCredentialsStore";

type InitializableClientCredentialsStore = ClientCredentialsStore & {
  handleSafe: () => Promise<void>;
};

const credential: ClientCredentials = {
  id: "credential-id",
  label: "build agent",
  webId: "https://example.com/profile/card#me",
  accountId: "account-id",
  secret: "secret",
};

function createSource(): jest.Mocked<InitializableClientCredentialsStore> {
  return {
    handleSafe: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(undefined),
    findByLabel: jest.fn().mockResolvedValue(undefined),
    findByAccount: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue(credential),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

describe("CachingClientCredentialsStore", (): void => {
  it("delegates initialization to the persistent store", async (): Promise<void> => {
    const source = createSource();
    const store = new CachingClientCredentialsStore(source);

    await store.handle();

    expect(source.handleSafe).toHaveBeenCalledTimes(1);
  });

  it("caches positive lookups under both ID and label", async (): Promise<void> => {
    const source = createSource();
    source.get.mockResolvedValueOnce(credential);
    const store = new CachingClientCredentialsStore(source);

    expect(await store.get(credential.id)).toBe(credential);
    expect(await store.findByLabel(credential.label)).toBe(credential);

    expect(source.get).toHaveBeenCalledTimes(1);
    expect(source.findByLabel).not.toHaveBeenCalled();
  });

  it("caches negative label lookups", async (): Promise<void> => {
    const source = createSource();
    const store = new CachingClientCredentialsStore(source);

    await expect(
      store.findByLabel("public-client-id"),
    ).resolves.toBeUndefined();
    await expect(
      store.findByLabel("public-client-id"),
    ).resolves.toBeUndefined();

    expect(source.findByLabel).toHaveBeenCalledTimes(1);
  });

  it("seeds both caches after creating credentials", async (): Promise<void> => {
    const source = createSource();
    const store = new CachingClientCredentialsStore(source);

    await expect(
      store.create(credential.label, credential.webId, credential.accountId),
    ).resolves.toBe(credential);
    await expect(store.get(credential.id)).resolves.toBe(credential);
    await expect(store.findByLabel(credential.label)).resolves.toBe(credential);

    expect(source.create).toHaveBeenCalledWith(
      credential.label,
      credential.webId,
      credential.accountId,
    );
    expect(source.get).not.toHaveBeenCalled();
    expect(source.findByLabel).not.toHaveBeenCalled();
  });

  it("evicts both cache keys after deleting credentials", async (): Promise<void> => {
    const source = createSource();
    source.findByLabel.mockResolvedValueOnce(credential);
    const store = new CachingClientCredentialsStore(source);

    await store.findByLabel(credential.label);
    await store.delete(credential.id);
    await expect(store.get(credential.id)).resolves.toBeUndefined();
    await expect(store.findByLabel(credential.label)).resolves.toBeUndefined();

    expect(source.delete).toHaveBeenCalledWith(credential.id);
    expect(source.get).toHaveBeenCalledTimes(1);
    expect(source.findByLabel).toHaveBeenCalledTimes(2);
  });

  it("always reads account listings from the persistent store", async (): Promise<void> => {
    const source = createSource();
    source.findByAccount.mockResolvedValue([credential]);
    const store = new CachingClientCredentialsStore(source);

    await expect(store.findByAccount(credential.accountId)).resolves.toEqual([
      credential,
    ]);
    await expect(store.findByAccount(credential.accountId)).resolves.toEqual([
      credential,
    ]);

    expect(source.findByAccount).toHaveBeenCalledTimes(2);
  });

  it("clears the cache after exceeding its configured entry cap", async (): Promise<void> => {
    const source = createSource();
    const store = new CachingClientCredentialsStore(source, 1);

    await store.get("first-id");
    await store.findByLabel("first-label");
    await store.get("second-id");
    await store.get("first-id");

    expect(source.get).toHaveBeenCalledTimes(3);
  });
});
