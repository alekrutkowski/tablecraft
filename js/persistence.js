/** Browser-only workspace journal, snapshot backup, and exact uploaded file bytes. */
const SCHEMA = 1;
const OPEN_TIMEOUT_MS = 2000;
const EMPTY_EPOCH = Object.freeze({ token: "", updatedAt: 0 });
const globalValue = (name) => { try { return globalThis[name] ?? null; } catch { return null; } };
const errorWith = (name, message) => Object.assign(new Error(message), { name });
const quotaError = (error) => error?.name === "QuotaExceededError" || error?.code === 22 || error?.code === 1014;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validEpoch = (value) => value && typeof value.token === "string" && validTime(value.updatedAt);
const compareEpochs = (left, right) => left.updatedAt - right.updatedAt || left.token.localeCompare(right.token);
const newestEpoch = (...values) => values.filter(validEpoch).sort(compareEpochs).at(-1) || EMPTY_EPOCH;
const compareEnvelopes = (left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id);

export function normaliseWorkspacePath(pathname = "/") {
  const path = ("/" + String(pathname || "/").split(/[?#]/, 1)[0])
    .replace(/\/{2,}/g, "/").replace(/\/index\.html?$/i, "/").replace(/\/+$/, "");
  return path || "/";
}

export class WorkspaceStore {
  constructor(options = {}) {
    this.storage = Object.hasOwn(options, "storage") ? options.storage : globalValue("localStorage");
    this.indexedDB = Object.hasOwn(options, "indexedDB") ? options.indexedDB : globalValue("indexedDB");
    this.scope = normaliseWorkspacePath(options.pathname ?? globalValue("location")?.pathname ?? "/");
    const prefix = `tablecraft.workspace:${encodeURIComponent(this.scope)}`;
    this.keys = { snapshot: `${prefix}:snapshot`, reset: `${prefix}:reset` };
    this.databaseName = prefix;
    this.onStatus = options.onStatus;
    this._queue = Promise.resolve();
    this._db = null;
    this._opening = null;
    this._closed = false;
    this._closing = false;
    this._clearing = false;
    this._stale = false;
    this._generation = 0;
    this._writer = globalValue("crypto")?.randomUUID?.() || Math.random().toString(36).slice(2);
    this._sequence = 0;
    this._epoch = this._readEpoch() || EMPTY_EPOCH;
    this._lastTime = this._epoch.updatedAt;
    this._latest = null;
  }

  _status(state, message, error) {
    this.status = { state, message, quotaExceeded: quotaError(error) };
    try { this.onStatus?.(this.status); } catch { /* UI callbacks cannot interrupt storage. */ }
  }

  _read(key) {
    try {
      if (!this.storage) throw errorWith("StorageUnavailableError", "Browser storage is unavailable.");
      return { text: this.storage.getItem(key), error: null };
    } catch (error) { return { text: null, error }; }
  }

  _readEpoch() {
    try {
      const epoch = JSON.parse(this._read(this.keys.reset).text);
      return validEpoch(epoch) ? epoch : null;
    } catch { return null; }
  }

  _envelope(value) {
    return value && value.schema === SCHEMA && value.scope === this.scope
      && validTime(value.updatedAt) && typeof value.id === "string" && typeof value.epoch === "string"
      && value.snapshot && typeof value.snapshot === "object" && !Array.isArray(value.snapshot) ? value : null;
  }

  _decode(text) {
    try { return this._envelope(JSON.parse(text)); } catch { return null; }
  }

  _time() {
    this._lastTime = Math.max(Date.now(), this._lastTime + 1, (this._readEpoch()?.updatedAt || 0) + 1);
    return this._lastTime;
  }

  _current(epoch, generation) {
    if (this._closed || generation !== this._generation || this._epoch.token !== epoch.token) return false;
    if (compareEpochs(this._readEpoch() || EMPTY_EPOCH, epoch) > 0) {
      this._stale = true;
      this._status("partial", "This workspace was reset in another tab. Reload before saving changes.");
      return false;
    }
    return !this._stale;
  }

  _enqueue(operation, fallback = false) {
    const promise = this._queue.then(operation).catch((error) => {
      this._status("partial", "Browser storage could not complete this operation.", error);
      return fallback;
    });
    this._queue = promise.then(() => undefined);
    return promise;
  }

  async _open() {
    if (this._db) return this._db;
    if (this._opening) return this._opening;
    if (!this.indexedDB?.open || this._closed) {
      this._dbError = errorWith("StorageUnavailableError", "Uploaded-file storage is unavailable.");
      return null;
    }
    this._opening = new Promise((resolve) => {
      let settled = false;
      const finish = (database, error) => {
        if (settled) { database?.close(); return; }
        settled = true;
        clearTimeout(timer);
        this._db = database;
        this._dbError = error || null;
        resolve(database);
      };
      const timer = setTimeout(() => finish(null, errorWith("TimeoutError", "Browser storage did not open in time.")), OPEN_TIMEOUT_MS);
      try {
        const request = this.indexedDB.open(this.databaseName, SCHEMA);
        request.onupgradeneeded = () => {
          if (settled) { try { request.transaction.abort(); } catch {} return; }
          const database = request.result;
          if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta");
          if (!database.objectStoreNames.contains("files")) database.createObjectStore("files");
        };
        request.onblocked = () => finish(null, errorWith("StorageBlockedError", "Another tab is blocking browser storage."));
        request.onerror = () => finish(null, request.error || errorWith("StorageUnavailableError", "Browser storage could not open."));
        request.onsuccess = () => {
          const database = request.result;
          if (settled || this._closed) { database.close(); return; }
          database.onversionchange = () => {
            database.close();
            if (this._db === database) { this._db = null; this._opening = null; }
          };
          finish(database);
        };
      } catch (error) { finish(null, error); }
    });
    return this._opening;
  }

  async _transaction(stores, mode, operation) {
    const database = await this._open();
    if (!database) throw this._dbError;
    return new Promise((resolve, reject) => {
      let transaction, result, failure;
      const fail = (error) => {
        failure = error;
        try { transaction.abort(); } catch { reject(error); }
      };
      try {
        transaction = database.transaction(stores, mode);
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure || transaction.error || errorWith("AbortError", "Storage transaction was aborted."));
        transaction.onerror = (event) => { failure ||= event.target?.error || transaction.error; };
        operation(transaction, (value) => { result = value; }, fail);
      } catch (error) { if (transaction) fail(error); else reject(error); }
    });
  }

  async _write(epoch, generation, stores, operation) {
    if (!this._current(epoch, generation)) return false;
    return this._transaction([...new Set(["meta", ...stores])], "readwrite", (transaction, done, fail) => {
      const meta = transaction.objectStore("meta");
      const request = meta.get("reset");
      request.onsuccess = () => {
        try {
          const reset = validEpoch(request.result) ? request.result : EMPTY_EPOCH;
          if (!this._current(epoch, generation) || compareEpochs(reset, epoch) > 0) {
            if (compareEpochs(reset, epoch) > 0) {
              this._stale = true;
              this._status("partial", "This workspace was reset in another tab. Reload before saving changes.");
            }
            done(false);
            return;
          }
          if (reset.token !== epoch.token) meta.put(epoch, "reset");
          operation(transaction, done, fail);
        } catch (error) { fail(error); }
      };
    });
  }

  async load() {
    if (this._closing || this._closed) return null;
    return this._enqueue(async () => {
      let backup = {}, databaseError;
      try {
        backup = await this._transaction(["meta"], "readonly", (transaction, done) => {
          const result = {};
          const meta = transaction.objectStore("meta");
          meta.get("snapshot").onsuccess = (event) => { result.envelope = event.target.result; };
          meta.get("reset").onsuccess = (event) => { result.epoch = event.target.result; };
          done(result);
        });
      } catch (error) { databaseError = error; }
      // Read the synchronous journal last, so edits during database startup win.
      const local = this._read(this.keys.snapshot);
      const journal = this._decode(local.text);
      this._epoch = newestEpoch(this._readEpoch(), backup.epoch);
      this._stale = false;
      const candidates = [journal, this._envelope(backup.envelope)]
        .filter((value) => value && value.epoch === this._epoch.token).sort(compareEnvelopes);
      const latest = candidates.at(-1);
      this._lastTime = Math.max(this._lastTime, this._epoch.updatedAt, latest?.updatedAt || 0);
      if (!latest) {
        if (local.error && databaseError) this._status("unavailable", "Browser saving is unavailable. This workspace will last only for this tab.", local.error);
        else if (local.text && !journal) this._status("partial", "Saved workspace data was unreadable. New edits can still be saved.");
        return null;
      }
      this._latest = latest;
      let journalError = local.error;
      if (!journal || compareEnvelopes(latest, journal) > 0) {
        try { this.storage.setItem(this.keys.snapshot, JSON.stringify(latest)); journalError = null; }
        catch (error) { journalError = error; }
      }
      this._status(databaseError || journalError ? "partial" : "saved",
        databaseError ? "Workspace restored; uploaded-file storage is unavailable."
          : journalError ? "Workspace restored from its backup; immediate refresh protection is unavailable."
            : "Saved workspace restored.", journalError || databaseError);
      // Return a fresh JSON value so edits cannot change the stored envelope.
      return JSON.parse(JSON.stringify(latest.snapshot));
    }, null);
  }

  /** The journal write happens before returning; IndexedDB work follows in the queue. */
  save(snapshot) {
    if (this._closing || this._closed || this._clearing || !this._current(this._epoch, this._generation)) return false;
    let envelope, encoded;
    try {
      encoded = JSON.stringify({ schema: SCHEMA, scope: this.scope, updatedAt: this._time(),
        id: `${this._writer}:${++this._sequence}`, epoch: this._epoch.token, snapshot });
      envelope = this._decode(encoded);
      if (!envelope) throw new TypeError("Workspace snapshots must be JSON objects.");
    } catch (error) {
      this._status("unavailable", "This workspace could not be encoded for saving.", error);
      return false;
    }
    const epoch = this._epoch, generation = this._generation;
    this._latest = envelope;
    let journalError = null;
    try {
      if (!this.storage) throw errorWith("StorageUnavailableError", "Immediate browser saving is unavailable.");
      this.storage.setItem(this.keys.snapshot, encoded);
    } catch (error) { journalError = error; }
    this._status("saving", journalError ? "Saving workspace backup; immediate refresh protection is unavailable." : "Saving workspace...", journalError);
    void this._enqueue(async () => {
      let backedUp = false, databaseError;
      try {
        backedUp = await this._write(epoch, generation, ["meta"], (transaction, done, fail) => {
          const meta = transaction.objectStore("meta");
          const request = meta.get("snapshot");
          request.onsuccess = () => {
            try {
              const existing = this._envelope(request.result);
              if (!existing || existing.epoch !== envelope.epoch || compareEnvelopes(existing, envelope) < 0) meta.put(envelope, "snapshot");
              done(true);
            } catch (error) { fail(error); }
          };
        });
      } catch (error) { databaseError = error; }
      if (generation !== this._generation || this._stale || this._latest !== envelope) return backedUp;
      this._status(!journalError && backedUp ? "saved" : !journalError || backedUp ? "partial" : "unavailable",
        !journalError && backedUp ? "Workspace saved on this device."
          : backedUp ? "Workspace backup saved; immediate refresh protection is unavailable."
            : !journalError ? "Workspace settings saved; uploaded-file storage is unavailable."
              : "Browser saving failed. Keep this tab open or download your work.",
        journalError || databaseError);
      return backedUp;
    });
    return !journalError;
  }

  async putFile(key, file) {
    if (this._closing || this._closed || this._clearing) return false;
    const epoch = this._epoch, generation = this._generation;
    this._status("saving", "Saving uploaded file...");
    return this._enqueue(async () => {
      if (!this._current(epoch, generation)) return false;
      if (typeof key !== "string" || !key || !file || typeof file.slice !== "function" || !Number.isFinite(file.size)) {
        throw new TypeError("Choose a valid file and storage key.");
      }
      const record = { blob: file.slice(0, file.size, file.type || ""), name: String(file.name || "upload"),
        type: String(file.type || ""), lastModified: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(), epoch: epoch.token };
      const saved = await this._write(epoch, generation, ["files"], (transaction, done) => {
        transaction.objectStore("files").put(record, key);
        done(true);
      });
      if (saved && generation === this._generation) this._status("saved", "Uploaded file saved on this device.");
      return saved;
    });
  }

  async getFile(key) {
    if (this._closing || this._closed) return null;
    return this._enqueue(async () => {
      const stored = await this._transaction(["meta", "files"], "readonly", (transaction, done) => {
        const result = {};
        transaction.objectStore("meta").get("reset").onsuccess = (event) => { result.epoch = event.target.result; };
        transaction.objectStore("files").get(key).onsuccess = (event) => { result.record = event.target.result; };
        done(result);
      });
      const epoch = newestEpoch(this._epoch, this._readEpoch(), stored.epoch);
      const record = stored.record;
      if (!record || record.epoch !== epoch.token || typeof record.blob?.arrayBuffer !== "function") return null;
      return { blob: record.blob, name: record.name, type: record.type, lastModified: record.lastModified };
    }, null);
  }

  async removeFile(key) {
    if (this._closing || this._closed || this._clearing) return false;
    const epoch = this._epoch, generation = this._generation;
    return this._enqueue(() => this._write(epoch, generation, ["files"], (transaction, done) => {
      transaction.objectStore("files").delete(key);
      done(true);
    }));
  }

  async flush() { await this._queue; }

  async clear() {
    if (this._closing || this._closed || this._clearing) return false;
    this._clearing = true;
    this._generation += 1;
    this._epoch = { token: `${this._writer}:reset:${++this._sequence}`, updatedAt: this._time() };
    this._latest = null;
    this._stale = false;
    const epoch = this._epoch;
    let journalError;
    try {
      if (!this.storage) throw errorWith("StorageUnavailableError", "Immediate browser saving is unavailable.");
      this.storage.removeItem(this.keys.snapshot);
      // A small reset marker prevents an older open tab from recreating the workspace.
      this.storage.setItem(this.keys.reset, JSON.stringify(epoch));
    } catch (error) { journalError = error; }
    this._status("saving", "Clearing the saved workspace...");
    return this._enqueue(async () => {
      let databaseError;
      try {
        await this._transaction(["meta", "files"], "readwrite", (transaction, done) => {
          const meta = transaction.objectStore("meta");
          meta.clear();
          transaction.objectStore("files").clear();
          meta.put(epoch, "reset");
          done(true);
        });
      } catch (error) { databaseError = error; }
      this._clearing = false;
      const cleared = !journalError && !databaseError;
      this._status(cleared ? "saved" : "partial", cleared ? "Saved workspace and uploaded files cleared."
        : "The workspace was reset, but some browser storage could not be cleared.", journalError || databaseError);
      return cleared;
    });
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    this._closePromise = this._queue.then(() => {
      this._closed = true;
      this._db?.close();
      this._db = null;
    });
    return this._closePromise;
  }
}
