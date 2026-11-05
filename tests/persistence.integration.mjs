/** Optional browser-storage integration checks: node --test tests/persistence.integration.mjs */
import assert from 'node:assert/strict';
import test from 'node:test';
import { File } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { WorkspaceStore, normaliseWorkspacePath } from '../js/persistence.js';

class MemoryStorage {
  values = new Map();
  failWrites = false;
  failReads = false;
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) {
    if (this.failReads) throw new DOMException('Storage is disabled', 'SecurityError');
    return this.values.get(String(key)) ?? null;
  }
  setItem(key, value) {
    if (this.failWrites) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    this.values.set(String(key), String(value));
  }
  removeItem(key) { this.values.delete(String(key)); }
}

function fixture(t, options = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const indexedDB = options.indexedDB ?? new IDBFactory();
  const stores = [];
  const make = (extra = {}) => {
    const store = new WorkspaceStore({ storage, indexedDB, pathname: '/tablecraft/', ...extra });
    stores.push(store);
    return store;
  };
  t.after(async () => { await Promise.all(stores.map(store => store.close())); });
  return { storage, indexedDB, make };
}

function transaction(database, storeName, operation) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction([storeName], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    operation(tx.objectStore(storeName));
  });
}

test('path scopes unify directory and index.html URLs while isolating other workspaces', async t => {
  assert.equal(normaliseWorkspacePath('/demo/index.html'), '/demo');
  assert.equal(normaliseWorkspacePath('/demo/'), '/demo');
  assert.equal(normaliseWorkspacePath('/index.html'), '/');
  const { make, storage } = fixture(t);
  const first = make({ pathname: '/demo/index.html' });
  assert.equal(first.save({ code: 'first' }), true);
  await first.flush();
  assert.deepEqual(await make({ pathname: '/demo/' }).load(), { code: 'first' });
  assert.equal(await make({ pathname: '/another/' }).load(), null);
  assert.equal(storage.length, 1);
});

test('save journals the latest edit synchronously and snapshots are independent copies', async t => {
  const { make, storage } = fixture(t);
  const store = make();
  const snapshot = { code: '# comment\n`my table`[, value := 2]', undo: ['old code'], uploads: [{ storageKey: 'one', options: { decimal: ',' } }] };
  assert.equal(store.save(snapshot), true);
  assert.deepEqual(JSON.parse(storage.getItem(store.keys.snapshot)).snapshot, snapshot);
  snapshot.code = 'mutated after save';
  snapshot.uploads[0].options.decimal = '.';
  const refreshed = make({ indexedDB: null });
  const restored = await refreshed.load();
  assert.equal(restored.code, '# comment\n`my table`[, value := 2]');
  assert.equal(restored.uploads[0].options.decimal, ',');
  assert.equal(store.save({ code: 'latest keystroke' }), true);
  assert.equal(JSON.parse(storage.getItem(store.keys.snapshot)).snapshot.code, 'latest keystroke');
  await store.flush();
  assert.deepEqual(await make().load(), { code: 'latest keystroke' });
});

test('uploaded binary bytes, Unicode filename, MIME type and timestamp survive close and reopen', async t => {
  const { make } = fixture(t);
  const store = make();
  const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);
  const file = new File([bytes], '2026 café `results`.xlsx', { type: 'application/octet-stream', lastModified: 1740000000123 });
  const putting = store.putFile('binary-file', file);
  store.save({ uploads: [{ storageKey: 'binary-file', options: { sheet: 'Sheet 2', skip: 3 } }] });
  await store.close();
  assert.equal(await putting, true);
  const reopened = make();
  assert.equal((await reopened.load()).uploads[0].options.sheet, 'Sheet 2');
  const restored = await reopened.getFile('binary-file');
  assert.equal(restored.name, file.name);
  assert.equal(restored.type, file.type);
  assert.equal(restored.lastModified, file.lastModified);
  assert.deepEqual(new Uint8Array(await restored.blob.arrayBuffer()), bytes);
  assert.equal(store.save({ code: 'after close' }), false);
});

test('a corrupt local journal recovers from the valid IndexedDB backup', async t => {
  const { make, storage } = fixture(t);
  const first = make();
  first.save({ code: 'recover me', steps: [{ operation: 'subset' }] });
  await first.flush();
  storage.setItem(first.keys.snapshot, '{broken json');
  const next = make();
  assert.deepEqual(await next.load(), { code: 'recover me', steps: [{ operation: 'subset' }] });
  assert.equal(JSON.parse(storage.getItem(next.keys.snapshot)).snapshot.code, 'recover me');
});

test('newest valid envelope wins and corrupt database snapshots do not displace the journal', async t => {
  const { make, storage } = fixture(t);
  const first = make();
  first.save({ code: 'older' });
  await first.flush();
  const older = storage.getItem(first.keys.snapshot);
  first.save({ code: 'newer' });
  await first.flush();
  storage.setItem(first.keys.snapshot, older);
  assert.deepEqual(await make().load(), { code: 'newer' });
  await transaction(first._db, 'meta', meta => meta.put({ schema: 999, snapshot: { code: 'corrupt' } }, 'snapshot'));
  assert.deepEqual(await make().load(), { code: 'newer' });
  storage.setItem(first.keys.snapshot, 'null');
  assert.equal(await make().load(), null);
});

test('journal quota failure returns false but the completed backup still recovers the newest edit', async t => {
  const { make, storage } = fixture(t);
  const statuses = [];
  const first = make({ onStatus: status => statuses.push(status) });
  first.save({ code: 'old journal' });
  await first.flush();
  storage.failWrites = true;
  assert.equal(first.save({ code: 'new backup' }), false);
  await first.flush();
  assert.equal(first.status.state, 'partial');
  assert.equal(first.status.quotaExceeded, true);
  assert.ok(statuses.some(status => status.quotaExceeded));
  const next = make();
  assert.deepEqual(await next.load(), { code: 'new backup' });
  assert.equal(next.status.state, 'partial');
  assert.equal(next.status.quotaExceeded, true);
});

test('successful requests are not treated as saved when their transaction later aborts', async t => {
  const { make } = fixture(t);
  const store = make();
  await store.load();
  const database = store._db;
  const original = database.transaction.bind(database);
  database.transaction = (...args) => {
    const tx = original(...args);
    if (args[1] === 'readwrite' && args[0].includes('files')) {
      const files = tx.objectStore('files');
      const put = files.put.bind(files);
      files.put = (...values) => {
        const request = put(...values);
        request.addEventListener('success', () => tx.abort());
        return request;
      };
    }
    return tx;
  };
  assert.equal(await store.putFile('aborted', new File(['must roll back'], 'data.csv')), false);
  database.transaction = original;
  assert.equal(await store.getFile('aborted'), null);
  assert.equal(await make().getFile('aborted'), null);
});

test('removing one file is durable and leaves other saved files intact', async t => {
  const { make } = fixture(t);
  const store = make();
  await store.putFile('first', new File(['first'], 'first.csv'));
  await store.putFile('second', new File(['second'], 'second.csv'));
  assert.equal(await store.removeFile('first'), true);
  const next = make();
  assert.equal(await next.getFile('first'), null);
  assert.equal(await (await next.getFile('second')).blob.text(), 'second');
});

test('clear orders pending saves and file writes, keeps unrelated keys, and stays clear on reopen', async t => {
  const { make, storage } = fixture(t);
  const store = make();
  storage.setItem('another-app', 'keep me');
  storage.setItem('tablecraft.theme', 'dark');
  const otherWorkspace = make({ pathname: '/other/' });
  otherWorkspace.save({ code: 'other workspace' });
  await otherWorkspace.flush();
  await store.putFile('existing', new File(['old bytes'], 'old.csv'));
  store.save({ code: 'before reset' });
  const pending = store.putFile('pending', new File(['new bytes'], 'new.csv'));
  const cleared = store.clear();
  assert.equal(store.save({ code: 'during reset' }), false);
  assert.equal(await store.putFile('during', new File(['during'], 'during.csv')), false);
  assert.equal(await cleared, true);
  assert.equal(await pending, false);
  await store.flush();
  assert.equal(storage.getItem(store.keys.snapshot), null);
  assert.equal(storage.getItem('another-app'), 'keep me');
  assert.equal(storage.getItem('tablecraft.theme'), 'dark');
  assert.deepEqual(await otherWorkspace.load(), { code: 'other workspace' });
  const next = make();
  assert.equal(await next.load(), null);
  for (const key of ['existing', 'pending', 'during']) assert.equal(await next.getFile(key), null);
  assert.equal(next.save({ code: 'new after reset' }), true);
  await next.flush();
  assert.deepEqual(await make().load(), { code: 'new after reset' });
});

test('an older tab cannot autosave its workspace or files after another tab resets', async t => {
  const { make } = fixture(t);
  const oldTab = make();
  oldTab.save({ code: 'old tab' });
  await oldTab.flush();
  const resettingTab = make();
  await resettingTab.load();
  assert.equal(await resettingTab.clear(), true);
  assert.equal(oldTab.save({ code: 'stale edit' }), false);
  assert.equal(await oldTab.putFile('stale-file', new File(['stale'], 'stale.csv')), false);
  assert.match(oldTab.status.message, /reset in another tab/);
  const next = make();
  assert.equal(await next.load(), null);
  assert.equal(await next.getFile('stale-file'), null);
});

test('storage denial and unavailable IndexedDB degrade without throwing or losing a usable journal', async t => {
  const { make, storage } = fixture(t);
  const localOnly = make({ indexedDB: null });
  assert.equal(localOnly.save({ code: 'local only' }), true);
  await localOnly.flush();
  assert.equal(localOnly.status.state, 'partial');
  assert.deepEqual(await make({ indexedDB: null }).load(), { code: 'local only' });
  const denied = make({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }, indexedDB: null });
  assert.equal(await denied.load(), null);
  assert.equal(denied.save({ code: 'not saved' }), false);
  await denied.flush();
  assert.equal(denied.status.state, 'unavailable');
  assert.equal(storage.getItem('unrelated'), null);
});

test('blocked, failed and silent IndexedDB opens settle within 2.5 seconds', async t => {
  const { make } = fixture(t);
  for (const mode of ['blocked', 'error', 'silent']) {
    const factory = { open() {
      const request = { error: new DOMException('Database unavailable', 'UnknownError') };
      if (mode !== 'silent') queueMicrotask(() => request[mode === 'blocked' ? 'onblocked' : 'onerror']?.());
      return request;
    } };
    const store = make({ indexedDB: factory, pathname: `/${mode}/` });
    assert.equal(store.save({ code: mode }), true);
    const started = performance.now();
    await store.flush();
    assert.ok(performance.now() - started < 2500, `${mode} open should not block startup`);
    assert.equal(store.status.state, 'partial');
    assert.deepEqual(await store.load(), { code: mode });
  }
});

test('snapshot encoding errors and callback errors never produce unhandled rejections', async t => {
  const { make } = fixture(t);
  const store = make({ onStatus() { throw new Error('UI callback failed'); } });
  const cycle = {}; cycle.self = cycle;
  assert.equal(store.save(cycle), false);
  assert.equal(store.save({ code: 'recovered' }), true);
  await store.flush();
  assert.deepEqual(await make().load(), { code: 'recovered' });
});
