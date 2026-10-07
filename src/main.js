'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createGitHub, parseRepo } = require('./core/github');
const { createClaude, MODELS } = require('./core/claude');
const { createLessonStore, toMarkdown, fromMarkdown, mergeForReview, REPO_FILE } = require('./core/lessons');
const { runReview, proposeLesson, buildGitHubReview } = require('./core/review');
const { createSettings } = require('./core/settings');

let settings;
let store;
let win;

function clients() {
  const s = settings.secrets();
  if (!s.githubToken) throw new Error('Add your GitHub access token in Settings first.');
  return { github: createGitHub({ token: s.githubToken }), makeClaude: () => createClaude({ apiKey: s.anthropicKey, model: s.model }) };
}

// Local lessons plus any the team committed to the repository.
async function lessonsFor(github, owner, repo, ref) {
  const local = store.load(owner, repo);
  let shared = [];
  try {
    const text = await github.getFileText(owner, repo, REPO_FILE, ref);
    if (text) shared = fromMarkdown(text);
  } catch { /* the shared file is optional */ }
  return mergeForReview(local, shared);
}

// Errors cross the IPC boundary as plain data so the window can show them.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerHandlers() {
  handle('settings:get', () => ({ ...settings.publicView(), models: MODELS }));
  handle('settings:save', (p) => { settings.save(p); return settings.publicView(); });

  handle('pulls:list', async ({ repo, state }) => {
    const r = parseRepo(repo);
    const { github } = clients();
    const pulls = await github.listPulls(r.owner, r.repo, state);
    settings.save({ lastRepo: `${r.owner}/${r.repo}` });
    return { repo: `${r.owner}/${r.repo}`, pulls };
  });

  handle('review:run', async ({ repo, number }) => {
    const r = parseRepo(repo);
    const { github, makeClaude } = clients();
    const pull = await github.getPull(r.owner, r.repo, number);
    const lessons = await lessonsFor(github, r.owner, r.repo, pull.baseRef);
    const result = await runReview({ github, claude: makeClaude(), owner: r.owner, repo: r.repo, number, lessons });
    store.recordTriggers(r.owner, r.repo, result.review.findings.map((f) => f.lessonId).filter(Boolean));
    return { ...result, lessons, lessonsApplied: lessons.length };
  });

  handle('review:post', async ({ repo, number, review, headSha, lessons }) => {
    const r = parseRepo(repo);
    const { github } = clients();
    const gh = buildGitHubReview(review, lessons || []);
    return github.createReview(r.owner, r.repo, number, { ...gh, commitId: headSha });
  });

  handle('lesson:propose', async ({ repo, description, number }) => {
    const r = parseRepo(repo);
    const { github, makeClaude } = clients();
    return proposeLesson({ github, claude: makeClaude(), owner: r.owner, repo: r.repo, description, number: number || 0, lessons: store.load(r.owner, r.repo) });
  });

  handle('lessons:list', ({ repo }) => { const r = parseRepo(repo); return store.load(r.owner, r.repo); });
  handle('lessons:add', ({ repo, lesson }) => { const r = parseRepo(repo); return store.add(r.owner, r.repo, lesson); });
  handle('lessons:update', ({ repo, id, changes }) => { const r = parseRepo(repo); return store.update(r.owner, r.repo, id, changes); });
  handle('lessons:remove', ({ repo, id }) => { const r = parseRepo(repo); store.remove(r.owner, r.repo, id); return true; });

  handle('lessons:export', async ({ repo }) => {
    const r = parseRepo(repo);
    const res = await dialog.showSaveDialog(win, { title: 'Export lessons', defaultPath: 'lessons.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (res.canceled || !res.filePath) return { saved: false };
    fs.writeFileSync(res.filePath, toMarkdown(`${r.owner}/${r.repo}`, store.load(r.owner, r.repo)));
    return { saved: true, path: res.filePath };
  });
  handle('lessons:import', async ({ repo }) => {
    const r = parseRepo(repo);
    const res = await dialog.showOpenDialog(win, { title: 'Import lessons', properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (res.canceled || !res.filePaths.length) return { added: 0, cancelled: true };
    const found = fromMarkdown(fs.readFileSync(res.filePaths[0], 'utf8'));
    return { added: store.importLessons(r.owner, r.repo, found), found: found.length };
  });

  handle('open:external', ({ url }) => {
    const u = new URL(url);
    const allowed = ['github.com', 'console.anthropic.com', 'platform.claude.com'];
    if (u.protocol !== 'https:' || !allowed.includes(u.hostname)) throw new Error('That link is not allowed.');
    return shell.openExternal(u.toString());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: 'Hindsight',
    backgroundColor: '#f6f4ef',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // The window only ever shows our own page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  const dir = app.getPath('userData');
  settings = createSettings({ dir, crypto: safeStorage });
  store = createLessonStore(path.join(dir, 'lessons'));
  Menu.setApplicationMenu(null);
  registerHandlers();
  createWindow();
  if (process.env.HINDSIGHT_SMOKE) {
    win.webContents.once('did-finish-load', () => { console.log('HINDSIGHT_SMOKE_OK'); app.quit(); });
  }
});

app.on('window-all-closed', () => app.quit());
