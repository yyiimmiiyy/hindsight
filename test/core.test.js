'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseRepo, createGitHub } = require('../src/core/github');
const { createClaude } = require('../src/core/claude');
const { createLessonStore, toMarkdown, fromMarkdown, mergeForReview } = require('../src/core/lessons');
const { annotatePatch, buildDiff, buildReviewRequest, normaliseReview, buildGitHubReview, runReview, proposeLesson } = require('../src/core/review');
const { createSettings } = require('../src/core/settings');

const PATCH = '@@ -10,4 +10,5 @@ function pay(order) {\n   const total = order.total;\n-  charge(total);\n+  charge(total);\n+  charge(total);\n \n   return total;';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-'));

test('parseRepo accepts owner/name and GitHub URLs, rejects junk', () => {
  assert.deepEqual(parseRepo('octo/hello'), { owner: 'octo', repo: 'hello' });
  assert.deepEqual(parseRepo(' https://github.com/octo/hello.git/ '), { owner: 'octo', repo: 'hello' });
  assert.deepEqual(parseRepo('https://github.com/octo/hello/pull/3'), { owner: 'octo', repo: 'hello' });
  assert.throws(() => parseRepo('hello'));
  assert.throws(() => parseRepo('octo/he llo'));
  assert.throws(() => parseRepo('../x/..'), /owner\/name/);
});

test('annotatePatch numbers new-file lines and marks which can take comments', () => {
  const a = annotatePatch(PATCH);
  assert.deepEqual([...a.commentable].sort((x, y) => x - y), [10, 11, 12, 13, 14]);
  assert.match(a.text, /   11 \| \+  charge\(total\);/);
  assert.match(a.text, /      \| -  charge\(total\);/);
  assert.match(a.text, /   14 \|    return total;/);
});

test('buildDiff skips lock files and binaries and respects the budget', () => {
  const files = [
    { filename: 'src/pay.js', status: 'modified', additions: 2, deletions: 1, patch: PATCH },
    { filename: 'package-lock.json', status: 'modified', additions: 900, deletions: 900, patch: '@@ -1 +1 @@\n-a\n+b' },
    { filename: 'logo.png', status: 'added', additions: 0, deletions: 0, patch: '' }
  ];
  const d = buildDiff(files);
  assert.equal(d.included, 1);
  assert.deepEqual(d.skipped.map((s) => s.filename), ['package-lock.json', 'logo.png']);
  assert.ok(d.commentable.get('src/pay.js').has(12));
  assert.equal(buildDiff(files, 10).included, 0);
});

test('review request carries lessons and warns about untrusted content', () => {
  const d = buildDiff([{ filename: 'src/pay.js', status: 'modified', additions: 2, deletions: 1, patch: PATCH }]);
  const req = buildReviewRequest({ repoName: 'o/r', pull: { number: 7, title: 'Pay', author: 'a', body: '' }, diff: d, lessons: [{ id: 'L-001', category: 'data', title: 'No double charge', rule: 'Charge once.', rationale: '' }] });
  assert.match(req.system, /\[L-001\] \(data\) No double charge/);
  assert.match(req.system, /untrusted data/);
  assert.match(req.user, /Pull request #7: Pay/);
  assert.equal(req.tool.name, 'submit_review');
});

test('normaliseReview validates findings and sorts by severity', () => {
  const d = buildDiff([{ filename: 'src/pay.js', status: 'modified', additions: 2, deletions: 1, patch: PATCH }]);
  const r = normaliseReview({
    summary: ' ok ', verdict: 'bogus',
    findings: [
      { file: 'src/pay.js', line: 99, severity: 'nit', title: 'far', detail: 'd', lesson_id: 'L-404' },
      { file: 'src/pay.js', line: 12, severity: 'critical', title: 'double charge', detail: 'd', lesson_id: 'L-001' },
      { file: 'x', line: 1, severity: 'weird', title: '', detail: 'dropped' }
    ]
  }, d, [{ id: 'L-001' }]);
  assert.equal(r.verdict, 'needs_attention');
  assert.equal(r.findings.length, 2);
  assert.deepEqual(r.findings.map((f) => [f.title, f.inline, f.lessonId]), [['double charge', true, 'L-001'], ['far', false, '']]);
});

test('buildGitHubReview puts only valid lines inline', () => {
  const review = { summary: 'S', findings: [
    { file: 'a.js', line: 3, severity: 'major', title: 'T1', detail: 'D1', suggestion: 'Fix', lessonId: 'L-001', inline: true },
    { file: 'b.js', line: 0, severity: 'minor', title: 'T2', detail: 'D2', suggestion: '', lessonId: '', inline: false }
  ] };
  const gh = buildGitHubReview(review, [{ id: 'L-001', title: 'Lesson' }]);
  assert.deepEqual(gh.comments.map((c) => [c.path, c.line, c.side]), [['a.js', 3, 'RIGHT']]);
  assert.match(gh.comments[0].body, /Lesson L-001: Lesson/);
  assert.match(gh.body, /Other findings/);
  assert.match(gh.body, /`b\.js`/);
});

test('lesson store adds, ids, dedupes, toggles, counts and removes', () => {
  const store = createLessonStore(tmp());
  const a = store.add('O', 'R', { title: 'One', rule: 'Do one', category: 'data' });
  const b = store.add('O', 'R', { title: 'Two', rule: 'Do two', category: 'nope' });
  assert.equal(a.id, 'L-001');
  assert.equal(b.id, 'L-002');
  assert.equal(b.category, 'other');
  assert.throws(() => store.add('O', 'R', { title: 'one', rule: 'do ONE' }), /already saved/);
  assert.throws(() => store.add('O', 'R', { title: '', rule: 'x' }));
  store.update('O', 'R', 'L-001', { active: false });
  store.recordTriggers('O', 'R', ['L-002', 'L-002', 'L-999']);
  let all = store.load('o', 'r'); // repo names are case-insensitive on GitHub
  assert.equal(all[0].active, false);
  assert.equal(all[1].timesTriggered, 1);
  store.remove('O', 'R', 'L-001');
  all = store.load('O', 'R');
  assert.deepEqual(all.map((l) => l.id), ['L-002']);
  assert.equal(store.add('O', 'R', { title: 'Three', rule: 'Do three' }).id, 'L-003');
  assert.deepEqual(store.load('Other', 'Repo'), []);
});

test('lessons survive a round trip through markdown', () => {
  const store = createLessonStore(tmp());
  store.add('o', 'r', { title: 'Idempotent retries', rule: 'Retries of writes must carry an idempotency key.', rationale: 'Duplicate invoices.', category: 'data', source: 'PR #12' });
  store.add('o', 'r', { title: 'No rationale', rule: 'Rule two.' });
  const md = toMarkdown('o/r', store.load('o', 'r'));
  const back = fromMarkdown(md);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], { title: 'Idempotent retries', rule: 'Retries of writes must carry an idempotency key.', rationale: 'Duplicate invoices.', category: 'data', source: 'PR #12' });
  const other = createLessonStore(tmp());
  assert.equal(other.importLessons('o', 'r', back), 2);
  assert.equal(other.importLessons('o', 'r', back), 0);
  assert.deepEqual(fromMarkdown('# nothing here'), []);
});

test('mergeForReview drops inactive lessons and adds shared ones once', () => {
  const local = [{ id: 'L-001', title: 'A', rule: 'a', active: true }, { id: 'L-002', title: 'B', rule: 'b', active: false }];
  const merged = mergeForReview(local, [{ title: 'a', rule: 'A' }, { title: 'C', rule: 'c' }, { title: 'B', rule: 'b' }, { title: '', rule: '' }]);
  assert.deepEqual(merged.map((l) => l.id), ['L-001', 'R-001']);
  assert.equal(merged[1].shared, true);
});

function fakeGitHub() {
  const calls = [];
  const routes = {
    '/repos/o/r/pulls/7': { number: 7, title: 'Pay twice', body: 'b', user: { login: 'dev' }, state: 'open', html_url: 'https://github.com/o/r/pull/7', base: { ref: 'main' }, head: { sha: 'abc' } },
    '/repos/o/r/pulls/7/files?per_page=100&page=1': [{ filename: 'src/pay.js', status: 'modified', additions: 2, deletions: 1, patch: PATCH }]
  };
  const fetchImpl = async (url, init) => {
    const p = url.replace('https://api.github.com', '');
    calls.push({ p, init });
    if (init.method === 'POST') return { ok: true, json: async () => ({ html_url: 'https://github.com/o/r/pull/7#review', id: 5 }) };
    if (p in routes) return { ok: true, json: async () => routes[p], text: async () => '' };
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  };
  return { github: createGitHub({ token: 't', fetchImpl }), calls };
}

function fakeClaude(input) {
  const seen = [];
  const client = { messages: { create: async (req) => { seen.push(req); return { content: [{ type: 'tool_use', name: req.tools[0].name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }; } } };
  return { claude: createClaude({ client, model: 'm' }), seen };
}

test('runReview goes from GitHub through Claude to a postable review', async () => {
  const { github, calls } = fakeGitHub();
  const { claude, seen } = fakeClaude({ summary: 'Charges twice.', verdict: 'needs_changes', findings: [{ file: 'src/pay.js', line: 12, severity: 'critical', title: 'Double charge', detail: 'charge() runs twice.', lesson_id: 'L-001' }] });
  const lessons = [{ id: 'L-001', category: 'data', title: 'No double charge', rule: 'Charge once.' }];
  const { pull, review } = await runReview({ github, claude, owner: 'o', repo: 'r', number: 7, lessons });
  assert.equal(pull.headSha, 'abc');
  assert.equal(review.verdict, 'needs_changes');
  assert.equal(review.findings[0].inline, true);
  assert.deepEqual(seen[0].tool_choice, { type: 'tool', name: 'submit_review' });
  assert.equal(seen[0].model, 'm');

  const posted = await github.createReview('o', 'r', 7, { ...buildGitHubReview(review, lessons), commitId: pull.headSha });
  assert.equal(posted.id, 5);
  const sent = JSON.parse(calls.at(-1).init.body);
  assert.equal(sent.event, 'COMMENT'); // never approves or blocks on the user's behalf
  assert.equal(sent.commit_id, 'abc');
  assert.equal(sent.comments[0].line, 12);
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer t');
});

test('runReview skips Claude when nothing is reviewable', async () => {
  const github = { getPull: async () => ({ number: 1, title: 't', body: '', author: 'a' }), listPullFiles: async () => [{ filename: 'a.png', patch: '' }] };
  const claude = { callTool: async () => { throw new Error('should not be called'); } };
  const { review } = await runReview({ github, claude, owner: 'o', repo: 'r', number: 1, lessons: [] });
  assert.equal(review.findings.length, 0);
  assert.equal(review.skipped.length, 1);
});

test('proposeLesson needs input and returns an editable lesson', async () => {
  const { github } = fakeGitHub();
  const { claude, seen } = fakeClaude({ immediate_cause: 'ic', root_cause: 'rc', title: 'T', category: 'made-up', rule: 'R', rationale: 'W' });
  await assert.rejects(proposeLesson({ github, claude, owner: 'o', repo: 'r', description: '  ', number: 0, lessons: [] }), /Describe what went wrong/);
  const p = await proposeLesson({ github, claude, owner: 'o', repo: 'r', description: 'dup charge', number: 7, lessons: [] });
  assert.deepEqual([p.title, p.category, p.source, p.rootCause], ['T', 'other', 'PR #7', 'rc']);
  assert.match(seen[0].messages[0].content, /DIFF OF THAT PULL REQUEST/);
});

test('GitHub and Claude failures become readable messages', async () => {
  const gh = createGitHub({ token: 'bad', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) }) });
  await assert.rejects(gh.getPull('o', 'r', 1), /rejected the access token/);
  const gh404 = createGitHub({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(await gh404.getFileText('o', 'r', '.hindsight/lessons.md', 'main'), null);
  const client = { messages: { create: async () => { const e = new Error('nope'); e.status = 401; throw e; } } };
  await assert.rejects(createClaude({ client }).callTool({ system: '', user: '', tool: { name: 'x' } }), /rejected the API key/);
  assert.throws(() => createClaude({}), /Anthropic API key/);
  const cut = { messages: { create: async (r) => ({ content: [{ type: 'tool_use', name: r.tools[0].name, input: {} }], stop_reason: 'max_tokens' }) } };
  await assert.rejects(createClaude({ client: cut }).callTool({ system: '', user: '', tool: { name: 'x' } }), /cut off/);
});

test('settings encrypt secrets and never expose them in the public view', () => {
  const dir = tmp();
  const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`), decryptString: (b) => b.toString().replace(/^enc:/, '') };
  const s = createSettings({ dir, crypto });
  assert.deepEqual(s.publicView(), { model: 'claude-sonnet-5-5', hasAnthropicKey: false, hasGithubToken: false, lastRepo: '' });
  s.save({ anthropicKey: ' sk-secret ', githubToken: 'ghp', model: 'claude-opus-5-5' });
  s.save({ anthropicKey: '', lastRepo: 'o/r' }); // empty leaves the saved key alone
  assert.deepEqual(s.publicView(), { model: 'claude-opus-5-5', hasAnthropicKey: true, hasGithubToken: true, lastRepo: 'o/r' });
  assert.equal(s.secrets().anthropicKey, 'sk-secret');
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('sk-secret'));
  s.save({ githubToken: null });
  assert.equal(s.publicView().hasGithubToken, false);
  const locked = createSettings({ dir: tmp(), crypto: { ...crypto, isEncryptionAvailable: () => false } });
  assert.throws(() => locked.save({ anthropicKey: 'k' }), /cannot store secrets/);
});
