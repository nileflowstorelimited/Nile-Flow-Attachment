/**
 * NILE FLOW INDUSTRY ATTACHMENT PROGRAMME 2026 - Member API
 *
 * Container-bound script on the PRIVATE master workbook.
 * Deploy as Web app: Execute as = Me (the owner); Who has access = Anyone.
 * ("Anyone" only means the endpoint is reachable: every request must carry a
 *  Google-signed ID token that is verified server-side, or it is refused.)
 *
 * Script properties (Project Settings > Script properties):
 *   GOOGLE_CLIENT_ID        OAuth Web client ID (public value) the portal signs in with
 *   AUDIT_SPREADSHEET_ID    optional: separate spreadsheet for the audit log
 *
 * Security rules enforced here:
 *  - Identity comes ONLY from a verified Google ID token. Names/emails/IDs in the request body are ignored.
 *  - Member ID is derived from the verified email via the Member Directory (Active, within dates).
 *  - Ownership is re-checked on every write. Not-found and not-yours return the same error.
 *  - Only the whitelisted columns can be written. Everything else is rejected.
 *  - The spreadsheet, tokens and credentials are never returned to the browser.
 */
var CFG = {
  TRACKER: 'Master Task Tracker',
  DIRECTORY: 'Member Directory',
  AUDIT: 'Audit Log',
  TRACKER_HEADER_ROW: 3,
  DIRECTORY_HEADER_ROW: 3,
  ISSUERS: ['accounts.google.com', 'https://accounts.google.com'],
  TOKENINFO: 'https://oauth2.googleapis.com/tokeninfo?id_token=',
  RATE_LIMIT_PER_MIN: 60,
  MAX_TEXT: 2000,
  MAX_LINK: 500,
  // Columns a member may change (by header text)
  MEMBER_EDITABLE: ['Status', 'Progress %', 'Latest Progress Update', 'Work Completed',
                    'Blockers / Support Required', 'Deliverable / Evidence Link'],
  // Statuses a member may set. 'Completed' is supervisor-only.
  MEMBER_STATUSES: ['Not Started', 'In Progress', 'Blocked', 'Submitted for Review'],
  // Columns returned to the member (own tasks only)
  MEMBER_VISIBLE: ['Task ID', 'Task Title', 'Department / Track', 'Task Description',
                   'Expected Outcome / Acceptance Criteria', 'Priority', 'Assigned By / Supervisor',
                   'Date Assigned', 'Start Date', 'Due Date', 'Status', 'Progress %',
                   'Latest Progress Update', 'Work Completed', 'Blockers / Support Required',
                   'Deliverable / Evidence Link', 'Submission Date', 'Supervisor Feedback',
                   'Review Decision', 'Last Updated', 'Deadline Health'],
  AUDITED_EDIT_COLUMNS: ['Assigned Member', 'Start Date', 'Due Date', 'Priority', 'Status',
                         'Submission Date', 'Supervisor Feedback', 'Review Decision', 'Assigned By / Supervisor']
};

/* ---------------- web app entry points ---------------- */
function doGet() {
  return json_({ ok: true, service: 'Nile Flow attachment API' });   // no data on GET
}

function doPost(e) {
  var req, actor = '';
  try {
    req = parseBody_(e);
    var email = verifyIdToken_(req.idToken);
    if (!email) return deny_('auth', 'Sign-in required.', '', '', req);
    actor = email;
    if (!rateOk_(email)) return deny_('rate', 'Too many requests. Wait a minute.', email, '', req);
    var member = resolveMember_(email);
    if (!member) return deny_('inactive', 'No active access for this account.', email, '', req);
    // Anything the client says about identity (memberId, email, name) is deliberately never read.
    if (req.action === 'getMyTasks') return json_({ ok: true, member: { name: member.name }, tasks: getMyTasks_(member) });
    if (req.action === 'updateTask') return json_(updateTask_(member, email, req.taskId, req.updates));
    return deny_('action', 'Unknown action.', email, '', req);
  } catch (err) {
    audit_([actor, '', '', 'ERROR', '', '', String(err && err.message || err).slice(0, 200)]);
    return json_({ ok: false, error: 'Request could not be processed.' });
  }
}

/* ---------------- identity ---------------- */
function parseBody_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw || raw.length > 20000) throw new Error('bad body');
  var o = JSON.parse(raw);
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('bad body');
  return o;
}

/** Verifies a Google ID token via Google's tokeninfo endpoint. Returns lower-case verified email or ''. */
function verifyIdToken_(token) {
  if (typeof token !== 'string' || token.length < 100 || token.length > 4096) return '';
  var clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) return '';                                   // fail closed when not configured
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var hit = cache.get(key);
  if (hit) { try { var c = JSON.parse(hit); if (c.exp * 1000 > Date.now()) return c.email; } catch (x) {} }
  var res = UrlFetchApp.fetch(CFG.TOKENINFO + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return '';
  var p = JSON.parse(res.getContentText());
  var verified = p.email_verified === true || p.email_verified === 'true';
  if (p.aud !== clientId || CFG.ISSUERS.indexOf(p.iss) < 0 || !verified || !p.email) return '';
  var exp = Number(p.exp);
  if (!exp || exp * 1000 <= Date.now()) return '';
  var email = String(p.email).toLowerCase();
  cache.put(key, JSON.stringify({ email: email, exp: exp }), Math.min(300, Math.max(1, Math.floor(exp - Date.now() / 1000))));
  return email;
}

function rateOk_(email) {
  var cache = CacheService.getScriptCache();
  var k = 'rl_' + email + '_' + Math.floor(Date.now() / 60000);
  var n = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(n), 90);
  return n <= CFG.RATE_LIMIT_PER_MIN;
}

/** Maps verified email -> directory member. Must be Active and inside programme dates. */
function resolveMember_(email) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CFG.DIRECTORY);
  var t = table_(sh, CFG.DIRECTORY_HEADER_ROW);
  var today = today_(ss);
  var found = null;
  t.rows.forEach(function (r) {
    var em = String(r[t.col['Email (Google account)']] || '').trim().toLowerCase();
    if (em && em === email) {
      var status = String(r[t.col['Status']] || '').trim();
      var end = dateStr_(r[t.col['Programme End']], ss);
      var start = dateStr_(r[t.col['Programme Start']], ss);
      var ok = status === 'Active' && (!end || today <= end) && (!start || today >= start);
      if (ok && !found) found = { id: String(r[t.col['Member ID']]).trim(), name: String(r[t.col['Full Name']]) };
    }
  });
  return found;
}

/* ---------------- reads ---------------- */
function getMyTasks_(member) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t = table_(ss.getSheetByName(CFG.TRACKER), CFG.TRACKER_HEADER_ROW);
  var out = [];
  t.rows.forEach(function (r) {
    if (String(r[t.col['Task ID']]).trim() === '') return;
    if (String(r[t.col['Member Email / ID']]).trim() !== member.id) return;   // ownership filter on the server
    var o = {};
    CFG.MEMBER_VISIBLE.forEach(function (h) {
      var v = r[t.col[h]];
      if (v instanceof Date) v = dateStr_(v, ss);
      if (h === 'Progress %') v = Math.round(Number(v || 0) * 100);
      o[h] = (v === null || v === undefined) ? '' : v;
    });
    out.push(o);
  });
  return out;
}

/* ---------------- writes ---------------- */
function updateTask_(member, email, taskId, updates) {
  var DENY = 'Task not found or not permitted.';
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(taskId)) return fail_(email, member, String(taskId).slice(0, 30), 'bad task id', DENY);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return fail_(email, member, taskId, 'bad updates', 'Invalid update.');
  var keys = Object.keys(updates);
  if (!keys.length || keys.length > CFG.MEMBER_EDITABLE.length) return fail_(email, member, taskId, 'bad updates', 'Invalid update.');
  for (var i = 0; i < keys.length; i++) {
    if (CFG.MEMBER_EDITABLE.indexOf(keys[i]) < 0) return fail_(email, member, taskId, 'field not editable: ' + keys[i], 'You cannot change "' + String(keys[i]).slice(0, 40) + '".');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(CFG.TRACKER);
    var t = table_(sh, CFG.TRACKER_HEADER_ROW);
    var idx = -1;
    for (var k = 0; k < t.rows.length; k++) if (String(t.rows[k][t.col['Task ID']]).trim() === taskId) { idx = k; break; }
    if (idx < 0) return fail_(email, member, taskId, 'not found', DENY);
    var row = t.rows[idx];
    if (String(row[t.col['Member Email / ID']]).trim() !== member.id) return fail_(email, member, taskId, 'not owner', DENY);   // ownership on EVERY write
    var curStatus = String(row[t.col['Status']]);
    if (curStatus === 'Completed' || String(row[t.col['Review Decision']]) === 'Approved') return fail_(email, member, taskId, 'locked', 'This task is completed and locked.');

    // validate into a candidate record
    var cand = {};
    CFG.MEMBER_EDITABLE.forEach(function (h) { cand[h] = row[t.col[h]]; });
    cand['Progress %'] = Math.round(Number(cand['Progress %'] || 0) * 100);
    var err = null;
    keys.forEach(function (h) {
      if (err) return;
      var v = updates[h];
      if (h === 'Status') {
        if (typeof v !== 'string' || CFG.MEMBER_STATUSES.indexOf(v) < 0) err = 'Status must be one of: ' + CFG.MEMBER_STATUSES.join(', ') + '.';
      } else if (h === 'Progress %') {
        if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 100 || Math.floor(v) !== v) err = 'Progress must be a whole number 0-100.';
      } else if (h === 'Deliverable / Evidence Link') {
        if (typeof v !== 'string' || v.length > CFG.MAX_LINK || (v !== '' && !/^https:\/\/[^\s]+$/i.test(v))) err = 'Link must be a full https:// address.';
      } else {
        if (typeof v !== 'string' || v.length > CFG.MAX_TEXT) err = h + ' must be text up to ' + CFG.MAX_TEXT + ' characters.';
      }
      if (!err) cand[h] = v;
    });
    if (err) return fail_(email, member, taskId, 'validation: ' + err, err);
    if (cand['Status'] === 'Not Started' && cand['Progress %'] > 0) return fail_(email, member, taskId, 'validation', 'A task with progress cannot be Not Started.');
    if (cand['Status'] === 'Blocked' && !String(cand['Blockers / Support Required']).trim()) return fail_(email, member, taskId, 'validation', 'Explain the blocker and the support you need.');
    if (cand['Status'] === 'Submitted for Review' && !String(cand['Deliverable / Evidence Link']).trim()) return fail_(email, member, taskId, 'validation', 'Add your evidence link before submitting for review.');

    var sheetRow = CFG.TRACKER_HEADER_ROW + 1 + idx;
    var now = new Date(), tz = ss.getSpreadsheetTimeZone();
    keys.forEach(function (h) {
      var cell = sh.getRange(sheetRow, t.col[h] + 1);
      var oldV = row[t.col[h]];
      if (h === 'Progress %') cell.setValue(updates[h] / 100);
      else { cell.setNumberFormat('@'); cell.setValue(updates[h]); }           // text format: no formula injection
      audit_([isoNow_(now, tz), email, member.id, taskId, h, String(oldV).slice(0, 200), String(updates[h]).slice(0, 200), 'OK']);
    });
    if (cand['Status'] === 'Submitted for Review' && curStatus !== 'Submitted for Review') {
      sh.getRange(sheetRow, t.col['Submission Date'] + 1).setValue(dateOnly_(now, tz));
    }
    sh.getRange(sheetRow, t.col['Last Updated'] + 1).setValue(dateOnly_(now, tz));
    return { ok: true, tasks: getMyTasks_(member).filter(function (x) { return x['Task ID'] === taskId; }) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- supervisor edit audit (install as an installable onEdit trigger) ---------------- */
function onTrackerEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== CFG.TRACKER || e.range.getRow() <= CFG.TRACKER_HEADER_ROW) return;
  var header = sh.getRange(CFG.TRACKER_HEADER_ROW, e.range.getColumn()).getValue();
  if (CFG.AUDITED_EDIT_COLUMNS.indexOf(header) < 0) return;
  var who = (e.user && e.user.getEmail && e.user.getEmail()) || Session.getActiveUser().getEmail() || 'unknown';
  var taskId = sh.getRange(e.range.getRow(), 1).getValue();
  audit_([new Date().toISOString(), who, 'SUPERVISOR', taskId, header, e.oldValue === undefined ? '' : String(e.oldValue).slice(0, 200), String(e.value === undefined ? '' : e.value).slice(0, 200), 'SHEET EDIT']);
}

/* ---------------- helpers ---------------- */
function fail_(email, member, taskId, reason, msg) {
  audit_([new Date().toISOString(), email, member && member.id || '', taskId, '', '', reason, 'DENIED']);
  return { ok: false, error: msg };
}
function deny_(code, msg, email, taskId, req) {
  audit_([new Date().toISOString(), email, '', taskId, '', '', code + (req && req.action ? ' / ' + String(req.action).slice(0, 30) : ''), 'DENIED']);
  return json_({ ok: false, error: msg });
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function table_(sh, headerRow) {
  var vals = sh.getDataRange().getValues();
  var head = vals[headerRow - 1], col = {};
  head.forEach(function (h, i) { col[String(h).trim()] = i; });
  return { col: col, rows: vals.slice(headerRow) };
}
function today_(ss) { return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd'); }
function dateStr_(v, ss) { return v instanceof Date ? Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : String(v || ''); }
function dateOnly_(d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); }
function isoNow_(d, tz) { return Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss"); }

function audit_(row) {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('AUDIT_SPREADSHEET_ID');
    var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(CFG.AUDIT);
    if (!sh) {
      sh = ss.insertSheet(CFG.AUDIT);
      sh.appendRow(['Timestamp', 'Actor (verified email)', 'Member ID', 'Task ID', 'Field', 'Old value', 'New value / reason', 'Result']);
    }
    if (row.length === 7) row.unshift(new Date().toISOString());
    sh.appendRow(row);
  } catch (e) { /* audit must never block or leak */ }
}
