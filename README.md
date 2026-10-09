# Nile Flow Industry Attachment Programme 2026: Task Management & Performance System

## 1. What you have
| File | What it is |
|---|---|
| `NILE FLOW INDUSTRY ATTACHMENT PROGRAMME 2026 - TASK MANAGEMENT & PERFORMANCE SYSTEM.xlsx` | The private master workbook (6 tabs). Import into Google Sheets. |
| `apps_script/Code.gs`, `appsscript.json` | Member API (Apps Script, container-bound to the master). |
| `member_portal/index.html` | Static member page (host on GitHub Pages or Render static). |
| `tests/access.test.js` | Access-control tests (`node tests/access.test.js`). |

Not created directly in Google Drive: no Google connector is available in this session. Import and deploy steps are below.

## 2. Tabs
1. **Programme Dashboard**: KPI cards, 5 charts, overdue / due soon / blocked / awaiting-review lists. Calculated only.
2. **Master Task Tracker**: 23 columns, 25 tasks loaded (A1-A6, G1-G4, M1-M6, S1-S4, N1-N5), pre-formatted to 200 rows.
3. **Deadlines & Weekly Plan**: 12-week table and a formula mirror of every task with Deadline Health.
4. **Member Directory**: 5 members, stable IDs NF-M01..M05, 15-row capacity.
5. **Performance & Evaluation**: calculated metrics; supervisor 1-5 scores left blank.
6. **Instructions & SOPs**: SOPs, dropdown lists (cols J-N), open items, test results.

## 3. Access-control architecture
- The master workbook is shared with supervisors/admins only. Members are never added to it.
- Members use `member_portal/index.html`. It signs in with Google and sends the Google-signed ID token to a small Render Node.js proxy, which forwards the request to the Apps Script web app. The proxy provides the browser CORS response; Apps Script remains responsible for token verification and all data authorization.
- The server verifies token audience, issuer, expiry and verified email, maps the email to a Member ID through the Member Directory (Active and within programme dates), returns only that member's rows, and re-checks ownership on every write.
- Writes are limited to 6 columns: Status (not Completed), Progress %, Latest Progress Update, Work Completed, Blockers / Support Required, Deliverable / Evidence Link. The script sets Submission Date and Last Updated. Anything else is rejected.
- No credentials in the browser. The only values in `index.html` are the public OAuth client ID and the Render proxy URL.
- Sheet protection, filters and hidden tabs in the workbook are convenience only, not the security boundary.

Why not run the Apps Script page itself as the portal: for consumer Gmail accounts, a script running as its owner cannot read the visitor's email (`getActiveUser()` is empty), so identity would have to be self-reported. Verified ID tokens avoid that.

## 4. Deploy (about 30 minutes)
1. Google Drive: upload the xlsx, open with Google Sheets, File > Save as Google Sheets. Set sharing to Restricted, named supervisors only.
2. Fill Member Directory supervisors; confirm each email is a Google sign-in account.
3. Extensions > Apps Script. Paste `Code.gs`; enable the manifest (Project Settings > Show appsscript.json) and paste `appsscript.json`.
4. Google Cloud Console (same account): create OAuth consent screen (External or Internal), then OAuth client ID type Web application. Add the portal's origin (e.g. `https://yourname.github.io`) under Authorised JavaScript origins. Copy the client ID.
5. Apps Script > Project Settings > Script properties: add `GOOGLE_CLIENT_ID`. Optional: `AUDIT_SPREADSHEET_ID`.
6. Deploy > New deployment > Web app: Execute as **Me**, access **Anyone**. Authorise. Copy the `/exec` URL.
7. Triggers: add an installable trigger for `onTrackerEdit`, event From spreadsheet, On edit (logs supervisor edits).
8. Set `GOOGLE_CLIENT_ID` in `member_portal/index.html`. Deploy the static site to Render with publish directory `member_portal`.
9. Deploy `api_proxy` as a separate Render Web Service from the same repository. Set its root directory to `api_proxy`, build command to `npm install`, and start command to `npm start`. Add environment variables `APPS_SCRIPT_WEB_APP_URL` (the Apps Script `/exec` URL) and `PORTAL_ORIGIN` (`https://nile-flow-attachment.onrender.com`, with no trailing slash). Use Node 18 or newer.
10. Set `API_URL` in `member_portal/index.html` to the proxy URL plus `/api` (for example, `https://nile-flow-api.onrender.com/api`), commit and push the change, and wait for the static site to redeploy. If you use a different Render service name, use its actual URL.
11. Run the live checks in section 8 before telling members. Check the proxy health at `<proxy URL>/healthz`; it should return JSON with `"ok":true`.

The proxy only accepts requests from the configured portal origin and only forwards the two supported API actions. It is not an authorization boundary: Google ID-token validation, member lookup, row ownership checks, and editable-column checks remain in Apps Script.

## 5. Add a member / assign tasks
Add a row in Member Directory (new unique ID, Google email, track, supervisor, dates, Active). Then add the task row in the Tracker, pick the member from the dropdown; Member ID, Deadline Health and the dashboard fill themselves.

## 6. Members
Open the portal link, sign in with the registered Google account, open a task, update daily. Blocked needs a blocker note; submitting needs an https evidence link. Members cannot mark Completed.

## 7. Supervisors: Friday review
Filter Tracker Status = Submitted for Review (or use the dashboard list). Read the evidence, write Supervisor Feedback, set Review Decision. Approved: set Status = Completed (locks the task in the portal). Changes Requested: set Status = In Progress.
Deactivate a leaver by setting Status = Inactive; access stops on the next request.

## 8. Tests
Run `node tests/access.test.js` (mocked Apps Script services). Results: scenarios 1, 2, 3, 4, 6, 7, 8, 9 pass; a mutation check (removing the ownership check or the whitelist) makes tests 3, 4, 6 fail, so the tests do detect regressions.

**Still unverified, needs a live run after deployment:**
- Scenario 5: supervisors manage tasks (depends on real Drive sharing).
- Real Google token verification through `oauth2.googleapis.com/tokeninfo` and the browser sign-in from your hosting origin.
- Browser fetch to the Apps Script `/exec` URL (CORS redirect behaviour) from the hosted page.
- That the master file is not reachable by any member (check Share dialog and "Anyone with the link" is off).
- Text starting with `=` stays plain text in real Sheets (script sets text format first).
Live checklist: sign in as two test members; confirm each sees only their own tasks; try editing the other's task ID in the browser console; sign in with an unlisted Google account; set one member Inactive and retry.

## 9. Known limitations and open items
- Supervisor names are not in the source data. Assigned By / Supervisor and Assigned Supervisor are blank (yellow). The technical lead is not named.
- Dates assume working Week 1 = Mon 12 Oct 2026 (kickoff Sat 10 Oct). Confirm. A6 is set to 30 Dec (written parts targeted 18 Dec). Priorities are proposed by rule. Date Assigned is blank.
- Tokeninfo verification is simple and fine at this scale (5 users); at larger scale verify the JWT signature locally.
- The audit log is not tamper-proof (the owner can edit it). Audit Log is created as a 7th tab on first use unless `AUDIT_SPREADSHEET_ID` is set.
- Apps Script quotas apply (about 20,000 URL fetches/day on free accounts: ample here).
- The `appsscript.json` "Anyone" setting means the endpoint is public; safety rests on token verification, which the tests cover only in mocked form.
- Sheet protection has no password; add one in Sheets (Data > Protect sheets) if wanted.
- Capacity: 200 tasks, 15 members; charts show 8 members and 4 tracks.
