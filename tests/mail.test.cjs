const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');
const { parseHTML, DOMParser } = require('linkedom');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function app() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const { window, document } = parseHTML(html);
  const local = new Map(), session = new Map();
  const storage = map => ({ getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) });
  const ctx = vm.createContext({ window, document, DOMParser, console, URL, URLSearchParams,
    structuredClone, indexedDB: new IDBFactory(), crypto: webcrypto, TextDecoder, TextEncoder,
    Uint8Array, atob, btoa, setTimeout, clearTimeout, localStorage: storage(local), sessionStorage: storage(session),
    navigator: {}, location: { origin: 'https://example.com', pathname: '/', protocol: 'https:' } });
  for (const file of ['mail-store.js', 'mail-sync.js', 'headhunter.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx);
  // Load production functions, excluding UI event registration and boot.
  const main = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1].split('const TABS =')[0];
  vm.runInContext(main, ctx);
  return { ctx, run: code => vm.runInContext(code, ctx) };
}
function rawG(id, text = 'Hello', extra = {}) {
  return { id, threadId: 'thread-' + id, internalDate: String(Date.now()), labelIds: ['INBOX'],
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Jane Doe <jane@dspny.com>' }, { name: 'Subject', value: 'Apollo reception' }], body: { data: Buffer.from(text).toString('base64url') } }, ...extra };
}
function message(id, text, extra = {}) {
  return { id, threadId: 't', acct: 'google:me@example.com', subject: 'Apollo reception', sender: 'Jane <jane@fund.com>', email: 'jane@fund.com', to: [], ts: Date.now(), text, snippet: text, labels: [], sent: false, ...extra };
}
function googleAdapter(get) { return { key: 'google:me@example.com', kind: 'google', pool: fn => Promise.resolve().then(fn), get }; }
async function sync(env, adapter, store, days = 365, valid = () => true) {
  env.ctx.ad = adapter; env.ctx.store = store; env.ctx.snapshot = await store.read(adapter.key); env.ctx.valid = valid;
  return env.run(`new MailSync(store, ad, snapshot, valid, () => {}).run(${days})`);
}

test('full Gmail text, UTF-8, multipart alternatives and quoted replies', () => {
  const a = app(); a.ctx.raw = rawG('1', 'Hello José\n' + 'x'.repeat(350) + '\nThanks for attending Apollo.\nOn Monday Jane wrote:\nYou are invited.');
  const m = a.run('gmMsg(raw)');
  assert.match(m.text, /José/); assert.match(m.text, /Thanks for attending/); assert.doesNotMatch(m.text, /You are invited/);
  a.ctx.payload = { mimeType: 'multipart/alternative', parts: [rawG('x', 'Plain body').payload, { mimeType: 'text/html', body: { data: Buffer.from('<p>Duplicate HTML</p>').toString('base64url') } }] };
  assert.equal(a.run('gmailBody(payload)'), 'Plain body');
});

test('Outlook parses full text beyond its preview; HTML quotes and scripts are removed', () => {
  const a = app(); a.ctx.raw = { id: 'm', conversationId: 'c', bodyPreview: 'Short preview', body: { contentType: 'text', content: 'x'.repeat(400) + '\nThanks for registering.' }, from: { emailAddress: { address: 'jane@fund.com' } }, receivedDateTime: new Date().toISOString() };
  assert.match(a.run('msMsg(raw).text'), /Thanks for registering/);
  a.ctx.markup = '<html><body><p>Current message</p><blockquote>Old attendance</blockquote><script>bad()</script></body></html>';
  const text = a.run('htmlMailText(markup)');
  assert.match(text, /Current message/); assert.doesNotMatch(text, /attendance|bad/);
});

test('recruiters outside the known domain list remain visible for review', () => {
  const a = app(); a.ctx.msg = message('1', 'I am a recruiter at New Search. Please share your resume.', { email: 'jane@newsearch.com', sender: 'Jane Doe <jane@newsearch.com>' });
  const rows = a.run('buildFirmRows([finishThread("t", [msg], msg.acct)])');
  assert.equal(rows.length, 1); assert.equal(rows[0].src, 'Needs review');
});

test('attendance and follow-up require separate inbound evidence in the same conversation', () => {
  const a = app(), now = Date.now();
  a.ctx.msgs = [message('1', 'Thanks for attending our Apollo reception.', { ts: now - 1000 }), message('2', 'Please send me your availability for next steps at Apollo.', { ts: now })];
  let rows = a.run('buildPeRows([finishThread("t", msgs, msgs[0].acct)])');
  assert.equal(rows[0].rank, 5); assert.equal(rows[0].evidence.length, 2);
  a.ctx.msgs[1].sent = true;
  rows = a.run('buildPeRows([finishThread("t", msgs, msgs[0].acct)])');
  assert.equal(rows[0].rank, 4);
  a.ctx.msgs[1].sent = false;
  rows = a.run('buildPeRows(msgs.map(m => finishThread(m.id, [m], m.acct)))');
  assert.equal(rows[0].rank, 4);
});

test('multiple funds, quoted attendance, negations and old confirmations do not invent progress', () => {
  const a = app();
  a.ctx.msg = message('1', 'Thanks for attending the Apollo and Blackstone reception.');
  let rows = a.run('buildPeRows([finishThread("t", [msg], msg.acct)])');
  assert.ok(rows.every(r => r.rank === 0));
  a.ctx.msg = message('2', "I did not attend the Apollo event.", { sent: true });
  assert.equal(a.run('messageSignal(msg).rank'), 0);
  a.ctx.msg = message('3', 'Hello\nOn Monday Jane wrote:\nThanks for attending Apollo.');
  assert.equal(a.run('messageSignal(msg).rank'), 0);
  a.ctx.msg = message('4', 'Your RSVP is confirmed for Apollo.', { ts: 1000 });
  rows = a.run('buildPeRows([finishThread("t", [msg], msg.acct)])');
  assert.equal(rows[0].rank, 3);
  a.ctx.row = rows[0]; assert.doesNotMatch(a.run('badgeFor(row)'), /Occurred|Attended/);
});

test('manual correction survives new evidence and an empty time window', () => {
  const a = app(); a.run('progressOverrides.apollo = { firm: "Apollo", rank: 2 };');
  a.ctx.msg = message('1', 'Thanks for attending the Apollo event.');
  assert.equal(a.run('buildPeRows([finishThread("t", [msg], msg.acct)])[0].rank'), 2);
  assert.equal(a.run('buildPeRows([])[0].manual'), true);
  a.run('save(K.overrides, progressOverrides); progressOverrides = {}; loadUserState();');
  assert.equal(a.run('buildPeRows([])[0].rank'), 2);
});

test('persistent index isolates accounts and deduplicates repeated writes', async () => {
  const a = app(), store = a.run('new MailStore()');
  const row = { account: 'a', slot: '/1', message: message('1', 'one') };
  await store.commit({ key: 'a', historyId: '10' }, [row]);
  await store.commit({ key: 'a', historyId: '11' }, [row]);
  const reopened = a.run('new MailStore()');
  assert.equal((await reopened.read('a')).rows.length, 1);
  assert.equal((await reopened.read('b')).rows.length, 0);
  assert.equal((await reopened.read('a')).state.historyId, '11');
  await reopened.erase(['a']); assert.equal((await reopened.read('a')).rows.length, 0);
});

test('Gmail completes pages then only fetches changed messages on the next visit', async () => {
  const a = app(), store = a.run('new MailStore()'), calls = [];
  let second = false;
  const adapter = googleAdapter(async (p, q = {}) => {
    calls.push([p, q]);
    if(p === '/profile') return { historyId: '10' };
    if(p === '/messages') return q.pageToken ? { messages: [{ id: '2' }] } : { messages: [{ id: '1' }], nextPageToken: 'p2' };
    if(p === '/history') return second ? { historyId: '12', history: [{ messagesAdded: [{ message: { id: '3' } }] }] } : { historyId: '11' };
    return rawG(p.split('/').pop());
  });
  let result = await sync(a, adapter, store);
  assert.equal(result.rows.length, 2); assert.equal(result.state.historyId, '11');
  assert.ok(result.state.lastSync); assert.equal(result.state.syncing, false);
  second = true; calls.length = 0;
  result = await sync(a, adapter, store);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(calls.map(c => c[0]), ['/history', '/messages/3']);
});

test('failed Gmail page retains its checkpoint and resumes without fetching completed pages', async () => {
  const a = app(), store = a.run('new MailStore()'); let fail = true;
  const calls = [];
  const adapter = googleAdapter(async (p, q = {}) => {
    calls.push([p, q.pageToken]);
    if(p === '/profile') return { historyId: '10' };
    if(p === '/messages') return q.pageToken ? { messages: [{ id: '2' }] } : { messages: [{ id: '1' }], nextPageToken: 'p2' };
    if(p === '/messages/2' && fail) throw new Error('Network down');
    if(p === '/history') return { historyId: '11' };
    return rawG(p.split('/').pop());
  });
  await assert.rejects(sync(a, adapter, store), /Network down/);
  const saved = await store.read(adapter.key);
  assert.equal(saved.rows.length, 1); assert.equal(saved.state.initial.page, 'p2'); assert.equal(saved.state.lastSync, undefined);
  fail = false; calls.length = 0;
  const result = await sync(a, adapter, store);
  assert.equal(result.rows.length, 2); assert.equal(calls[0][1], 'p2');
  assert.ok(!calls.some(c => c[0] === '/messages/1'));
});

test('Gmail handles deletions and expired history without erasing the saved dashboard', async () => {
  const a = app(), store = a.run('new MailStore()');
  const key = 'google:me@example.com';
  await store.commit({ key, historyId: '10', coverageFrom: 0 }, [{ account: key, slot: '/1', message: message('1', 'saved') }]);
  let adapter = googleAdapter(async p => { if(p === '/history') return { historyId: '11', history: [{ messagesDeleted: [{ message: { id: '1' } }] }] }; throw Object.assign(new Error('gone'), { status: 404 }); });
  assert.equal((await sync(a, adapter, store)).rows.length, 0);
  await store.commit({ key, historyId: '11', coverageFrom: 0 }, [{ account: key, slot: '/2', message: message('2', 'saved') }]);
  adapter = googleAdapter(async () => { throw Object.assign(new Error('expired'), { status: 404 }); });
  await assert.rejects(sync(a, adapter, store), /checkpoint expired/);
  const saved = await store.read(key);
  assert.equal(saved.rows.length, 1); assert.equal(saved.state.historyId, undefined);
});

test('quota failure cannot advance a persisted checkpoint', async () => {
  const a = app(), store = a.run('new MailStore()'), key = 'google:me@example.com';
  await store.commit({ key, historyId: '10', coverageFrom: 0 }, []);
  const commit = store.commit.bind(store);
  store.commit = async (s, rows, remove) => { if(rows?.length) throw new Error('Quota exceeded'); return commit(s, rows, remove); };
  const adapter = googleAdapter(async p => p === '/history' ? { historyId: '20', history: [{ messagesAdded: [{ message: { id: '1' } }] }] } : rawG('1'));
  await assert.rejects(sync(a, adapter, store), /Quota exceeded/);
  assert.equal((await store.read(key)).state.historyId, '10');
  assert.equal((await store.read(key)).rows.length, 0);
});

test('Outlook follows folder and delta pages, resumes per folder, and preserves moved messages', async () => {
  const a = app(), store = a.run('new MailStore()'), calls = [];
  let next = false;
  const mail = (id, folder) => ({ id, conversationId: 'c', parentFolderId: folder, receivedDateTime: new Date().toISOString(), body: { contentType: 'text', content: 'Thanks for attending Apollo.' } });
  const adapter = { kind: 'microsoft', key: 'microsoft:me@example.com', inboxId: 'A', sentId: 'B', deletedId: 'trash', junkId: 'junk', get: async (p) => {
    calls.push(p);
    if(p === '/me/mailFolders') return { value: [{ id: 'A', childFolderCount: 0 }], '@odata.nextLink': 'https://graph.microsoft.com/folders2' };
    if(p.endsWith('/folders2')) return { value: [{ id: 'B', childFolderCount: 0 }] };
    if(p === '/me/mailFolders/A/messages/delta') return { value: [mail('1', 'A')], '@odata.nextLink': 'https://graph.microsoft.com/Apage2' };
    if(p.endsWith('/Apage2')) return { value: [mail('2', 'A')], '@odata.deltaLink': 'https://graph.microsoft.com/Adelta' };
    if(p === '/me/mailFolders/B/messages/delta') return { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/Bdelta' };
    if(p.endsWith('/Adelta')) return { value: next ? [{ id: '1', '@removed': { reason: 'deleted' } }] : [], '@odata.deltaLink': p };
    if(p.endsWith('/Bdelta')) return { value: next ? [mail('1', 'B')] : [], '@odata.deltaLink': p };
    throw Error('Unexpected ' + p);
  } };
  let result = await sync(a, adapter, store);
  assert.equal(result.rows.length, 2); assert.ok(result.state.folders.A.url.endsWith('/Adelta'));
  next = true; calls.length = 0;
  result = await sync(a, adapter, store);
  assert.equal(result.rows.length, 2); assert.ok(result.rows.some(r => r.slot === 'B/1')); assert.ok(!result.rows.some(r => r.slot === 'A/1'));
  assert.ok(!calls.some(p => p.endsWith('/messages/delta')));
});

test('cancellation prevents index writes after sign-out', async () => {
  const a = app(), store = a.run('new MailStore()');
  await assert.rejects(sync(a, googleAdapter(async () => { throw Error('should not call'); }), store, 365, () => false), /Sync stopped/);
  assert.equal((await store.read('google:me@example.com')).state.coverageFrom, undefined);
});

test('a cancellation in the same event thread withdraws earlier inferred confirmation', () => {
  const a = app(); a.ctx.msgs = [message('1', 'Your RSVP is confirmed for Apollo.', { ts: 1000 }), message('2', 'The Apollo reception is cancelled.', { ts: 2000 })];
  const row = a.run('buildPeRows([finishThread("t", msgs, msgs[0].acct)])[0]');
  assert.equal(row.rank, 0); assert.match(row.evidence[0].phrase, /cancelled/);
});

test('database transaction abort rolls back mail and its checkpoint together', async () => {
  const a = app(), store = a.run('new MailStore()');
  await store.commit({ key: 'a', historyId: '10' }, []);
  const db = await store.open();
  await new Promise(resolve => {
    const tx = db.transaction(['accounts', 'messages'], 'readwrite');
    tx.objectStore('accounts').put({ key: 'a', historyId: '20' });
    tx.objectStore('messages').put({ account: 'a', slot: '/1', message: message('1', 'new') });
    tx.onabort = resolve; tx.abort();
  });
  const saved = await store.read('a');
  assert.equal(saved.state.historyId, '10'); assert.equal(saved.rows.length, 0);
});

test('Outlook retries an interrupted delta page without replaying completed pages', async () => {
  const a = app(), store = a.run('new MailStore()'), calls = []; let fail = true;
  const adapter = { kind: 'microsoft', key: 'microsoft:me@example.com', deletedId: 'trash', junkId: 'junk', get: async p => {
    calls.push(p);
    if(p === '/me/mailFolders') return { value: [{ id: 'A' }] };
    if(p.endsWith('/messages/delta')) return { value: [{ id: '1', parentFolderId: 'A', receivedDateTime: new Date().toISOString(), body: { contentType: 'text', content: 'one' } }], '@odata.nextLink': 'https://graph.microsoft.com/next' };
    if(p.endsWith('/next')) { if(fail) throw new Error('Outlook offline'); return { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta' }; }
    throw Error('Unexpected ' + p);
  } };
  await assert.rejects(sync(a, adapter, store), /Outlook offline/);
  let saved = await store.read(adapter.key);
  assert.equal(saved.rows.length, 1); assert.ok(saved.state.folders.A.url.endsWith('/next')); assert.equal(saved.state.lastSync, undefined);
  fail = false; calls.length = 0;
  saved = await sync(a, adapter, store);
  assert.equal(saved.rows.length, 1); assert.ok(saved.state.lastSync); assert.ok(!calls.some(p => p.endsWith('/messages/delta')));
});

test('identical provider IDs in different accounts do not collide, but shared Message-ID copies deduplicate', () => {
  const a = app(); a.ctx.one = message('1', 'first'); a.ctx.two = message('1', 'second', { acct: 'google:other@example.com' });
  assert.equal(a.run('mergeThreads([[finishThread("t", [one], one.acct)], [finishThread("t", [two], two.acct)]]).length'), 2);
  a.ctx.one.mid = a.ctx.two.mid = '<shared@example.com>';
  assert.equal(a.run('mergeThreads([[finishThread("t", [one], one.acct)], [finishThread("t", [two], two.acct)]]).length'), 1);
});

test('headhunter preferences and dated meeting notes remain separate across firms and reloads', () => {
  const a = app();
  a.run(`convos = {}; const umm = convoFor('UMM Search'), mega = convoFor('Mega Search');
    umm.prefs = 'UMM buyout'; mega.prefs = 'Megafund'; umm.notes = 'Existing general relationship notes';
    umm.meetings = [{id:'first', date:'2026-10-01', contact:'Jane', notes:'First call', preferences:'UMM'},
      {id:'second', date:'2026-10-03', contact:'Jane', notes:'Second call', funds:'Apollo'}];
    saveConvos(); renderConvos();`);
  const doc = a.ctx.document;
  assert.equal(doc.querySelectorAll('[data-hh-entry]').length, 2);
  const input = doc.querySelector('[data-hh-id="first"][data-hh-field="notes"]');
  input.value = 'Updated first meeting'; input.dispatchEvent(new a.ctx.window.Event('input', {bubbles:true}));
  a.run('convos = load(K.convos, {}); renderConvos();');
  assert.equal(a.run('convos.ummsearch.meetings[0].notes'), 'Updated first meeting');
  assert.equal(a.run('convos.ummsearch.meetings[1].notes'), 'Second call');
  assert.equal(a.run('convos.megasearch.prefs'), 'Megafund');
  assert.equal(a.run('convos.ummsearch.notes'), 'Existing general relationship notes');
  assert.match(a.run('convoText()'), /Updated first meeting/);
  doc.querySelector('[data-hh-add="ummsearch"]').click();
  assert.equal(a.run('convos.ummsearch.meetings.length'), 3);
  assert.equal(a.run('convos.ummsearch.meetings[2].preferences'), 'UMM buyout');
});

test('linking workspaces keeps meeting history from both workspaces without duplicating entries', () => {
  const a = app();
  a.run(`rawSet('old.', K.convos, {firm: {firm:'Firm', notes:'Old notes', meetings:[{id:'shared',notes:'Older version'},{id:'old',notes:'Earlier meeting'}]}});
    rawSet('new.', K.convos, {firm: {firm:'Firm', notes:'New notes', meetings:[{id:'shared',notes:'Current version'},{id:'new',notes:'Latest meeting'}]}});
    mergeInto('old.', 'new.');`);
  const merged = a.run("rawGet('new.', K.convos).firm");
  assert.equal(merged.meetings.length, 3);
  assert.equal(merged.meetings.find(m => m.id === 'shared').notes, 'Current version');
  assert.match(merged.notes, /Old notes/); assert.match(merged.notes, /New notes/);
});

test('background mail rendering preserves expanded meeting history', () => {
  const a = app();
  a.run(`const hh = convoFor('Test Search'); hh.meetings = [{id:'meeting',date:'2026-10-03',notes:'Keep this open'}]; renderConvos();`);
  const entry = a.ctx.document.querySelector('[data-hh-entry="meeting"]');
  entry.setAttribute('open', '');
  a.run('renderSavedMail();');
  assert.equal(a.ctx.document.querySelector('[data-hh-entry="meeting"]').open, true);
});
