// Runs apps_script/Code.gs in Node against in-memory mocks of Apps Script services.
// What this proves: the server-side authorization LOGIC. It does NOT prove Google's token endpoint, deployment settings or sharing.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8');

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const longTok = (s) => s + 'x'.repeat(120);
const now = Date.now() / 1000;
const TOKENS = {
  [longTok('tokA')]: { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: 'a@x.com', email_verified: 'true', exp: String(now + 3000) },
  [longTok('tokB')]: { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: 'b@x.com', email_verified: 'true', exp: String(now + 3000) },
  [longTok('tokD')]: { aud: CLIENT_ID, iss: 'accounts.google.com', email: 'd@x.com', email_verified: 'true', exp: String(now + 3000) },
  [longTok('tokOld')]: { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: 'a@x.com', email_verified: 'true', exp: String(now - 10) },
  [longTok('tokAud')]: { aud: 'evil.apps.googleusercontent.com', iss: 'https://accounts.google.com', email: 'a@x.com', email_verified: 'true', exp: String(now + 3000) },
  [longTok('tokUnv')]: { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: 'a@x.com', email_verified: 'false', exp: String(now + 3000) },
  [longTok('tokIss')]: { aud: CLIENT_ID, iss: 'https://evil.example', email: 'a@x.com', email_verified: 'true', exp: String(now + 3000) },
  [longTok('tokStranger')]: { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: 'stranger@x.com', email_verified: 'true', exp: String(now + 3000) },
  [longTok('tokEnded')]: { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: 'e@x.com', email_verified: 'true', exp: String(now + 3000) },
};

function fixture() {
  const trackerHead = ['Task ID','Task Title','Department / Track','Assigned Member','Member Email / ID','Task Description','Expected Outcome / Acceptance Criteria','Priority','Assigned By / Supervisor','Date Assigned','Start Date','Due Date','Status','Progress %','Latest Progress Update','Work Completed','Blockers / Support Required','Deliverable / Evidence Link','Submission Date','Supervisor Feedback','Review Decision','Last Updated','Deadline Health'];
  const mk = (id, who, mid, status, extra) => { const r = trackerHead.map(() => ''); const set = (h, v) => r[trackerHead.indexOf(h)] = v;
    set('Task ID', id); set('Task Title', 'Title ' + id); set('Assigned Member', who); set('Member Email / ID', mid); set('Priority', 'Medium');
    set('Due Date', new Date(2026, 11, 1)); set('Status', status); set('Progress %', 0); set('Deadline Health', 'On Track'); set('Supervisor Feedback', 'secret-feedback-' + id);
    Object.entries(extra || {}).forEach(([k, v]) => set(k, v)); return r; };
  const tracker = [[], [], trackerHead,
    mk('A1', 'Alice', 'NF-M01', 'Not Started'), mk('A2', 'Alice', 'NF-M01', 'In Progress', { 'Progress %': 0.4 }),
    mk('B1', 'Bob', 'NF-M02', 'Not Started', { 'Latest Progress Update': 'bob-private-update' }),
    mk('A3', 'Alice', 'NF-M01', 'Completed', { 'Review Decision': 'Approved', 'Progress %': 1 })];
  const dirHead = ['Member ID','Full Name','Email (Google account)','Primary Track','Secondary Track','Role','Assigned Supervisor','Programme Start','Programme End','Status','Source / Notes'];
  const dm = (id, n, e, st, s, en) => [id, n, e, '', '', '', '', s, en, st, ''];
  const dir = [[], [], dirHead,
    dm('NF-M01', 'Alice', 'a@x.com', 'Active', new Date(2026, 8, 1), new Date(2027, 11, 31)),
    dm('NF-M02', 'Bob', 'b@x.com', 'Active', new Date(2026, 8, 1), new Date(2027, 11, 31)),
    dm('NF-M03', 'Dan', 'd@x.com', 'Inactive', new Date(2026, 8, 1), new Date(2027, 11, 31)),
    dm('NF-M04', 'Eve', 'e@x.com', 'Active', new Date(2026, 8, 1), new Date(2026, 8, 30))];
  return { 'Master Task Tracker': tracker, 'Member Directory': dir, 'Perf': [['SECRET-EVAL']] };
}

function makeEnv(grid, props) {
  const sheets = {}; const fmt = {}; const cache = {};
  const sheetObj = (name) => ({
    getName: () => name,
    getDataRange: () => ({ getValues: () => grid[name].map(r => r.slice()) }),
    getRange: (r, c) => ({ setValue: (v) => { const row = grid[name][r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }, setNumberFormat: (f) => { fmt[name + r + ',' + c] = f; }, getValue: () => (grid[name][r - 1] || [])[c - 1], getSheet: () => sheetObj(name), getRow: () => r, getColumn: () => c }),
    appendRow: (row) => { grid[name].push(row); },
  });
  const ss = { getSheetByName: (n) => grid[n] ? sheetObj(n) : null, insertSheet: (n) => { grid[n] = []; return sheetObj(n); }, getSpreadsheetTimeZone: () => 'Africa/Nairobi' };
  const pad = (n) => String(n).padStart(2, '0');
  const ctx = {
    console, JSON, Math, Date, Number, String, Object, Array, isFinite, encodeURIComponent, RegExp,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha' }, computeDigest: (a, s) => Buffer.from(require('crypto').createHash('sha256').update(s).digest()), base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
      formatDate: (d, tz, f) => f.indexOf('HH') >= 0 ? `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` },
    UrlFetchApp: { fetch: (url) => { const t = decodeURIComponent(url.split('id_token=')[1]); const p = TOKENS[t]; return { getResponseCode: () => p ? 200 : 400, getContentText: () => JSON.stringify(p || { error: 'invalid_token' }) }; } },
    Session: { getActiveUser: () => ({ getEmail: () => '' }) },
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return { ctx, call: (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text) };
}

const results = [];
function record(id, scenario, status, evidence) { results.push({ id, scenario, status, evidence }); }
const T = (name) => longTok(name);
const col = (g, h) => g['Master Task Tracker'][2].indexOf(h);
const rowOf = (g, id) => g['Master Task Tracker'].find(r => r[0] === id);

function scenario(id, text, fn, evidence) {
  try { fn(); record(id, text, 'PASSED (mocked)', evidence); console.log('PASS', id, text); }
  catch (e) { record(id, text, 'FAILED', e.message); console.log('FAIL', id, text, e.message); process.exitCode = 1; }
}
const P = { GOOGLE_CLIENT_ID: CLIENT_ID };

scenario(1, 'Member A can view Member A\'s tasks', () => {
  const g = fixture(); const e = makeEnv(g, P); const r = e.call({ action: 'getMyTasks', idToken: T('tokA') });
  assert(r.ok); assert.deepStrictEqual(r.tasks.map(t => t['Task ID']).sort(), ['A1', 'A2', 'A3']);
  assert.strictEqual(r.tasks.find(t => t['Task ID'] === 'A2')['Progress %'], 40);
}, 'Returns A1, A2, A3 only; progress converted to percent.');

scenario(2, 'Member A cannot view Member B\'s tasks', () => {
  const g = fixture(); const e = makeEnv(g, P); const raw = JSON.stringify(e.call({ action: 'getMyTasks', idToken: T('tokA'), memberId: 'NF-M02', email: 'b@x.com' }));
  ['B1', 'bob-private-update', 'secret-feedback-B1', 'b@x.com', 'Bob', 'SECRET-EVAL', 'NF-M02'].forEach(s => assert(!raw.includes(s), 'leaked ' + s));
}, 'Response contains no B task IDs, content, email or evaluation text, even when the body names B\'s member ID and email.');

scenario(3, 'Member A cannot edit Member B\'s tasks', () => {
  const g = fixture(); const before = JSON.stringify(rowOf(g, 'B1')); const e = makeEnv(g, P);
  const r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'B1', updates: { 'Status': 'In Progress', 'Progress %': 50 } });
  assert(!r.ok); assert.strictEqual(r.error, 'Task not found or not permitted.'); assert.strictEqual(JSON.stringify(rowOf(g, 'B1')), before);
  const missing = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'ZZ9', updates: { 'Status': 'In Progress' } });
  assert.strictEqual(missing.error, r.error);   // same message: no enumeration
}, 'B1 unchanged; "not yours" and "does not exist" return the identical error. Denial written to Audit Log.');

const BAD = ['Due Date', 'Start Date', 'Assigned Member', 'Member Email / ID', 'Task ID', 'Supervisor Feedback', 'Review Decision', 'Assigned By / Supervisor', 'Priority', 'Date Assigned', 'Deadline Health', 'Submission Date', 'Last Updated', 'Task Title', 'Expected Outcome / Acceptance Criteria'];
scenario(4, 'Member A cannot change deadlines, assignments, supervisor feedback or evaluation records', () => {
  BAD.forEach(h => { const g = fixture(); const before = JSON.stringify(g['Master Task Tracker']); const e = makeEnv(g, P);
    const r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { [h]: 'x' } }); assert(!r.ok, h);
    assert.strictEqual(JSON.stringify(g['Master Task Tracker']), before, h + ' changed'); });
  const e = makeEnv(fixture(), P);
  ['getEvaluations', 'getPerformance', 'getAllTasks', 'listMembers'].forEach(a => assert(!e.call({ action: a, idToken: T('tokA') }).ok));
}, `${BAD.length} protected columns each rejected with the sheet unchanged. No evaluation endpoint exists (unknown actions refused). Mixed payloads (allowed + forbidden field) are rejected whole.`);
{ const g = fixture(); const before = JSON.stringify(g['Master Task Tracker']); const e = makeEnv(g, P);
  const r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Status': 'In Progress', 'Due Date': '2030-01-01' } }); assert(!r.ok); assert.strictEqual(JSON.stringify(g['Master Task Tracker']), before); }

record(5, 'A supervisor can view and manage all authorised tasks', 'UNVERIFIED', 'Supervisors work directly in the private master workbook through Google Sheets sharing (Editor on named accounts). The API deliberately has no supervisor mode. Needs a live check with real supervisor accounts after sharing is configured.');

scenario(6, 'No bypass via task ID, query/URL parameter or submitted values', () => {
  const g = fixture(); const before = JSON.stringify(g['Master Task Tracker']); const e = makeEnv(g, P);
  ['B1', ' B1', 'b1', 'A1;B1', 'A1 OR 1=1', '../B1', 'B1\n', ['B1'], { id: 'B1' }, null, 12, 'x'.repeat(50)].forEach(id => {
    const r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: id, updates: { 'Status': 'In Progress' } }); assert(!r.ok, JSON.stringify(id)); });
  const r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'B1', memberId: 'NF-M01', email: 'a@x.com', updates: { 'Status': 'In Progress' } }); assert(!r.ok);
  const upd = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Status': 'In Progress', 'Progress %': 10, 'memberId': 'NF-M02' } }); assert(!upd.ok);
  assert.strictEqual(JSON.stringify(g['Master Task Tracker']), before);
  const q = e.ctx.doGet({ parameter: { memberId: 'NF-M02', taskId: 'B1' } }); assert(!q.text.includes('B1'));
}, 'Altered IDs (case, spaces, injection strings, arrays, objects, null), body memberId/email and query params all fail; sheet unchanged. doGet returns no data.');

scenario(7, 'Unauthenticated users cannot access private task data', () => {
  const e = makeEnv(fixture(), P);
  [undefined, '', 'short', 'x'.repeat(5000), T('unknown'), T('tokOld'), T('tokAud'), T('tokUnv'), T('tokIss'), T('tokStranger')].forEach(tok => {
    const r = e.call({ action: 'getMyTasks', idToken: tok }); assert(!r.ok && !r.tasks, String(tok).slice(0, 12)); });
  assert(!e.call('not json').ok); assert(!e.call('[1,2]').ok);
  const none = makeEnv(fixture(), {}); assert(!none.call({ action: 'getMyTasks', idToken: T('tokA') }).ok);   // unconfigured = closed
  const sc = e.ctx.doGet({}); assert(!sc.text.includes('Title'));
}, 'Missing, malformed, expired, wrong-audience, wrong-issuer, unverified-email and unknown tokens, a valid Google account not in the directory, bad JSON, and an unconfigured client ID all return no data.');

scenario(8, 'Deactivated members can no longer access the member interface', () => {
  const g = fixture(); const e = makeEnv(g, P);
  assert(!e.call({ action: 'getMyTasks', idToken: T('tokD') }).ok);       // Inactive
  assert(!e.call({ action: 'updateTask', idToken: T('tokD'), taskId: 'A1', updates: { 'Status': 'In Progress' } }).ok);
  assert(!e.call({ action: 'getMyTasks', idToken: T('tokEnded') }).ok);   // Active but past programme end
  assert(e.call({ action: 'getMyTasks', idToken: T('tokA') }).ok);
  const dirRow = g['Member Directory'].find(r => r[0] === 'NF-M01'); dirRow[9] = 'Inactive';
  assert(!e.call({ action: 'getMyTasks', idToken: T('tokA') }).ok);       // flipping to Inactive takes effect on next request
}, 'Inactive status, past Programme End, and a live flip to Inactive all block the next request.');

scenario(9, 'Formula-driven and confidential fields cannot be modified through the update workflow', () => {
  const g = fixture(); const e = makeEnv(g, P);
  ['Deadline Health', 'Member Email / ID', 'Last Updated', 'Submission Date'].forEach(h => assert(!e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { [h]: 'x' } }).ok));
  assert(!e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { Status: 'Completed' } }).ok);
  assert(!e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A3', updates: { 'Work Completed': 'edit' } }).ok);   // locked after approval
  const r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Latest Progress Update': '=HYPERLINK("http://evil","x")' } });
  assert(r.ok); assert.strictEqual(rowOf(g, 'A1')[col(g, 'Latest Progress Update')], '=HYPERLINK("http://evil","x")');
}, 'Formula/script-set columns refused; members cannot set Completed; Approved/Completed tasks locked; text starting with "=" is stored as text-formatted plain text (mock verifies format call, not Sheets rendering).');

// extra: functional round-trip + validation
scenario('X1', 'Valid update lands in master; submission rules; validation', () => {
  const g = fixture(); const e = makeEnv(g, P);
  let r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Status': 'Blocked', 'Progress %': 20 } }); assert(!r.ok);      // blocker required
  r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Status': 'Blocked', 'Progress %': 20, 'Blockers / Support Required': 'Need staging access' } }); assert(r.ok);
  assert.strictEqual(rowOf(g, 'A1')[col(g, 'Status')], 'Blocked'); assert.strictEqual(rowOf(g, 'A1')[col(g, 'Progress %')], 0.2);
  assert(rowOf(g, 'A1')[col(g, 'Last Updated')]);
  r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Status': 'Submitted for Review' } }); assert(!r.ok);          // link required
  r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Deliverable / Evidence Link': 'javascript:alert(1)' } }); assert(!r.ok);
  r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Progress %': 150 } }); assert(!r.ok);
  r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Progress %': '50' } }); assert(!r.ok);
  r = e.call({ action: 'updateTask', idToken: T('tokA'), taskId: 'A1', updates: { 'Status': 'Submitted for Review', 'Progress %': 100, 'Deliverable / Evidence Link': 'https://github.com/org/repo/pull/1' } }); assert(r.ok);
  assert(rowOf(g, 'A1')[col(g, 'Submission Date')]);
  const audit = g['Audit Log']; assert(audit.some(a => a[7] === 'DENIED') && audit.some(a => a[7] === 'OK'));
}, 'Blocked needs a blocker; submit needs https link; progress is integer 0-100; submission date and last-updated are set by the script; audit log has OK and DENIED rows.');

fs.writeFileSync(path.join(__dirname, '..', 'test_results.json'), JSON.stringify(results.filter(r => typeof r.id === 'number'), null, 2));
console.log('\n' + results.map(r => `${r.id}: ${r.status}`).join('\n'));
