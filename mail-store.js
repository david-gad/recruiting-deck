"use strict";

// Mail and its resume checkpoint always commit in the same transaction.
// Tokens and credentials are deliberately excluded from this database.
class MailStore {
  constructor(factory = indexedDB) { this.factory = factory; this.opening = null; }
  open() {
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      const req = this.factory.open("rcd-mail-v1", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("accounts", { keyPath: "key" });
        const messages = db.createObjectStore("messages", { keyPath: ["account", "slot"] });
        messages.createIndex("account", "account");
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("Close other Command Deck tabs and try again."));
      req.onsuccess = () => {
        req.result.onversionchange = () => { req.result.close(); this.opening = null; };
        resolve(req.result);
      };
    }).catch(e => { this.opening = null; throw e; });
    return this.opening;
  }
  async read(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["accounts", "messages"], "readonly");
      const state = tx.objectStore("accounts").get(key);
      const rows = tx.objectStore("messages").index("account").getAll(key);
      tx.oncomplete = () => resolve({ state: state.result || { key }, rows: rows.result });
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Could not read saved mail."));
    });
  }
  async commit(state, rows = [], remove = []) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["accounts", "messages"], "readwrite");
      tx.objectStore("accounts").put(state);
      const messages = tx.objectStore("messages");
      remove.forEach(slot => messages.delete([state.key, slot]));
      rows.forEach(row => messages.put(row));
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Could not save mail. Check available browser storage."));
    });
  }
  async erase(keys) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["accounts", "messages"], "readwrite");
      for (const key of keys) {
        tx.objectStore("accounts").delete(key);
        const req = tx.objectStore("messages").index("account").openCursor(key);
        req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } };
      }
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Could not erase saved mail."));
    });
  }
}
