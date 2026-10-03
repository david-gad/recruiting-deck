/* User-entered conversation records stay separate from mail-derived facts. */
function hhField(key, field, label, value, placeholder, type) {
  const id = 'hh-' + key + '-' + field;
  const attrs = ' id="' + esc(id) + '" data-cf="' + field + '" data-ck="' + esc(key) + '"';
  return '<div class="field"><label for="' + esc(id) + '">' + label + '</label>' +
    (type ? '<input type="' + type + '"' + attrs + ' value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '">' :
      '<textarea' + attrs + ' placeholder="' + esc(placeholder || '') + '">' + esc(value || '') + '</textarea>') + '</div>';
}
function hhMeetingField(key, m, field, label, type) {
  const id = 'hhm-' + key + '-' + m.id + '-' + field;
  const attrs = ' id="' + esc(id) + '" data-hh-field="' + field + '" data-hh-key="' + esc(key) + '" data-hh-id="' + esc(m.id) + '"';
  return '<div class="field"><label for="' + esc(id) + '">' + label + '</label>' +
    (type ? '<input type="' + type + '"' + attrs + ' value="' + esc(m[field] || '') + '">' :
      '<textarea' + attrs + ' placeholder="' + (field === 'notes' ? 'What came up, what you agreed, and what to remember' : 'Names of funds or firms discussed') + '">' + esc(m[field] || '') + '</textarea>') + '</div>';
}
function hhMeetings(c) { return Array.isArray(c.meetings) ? c.meetings : []; }
function renderHeadhunters() {
  const keys = Object.keys(convos).sort((a,b) => convos[a].firm.localeCompare(convos[b].firm));
  const out = $('#convoOut');
  const detailKey = el => (el.closest('[data-hh-card]')?.dataset.hhCard || '') + ':' +
    (el.dataset.hhEntry || el.querySelector('summary')?.textContent || '');
  const expanded = new Set(Array.from(out.querySelectorAll('details[open]'), detailKey));
  const focused = document.activeElement;
  const editing = focused && out.contains(focused) ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null;
  if (!keys.length) {
    out.innerHTML = '<div class="msg"><h4>Start with one headhunter</h4><div>Add their search firm below, or import firms found in your email. Record what you told them, then add a meeting note after each conversation.</div></div>';
    $('#convoFoot').textContent = ''; renderOnBooks(); return;
  }
  out.innerHTML = '<div class="dossiers hh-cards">' + keys.map(k => {
    const c = convos[k], meetings = hhMeetings(c), id = esc(k), det = detectedFunds(c.firm);
    return '<article class="dossier" data-hh-card="' + id + '"><div class="d-head"><input class="dfirm" value="' + esc(c.firm) + '" data-cfirm="' + id + '" aria-label="Headhunter firm name"><button class="kill" data-cremove="' + id + '" aria-label="Remove ' + esc(c.firm) + '">✕</button></div><div class="d-body">' +
      hhField(k, 'contact', 'Headhunter / contact', c.contact, 'e.g. Jane Smith', 'text') +
      hhField(k, 'prefs', 'What I told them I want', c.prefs, 'e.g. UMM buyout, New York, generalist. With this firm I said UMM; with another I may say megafund.') +
      '<div class="hh-section"><h3>Next step</h3><div class="frow">' + hhField(k, 'next', 'Follow-up / action', c.next, 'e.g. Send résumé on Friday', 'text') + hhField(k, 'meeting', 'Next meeting', c.meeting, '', 'datetime-local') + '</div></div>' +
      '<details class="hh-section"><summary>General notes on this headhunter</summary><p class="hh-help">Keep ongoing context here. Meeting-specific details belong in the history below.</p>' +
      hhField(k, 'notes', 'General headhunter notes', c.notes, 'Firms discussed, interests, relationship context, and things to remember') +
      hhField(k, 'pushing', 'Funds they suggested', c.pushing, 'e.g. Apollo, KKR, Charlesbank', 'text') +
      hhField(k, 'strategy', 'Their advice / positioning', c.strategy, 'Sectors, locations, fund sizes, or timing they recommended') +
      '<div class="field"><label>Email mentions · review before relying on them</label><div class="detected">' + (det.length ? det.map(f => '<span class="fund">' + esc(f) + '</span>').join('') : '<span class="none">No funds detected yet</span>') + '</div></div></details>' +
      '<div class="hh-section"><div class="hh-heading"><h3>Notes from meetings</h3><button class="btn dark" data-hh-add="' + id + '">+ Add meeting note</button></div><p class="hh-help">One entry per conversation. Your previous notes stay in the history.</p>' +
      (meetings.length ? meetings.slice().sort((a,b) => String(b.date).localeCompare(String(a.date)) || b.createdAt - a.createdAt).map(m =>
        '<details class="hh-entry" data-hh-entry="' + esc(m.id) + '"><summary><span data-hh-date>' + esc(m.date || 'Undated meeting') + '</span> · <span data-hh-contact>' + esc(m.contact || 'Conversation') + '</span></summary>' +
        '<div class="frow">' + hhMeetingField(k,m,'date','Meeting date','date') + hhMeetingField(k,m,'contact','Who I spoke with','text') + '</div>' +
        hhMeetingField(k,m,'funds','Firms / funds discussed') + hhMeetingField(k,m,'preferences','What I told them in this meeting','text') + hhMeetingField(k,m,'notes','Meeting notes') +
        hhMeetingField(k,m,'followup','Agreed follow-up','text') + '<button class="btn danger" data-hh-delete="' + esc(m.id) + '" data-hh-key="' + id + '">Delete this meeting note</button></details>').join('') : '<p class="hh-help">No meetings logged yet. Add a note after your first call.</p>') + '</div>' +
      '<details class="hh-section"><summary>Relationship status</summary><div class="field"><label for="hh-read-' + id + '">How things stand</label><select id="hh-read-' + id + '" data-cf="read" data-ck="' + id + '">' + READS.map(r => '<option' + (r === c.read ? ' selected' : '') + '>' + esc(r) + '</option>').join('') + '</select></div>' + hhField(k,'lastConvo','Last conversation',c.lastConvo,'','date') + '</details>' +
      '</div><div class="d-foot"><span>Saved as you type · on this device</span><span class="spacer"></span><span>' + meetings.length + ' meeting notes</span></div></article>';
  }).join('') + '</div>';
  out.querySelectorAll('details').forEach(el => { if(expanded.has(detailKey(el))) el.open = true; });
  if(editing?.id){
    const restored = document.getElementById(editing.id);
    if(restored){
      restored.focus({preventScroll:true});
      if(typeof editing.start === 'number' && typeof restored.setSelectionRange === 'function') restored.setSelectionRange(editing.start, editing.end);
    }
  }
  $('#convoFoot').textContent = keys.length + ' headhunter firms · ' + keys.reduce((n,k) => n + hhMeetings(convos[k]).length,0) + ' meeting notes';
  renderOnBooks();
}
function hhMeetingText(c) {
  return hhMeetings(c).map(m => '\nMeeting: ' + (m.date || 'Undated') + '\nContact: ' + (m.contact || '—') + '\nFunds discussed: ' + (m.funds || '—') + '\nWhat I told them: ' + (m.preferences || '—') + '\nMeeting notes: ' + (m.notes || '—') + '\nFollow-up: ' + (m.followup || '—')).join('\n');
}
document.addEventListener('click', ev => {
  const b = ev.target.closest && ev.target.closest('button'); if (!b) return;
  if (b.dataset.hhAdd) {
    const c = convos[b.dataset.hhAdd]; if (!c) return;
    const d = new Date(), date = [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
    const m = {id: crypto.randomUUID(), createdAt: Date.now(), date, contact:c.contact || '', funds:'', preferences:c.prefs || '', notes:'', followup:''};
    c.meetings = hhMeetings(c); c.meetings.push(m); saveConvos(); renderConvos();
    const entry = Array.from(document.querySelectorAll('[data-hh-entry]')).find(e => e.dataset.hhEntry === m.id);
    if (entry) {entry.open = true; entry.querySelector('[data-hh-field="notes"]').focus();}
  }
  if (b.dataset.hhDelete) {
    if (!confirm('Delete this meeting note? This cannot be undone.')) return;
    const c = convos[b.dataset.hhKey]; if (!c) return;
    c.meetings = hhMeetings(c).filter(m => m.id !== b.dataset.hhDelete); saveConvos(); renderConvos();
  }
});
document.addEventListener('input', ev => {
  const el = ev.target, field = el.dataset && el.dataset.hhField;
  if (!['date','contact','funds','preferences','notes','followup'].includes(field)) return;
  const c = convos[el.dataset.hhKey], m = c && hhMeetings(c).find(m => m.id === el.dataset.hhId); if (!m) return;
  m[field] = el.value; saveConvos();
  const entry = el.closest('[data-hh-entry]');
  if (field === 'date') entry.querySelector('[data-hh-date]').textContent = m.date || 'Undated meeting';
  if (field === 'contact') entry.querySelector('[data-hh-contact]').textContent = m.contact || 'Conversation';
});
