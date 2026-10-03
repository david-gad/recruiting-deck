"use strict";

function htmlMailText(html) {
  // Template contents are inert: remote images/tracking pixels never load.
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const doc = template.content;
  doc.querySelectorAll("#divRplyFwdMsg").forEach(n => { while(n.nextSibling) n.nextSibling.remove(); });
  doc.querySelectorAll("script,style,head,blockquote,.gmail_quote,#divRplyFwdMsg").forEach(n => n.remove());
  doc.querySelectorAll("br").forEach(n => n.replaceWith("\n"));
  doc.querySelectorAll("div,p,tr,li,section").forEach(n => n.append("\n"));
  return Array.from(doc.childNodes, n => n.textContent || "").join("");
}
function currentMailText(text) {
  // Preserve line breaks until reply boundaries are removed. Never promote
  // quoted history or a forwarded invitation into a new progress event.
  return String(text || "").replace(/\r\n?/g, "\n")
    .split(/\n\s*(?:On [^\n]{1,300}wrote:|From:\s|[-_]{2,}\s*(?:Original|Forwarded) Message|Begin forwarded message:)/i)[0]
    .split("\n").filter(line => !/^\s*>/.test(line)).join("\n").trim();
}
function decodeMailData(data, charset = "utf-8") {
  const raw = atob(String(data || "").replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  try { return new TextDecoder(charset).decode(bytes); }
  catch (_) { return new TextDecoder().decode(bytes); }
}
function gmailBody(payload) {
  if (!payload || payload.filename) return ""; // attachments are not message text
  const type = (payload.mimeType || "").toLowerCase();
  if (type === "message/rfc822") return "";
  const parts = payload.parts || [];
  if (parts.length) {
    if (type === "multipart/alternative") {
      const plain = parts.find(p => p.mimeType === "text/plain");
      return gmailBody(plain) || parts.map(gmailBody).find(Boolean) || "";
    }
    return parts.map(gmailBody).filter(Boolean).join("\n");
  }
  if (!/^text\/(plain|html)$/.test(type) || !payload.body?.data) return "";
  const contentType = (payload.headers || []).find(h => h.name.toLowerCase() === "content-type")?.value || "";
  const charset = /charset=["']?([^\s;"']+)/i.exec(contentType)?.[1];
  const text = decodeMailData(payload.body.data, charset);
  return currentMailText(type === "text/html" ? htmlMailText(text) : text);
}
async function hydrateGmailBody(adapter, message) {
  // Gmail sometimes puts a text body in the attachment endpoint. Fetch just
  // those body parts, never ordinary file attachments.
  async function visit(part) {
    if (!part || part.filename || part.mimeType === "message/rfc822") return;
    if (/^text\/(plain|html)$/.test(part.mimeType) && part.body?.attachmentId && !part.body.data) {
      const data = await adapter.get("/messages/" + encodeURIComponent(message.id) + "/attachments/" + encodeURIComponent(part.body.attachmentId));
      part.body.data = data.data;
    }
    for (const child of part.parts || []) await visit(child);
  }
  await visit(message.payload);
  return message;
}

class MailSync {
  constructor(store, adapter, snapshot, valid, progress) {
    this.store = store; this.a = adapter;
    this.state = structuredClone(snapshot.state);
    this.rows = new Map(snapshot.rows.map(r => [r.slot, r]));
    this.valid = valid; this.progress = progress;
    this.count = 0;
  }
  check() { if (!this.valid()) throw new ApiError("cancelled", "Sync stopped."); }
  async commit(rows = [], remove = []) {
    this.check();
    try { await this.store.commit(this.state, rows, remove); }
    catch (e) { throw new ApiError("storage", e.message); }
    remove.forEach(id => this.rows.delete(id));
    rows.forEach(row => this.rows.set(row.slot, row));
    this.count += rows.length;
    this.progress(this.rows.size, this.state.lastSync, this.count);
  }
  row(message, folder, generation) {
    message.acct = this.a.key;
    return { account: this.a.key, slot: folder + "/" + message.id, folder, generation, message };
  }
  async run(days) {
    const cutoff = days ? Date.now() - days * 86400000 : 0;
    if (this.state.coverageFrom == null || cutoff < this.state.coverageFrom) {
      this.state.coverageFrom = cutoff;
      delete this.state.historyId; delete this.state.initial; delete this.state.historyPage;
      this.state.folders = {};
    }
    this.state.key = this.a.key;
    this.state.syncing = true;
    await this.commit();
    if (this.a.kind === "google") await this.google(); else await this.microsoft();
    this.state.lastSync = Date.now();
    this.state.syncing = false;
    await this.commit();
    return { state: this.state, rows: [...this.rows.values()] };
  }
  async gmailMessages(ids, generation) {
    const results = await Promise.all(ids.map(id => this.a.pool(async () => {
      this.check();
      try {
        const raw = await this.a.get("/messages/" + encodeURIComponent(id), { format: "full" });
        const message = gmMsg(await hydrateGmailBody(this.a, raw));
        const keep = message.ts >= this.state.coverageFrom && !message.labels.some(l => ["TRASH", "SPAM", "DRAFT"].includes(l));
        return keep ? this.row(message, "", generation) : { removed: "/" + id };
      } catch (e) { if (e.status === 404) return { removed: "/" + id }; throw e; }
    })));
    return { rows: results.filter(r => !r.removed), remove: results.filter(r => r.removed).map(r => r.removed) };
  }
  async google() {
    if (!this.state.historyId) {
      if (!this.state.initial) {
        const profile = await this.a.get("/profile");
        this.state.initial = { generation: crypto.randomUUID(), historyId: profile.historyId, page: null };
        await this.commit();
      }
      const init = this.state.initial;
      do {
        this.check();
        let page;
        try {
          page = await this.a.get("/messages", { maxResults: 100, pageToken: init.page,
            q: "-in:trash -in:spam -in:drafts" + (this.state.coverageFrom ? " after:" + Math.floor(this.state.coverageFrom / 1000) : "") });
        } catch (e) {
          if (e.status === 400 && init.page) { init.page = null; await this.commit(); throw new ApiError("api", "Saved page expired. Click Sync changes to restart this scan safely."); }
          throw e;
        }
        const changes = await this.gmailMessages((page.messages || []).map(m => m.id), init.generation);
        init.page = page.nextPageToken || null;
        if (!init.page) {
          changes.remove.push(...[...this.rows.values()].filter(r => r.generation !== init.generation && !changes.rows.some(n => n.slot === r.slot)).map(r => r.slot));
          this.state.historyId = init.historyId;
          delete this.state.initial;
        }
        await this.commit(changes.rows, changes.remove);
      } while (init.page);
    }
    // Replay changes made during the initial scan as well as later changes.
    do {
      this.check();
      let page;
      try { page = await this.a.get("/history", { startHistoryId: this.state.historyId, pageToken: this.state.historyPage, maxResults: 100 }); }
      catch (e) {
        if (e.status === 404 || (e.status === 400 && this.state.historyPage)) {
          delete this.state.historyId; delete this.state.historyPage;
          await this.commit();
          // Retain the last saved view until a replacement scan completes.
          throw new ApiError("resync", "Mail provider checkpoint expired. Your saved results are intact. Click Sync changes to rebuild the index.");
        }
        throw e;
      }
      const ids = new Set();
      for (const event of page.history || []) {
        for (const field of ["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"])
          for (const item of event[field] || []) ids.add(item.message.id);
      }
      const changes = await this.gmailMessages([...ids], "incremental");
      this.state.historyPage = page.nextPageToken || null;
      if (!this.state.historyPage) this.state.historyId = page.historyId || this.state.historyId;
      await this.commit(changes.rows, changes.remove);
    } while (this.state.historyPage);
  }
  async folderList() {
    const folders = [], queue = ["/me/mailFolders"];
    while (queue.length) {
      let url = queue.shift();
      do {
        this.check();
        const page = await this.a.get(url, url.startsWith("/") ? { $top: 100, $select: "id,childFolderCount" } : undefined);
        for (const f of page.value || []) {
          if ([this.a.deletedId, this.a.junkId].includes(f.id)) continue;
          folders.push(f.id);
          if (f.childFolderCount) queue.push("/me/mailFolders/" + encodeURIComponent(f.id) + "/childFolders");
        }
        url = page["@odata.nextLink"];
      } while (url);
    }
    return folders;
  }
  async microsoft() {
    // Delta is per folder. Keep folder membership in the key so a removal
    // from the old folder cannot delete the new copy after a message moves.
    const folders = await this.folderList();
    this.state.folders ||= {};
    for (const old of Object.keys(this.state.folders)) if (!folders.includes(old)) delete this.state.folders[old];
    await this.commit([], [...this.rows.values()].filter(r => !folders.includes(r.folder)).map(r => r.slot));
    for (const id of folders) {
      let cursor = this.state.folders[id];
      if (!cursor) cursor = this.state.folders[id] = { generation: crypto.randomUUID(), initial: true, url: null };
      let complete = false;
      do {
        this.check();
        let page;
        try {
          page = await this.a.get(cursor.url || "/me/mailFolders/" + encodeURIComponent(id) + "/messages/delta",
            cursor.url ? undefined : { $select: MS_SELECT, $top: 100 });
        } catch (e) {
          if ([404, 410].includes(e.status)) {
            delete this.state.folders[id]; await this.commit();
            throw new ApiError("resync", "An Outlook folder changed or its checkpoint expired. Click Sync changes to resume safely.");
          }
          throw e;
        }
        const rows = [], remove = [];
        for (const raw of page.value || []) {
          if (raw["@removed"]) { remove.push(id + "/" + raw.id); continue; }
          const message = msMsg(raw, this.a);
          if (!raw.isDraft && message.ts >= this.state.coverageFrom && ![this.a.deletedId, this.a.junkId].includes(raw.parentFolderId))
            rows.push(this.row(message, id, cursor.generation));
          else remove.push(id + "/" + raw.id);
        }
        complete = !!page["@odata.deltaLink"];
        cursor.url = page["@odata.nextLink"] || page["@odata.deltaLink"];
        if (!cursor.url) throw new ApiError("api", "Outlook returned no sync checkpoint. Your saved results are intact.");
        if (complete && cursor.initial) {
          remove.push(...[...this.rows.values()].filter(r => r.folder === id && r.generation !== cursor.generation && !rows.some(n => n.slot === r.slot)).map(r => r.slot));
          cursor.initial = false;
        }
        await this.commit(rows, remove);
      } while (!complete);
    }
  }
}
