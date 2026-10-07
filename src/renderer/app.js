'use strict';
/* Hindsight window. Talks to the main process only through window.hindsight. */

const api = window.hindsight;
const $ = (id) => document.getElementById(id);

const state = {
  view: 'review',
  repo: '',
  settings: null,
  pulls: [],
  pullState: 'open',
  selected: null,   // pull request being viewed
  result: null,     // { pull, review, lessons }
  busy: '',
  posted: null,
  lessons: [],
  proposal: null,
  learn: { description: '', number: '' }
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function call(fn, payload) {
  const res = await fn(payload);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function notify(message, good) {
  const n = $('notice');
  n.textContent = message || '';
  n.hidden = !message;
  n.className = good ? 'notice good' : 'notice';
}

async function guard(label, fn) {
  if (state.busy) return;
  state.busy = label;
  notify('');
  render();
  try {
    await fn();
  } catch (err) {
    notify(err.message);
  } finally {
    state.busy = '';
    render();
  }
}

const needRepo = () => {
  if (!state.repo) throw new Error('Load a repository first.');
};

/* ---------- actions ---------- */

async function loadRepo(repoText) {
  await guard('Loading pull requests', async () => {
    const data = await call(api.listPulls, { repo: repoText, state: state.pullState });
    state.repo = data.repo;
    state.pulls = data.pulls;
    state.selected = null;
    state.result = null;
    state.posted = null;
    $('repo').value = data.repo;
    await refreshLessons();
  });
}

async function refreshLessons() {
  if (!state.repo) return;
  state.lessons = await call(api.listLessons, { repo: state.repo });
}

function selectPull(pull) {
  state.selected = pull;
  state.result = null;
  state.posted = null;
  notify('');
  render();
}

async function review() {
  await guard('Reviewing with Claude', async () => {
    needRepo();
    state.result = await call(api.runReview, { repo: state.repo, number: state.selected.number });
    state.posted = null;
    await refreshLessons();
  });
}

async function post() {
  const r = state.result;
  const inline = r.review.findings.filter((f) => f.inline).length;
  const ok = window.confirm(`Post this review to pull request #${r.pull.number} on GitHub?\n\nIt will appear as a comment from your account, with ${inline} line comment${inline === 1 ? '' : 's'}. Everyone with access to the repository can see it.`);
  if (!ok) return;
  await guard('Posting to GitHub', async () => {
    state.posted = await call(api.postReview, { repo: state.repo, number: r.pull.number, review: r.review, headSha: r.pull.headSha, lessons: r.lessons });
    notify('Review posted to GitHub.', true);
  });
}

async function propose() {
  await guard('Analysing with Claude', async () => {
    needRepo();
    const number = Number(state.learn.number) || 0;
    state.proposal = await call(api.proposeLesson, { repo: state.repo, description: state.learn.description, number });
  });
}

async function saveProposal() {
  await guard('Saving', async () => {
    const p = state.proposal;
    await call(api.addLesson, { repo: state.repo, lesson: { title: p.title, rule: p.rule, rationale: p.rationale, category: p.category, source: p.source } });
    state.proposal = null;
    state.learn = { description: '', number: '' };
    await refreshLessons();
    state.view = 'lessons';
    notify('Lesson saved. It will be applied to every review of this repository.', true);
  });
}

/* ---------- views ---------- */

function viewReview() {
  if (!state.repo) {
    return h('div', {}, h('h1', {}, 'Review a pull request'),
      h('p', { class: 'lead' }, 'Enter a GitHub repository above and choose Load. Hindsight reads the pull request, checks it against the lessons you have saved for that repository, and shows what it finds before anything is posted.'));
  }
  const list = h('div', { class: 'panel' },
    h('header', {}, 'Pull requests',
      h('span', { class: 'tabs' },
        ...['open', 'closed'].map((s) => h('button', { class: state.pullState === s ? 'on' : '', onclick: () => { state.pullState = s; loadRepo(state.repo); } }, s === 'open' ? 'Open' : 'Closed')))),
    state.pulls.length
      ? h('ul', { class: 'pulls' }, state.pulls.map((p) => h('li', {},
          h('button', { class: state.selected && state.selected.number === p.number ? 'on' : '', onclick: () => selectPull(p) },
            h('div', { class: 't' }, `#${p.number} ${p.title}`),
            h('div', { class: 'm' }, `${p.author} · ${p.draft ? 'draft' : p.state}`)))))
      : h('div', { class: 'empty' }, `No ${state.pullState} pull requests.`));

  return h('div', { class: 'split' }, list, reviewPane());
}

function reviewPane() {
  const p = state.selected;
  if (!p) return h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'Choose a pull request to review.'));
  const active = state.lessons.filter((l) => l.active !== false).length;
  const head = h('div', {},
    h('h1', {}, `#${p.number} ${p.title}`),
    h('p', { class: 'lead' }, `by ${p.author} · ${p.state} · `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.openExternal({ url: p.url }); } }, 'Open on GitHub')));

  if (state.busy === 'Reviewing with Claude') {
    return h('div', {}, head, h('p', {}, h('span', { class: 'spin' }), 'Claude is reading the changes. Large pull requests can take a minute.'));
  }
  if (!state.result) {
    return h('div', {}, head,
      h('p', { class: 'summary' }, `${active} saved lesson${active === 1 ? '' : 's'} will be applied, plus any in the repository's .hindsight/lessons.md.`),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: review, disabled: !!state.busy }, 'Review with Claude')));
  }

  const { review: r, lessons } = state.result;
  const label = { looks_good: 'Looks good', needs_attention: 'Needs attention', needs_changes: 'Needs changes' }[r.verdict];
  const facts = [`${r.filesReviewed} file${r.filesReviewed === 1 ? '' : 's'} reviewed`, `${lessons.length} lesson${lessons.length === 1 ? '' : 's'} applied`];
  if (r.skipped.length) facts.push(`${r.skipped.length} not reviewed (${r.skipped.map((s) => s.filename).slice(0, 3).join(', ')}${r.skipped.length > 3 ? ', …' : ''})`);

  return h('div', {}, head,
    h('span', { class: `verdict ${r.verdict}` }, label),
    h('p', { class: 'summary' }, r.summary),
    h('p', { class: 'facts' }, facts.join(' · ')),
    r.findings.length ? r.findings.map((f) => finding(f, lessons)) : h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'No problems found.')),
    h('div', { class: 'actions' },
      state.posted
        ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.openExternal({ url: state.posted.url }); } }, 'View the posted review on GitHub')
        : h('button', { class: 'btn', onclick: post, disabled: !!state.busy }, state.busy === 'Posting to GitHub' ? 'Posting…' : 'Post review to GitHub'),
      h('button', { class: 'btn ghost', onclick: review, disabled: !!state.busy }, 'Review again'),
      h('span', { class: 'muted' }, 'Nothing is posted until you choose to.')));
}

function finding(f, lessons) {
  const lesson = f.lessonId ? lessons.find((l) => l.id === f.lessonId) : null;
  return h('article', { class: `finding ${f.severity}` },
    h('div', { class: 'top' }, h('span', { class: `sev ${f.severity}` }, f.severity), h('h3', {}, f.title)),
    f.file ? h('div', { class: 'loc' }, f.line ? `${f.file}:${f.line}` : f.file) : null,
    h('p', {}, f.detail),
    f.suggestion ? h('p', { class: 'fix' }, h('b', {}, 'Suggested fix: '), f.suggestion) : null,
    lesson ? h('span', { class: 'tag' }, `Lesson ${lesson.id}: ${lesson.title}`) : null);
}

function viewLearn() {
  const head = [h('h1', {}, 'Teach a lesson'),
    h('p', { class: 'lead' }, 'When a bug slips through, tell Hindsight what happened. Claude works out the root cause and writes a rule that is checked on every later review of this repository.')];
  if (!state.repo) return h('div', {}, head, h('p', { class: 'muted' }, 'Load a repository first.'));

  const form = h('div', {},
    h('div', { class: 'field' },
      h('label', { for: 'desc' }, 'What went wrong?'),
      h('textarea', { id: 'desc', placeholder: 'For example: the nightly export sent duplicate invoices because the retry had no idempotency key.', value: state.learn.description, oninput: (e) => { state.learn.description = e.target.value; } })),
    h('div', { class: 'field' },
      h('label', { for: 'num' }, 'Pull request that caused or fixed it (optional)'),
      h('input', { id: 'num', inputmode: 'numeric', placeholder: 'Number, for example 142', value: state.learn.number, oninput: (e) => { state.learn.number = e.target.value.replace(/\D/g, ''); e.target.value = state.learn.number; } }),
      h('span', { class: 'hint' }, 'Its changes are sent to Claude as evidence.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: propose, disabled: !!state.busy }, state.busy === 'Analysing with Claude' ? 'Analysing…' : 'Analyse with Claude')));

  if (!state.proposal) return h('div', {}, head, form);

  const p = state.proposal;
  const edit = (key) => (e) => { p[key] = e.target.value; };
  return h('div', {}, head, form, h('hr', {}),
    h('h1', { }, 'Proposed lesson'),
    h('div', { class: 'analysis' },
      h('b', {}, 'Immediate cause'), h('p', {}, p.immediateCause),
      h('b', {}, 'Root cause'), h('p', {}, p.rootCause)),
    h('div', { class: 'field' }, h('label', { for: 'lt' }, 'Title'), h('input', { id: 'lt', value: p.title, oninput: edit('title') })),
    h('div', { class: 'field' }, h('label', { for: 'lr' }, 'Rule'), h('textarea', { id: 'lr', value: p.rule, oninput: edit('rule') }),
      h('span', { class: 'hint' }, 'Edit until it says exactly what a reviewer should check.')),
    h('div', { class: 'field' }, h('label', { for: 'lw' }, 'Why'), h('textarea', { id: 'lw', value: p.rationale, oninput: edit('rationale') })),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: saveProposal, disabled: !!state.busy }, 'Save lesson'),
      h('button', { class: 'btn ghost', onclick: () => { state.proposal = null; render(); } }, 'Discard')));
}

function viewLessons() {
  const head = [h('h1', {}, 'Lessons'),
    h('p', { class: 'lead' }, 'Rules Hindsight has learned for this repository. To share them with your team, export the file and commit it to the repository as .hindsight/lessons.md.')];
  if (!state.repo) return h('div', {}, head, h('p', { class: 'muted' }, 'Load a repository first.'));

  const tools = h('span', { class: 'row' },
    h('button', { class: 'btn ghost small', onclick: () => guard('Importing', async () => {
      const r = await call(api.importLessons, { repo: state.repo });
      if (r.cancelled) return;
      await refreshLessons();
      notify(`Imported ${r.added} new lesson${r.added === 1 ? '' : 's'} (${r.found} in the file).`, true);
    }) }, 'Import'),
    h('button', { class: 'btn ghost small', disabled: !state.lessons.length, onclick: () => guard('Exporting', async () => {
      const r = await call(api.exportLessons, { repo: state.repo });
      if (r.saved) notify(`Saved to ${r.path}`, true);
    }) }, 'Export'));

  const body = state.lessons.length
    ? state.lessons.map((l) => h('div', { class: l.active === false ? 'lesson off' : 'lesson' },
        h('div', { class: 'top' },
          h('h3', {}, h('span', { class: 'id' }, l.id), l.title),
          h('span', { class: 'row' },
            h('button', { class: 'btn ghost small', onclick: () => guard('Saving', async () => { await call(api.updateLesson, { repo: state.repo, id: l.id, changes: { active: l.active === false } }); await refreshLessons(); }) }, l.active === false ? 'Turn on' : 'Turn off'),
            h('button', { class: 'btn danger small', onclick: () => { if (window.confirm(`Delete lesson ${l.id}? This cannot be undone.`)) guard('Deleting', async () => { await call(api.removeLesson, { repo: state.repo, id: l.id }); await refreshLessons(); }); } }, 'Delete'))),
        h('p', {}, l.rule),
        l.rationale ? h('p', { class: 'muted' }, l.rationale) : null,
        h('div', { class: 'meta' }, [l.category, l.source, l.createdAt ? `added ${l.createdAt}` : '', `caught ${l.timesTriggered || 0} time${l.timesTriggered === 1 ? '' : 's'}`].filter(Boolean).join(' · '))))
    : h('div', { class: 'empty' }, 'No lessons yet. Use “Teach a lesson” after a bug slips through.');

  return h('div', {}, head, h('div', { class: 'panel' }, h('header', {}, state.repo, tools), body));
}

function viewSettings() {
  const s = state.settings || { models: [] };
  const link = (text, url) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.openExternal({ url }); } }, text);
  const fields = {};
  const save = () => guard('Saving', async () => {
    await call(api.saveSettings, { model: fields.model.value, anthropicKey: fields.key.value, githubToken: fields.token.value });
    state.settings = await call(api.getSettings);
    notify('Settings saved.', true);
  });
  return h('div', {},
    h('h1', {}, 'Settings'),
    h('p', { class: 'lead' }, 'Both keys are encrypted on this computer and are sent only to Anthropic and GitHub. Hindsight has no server of its own.'),
    h('div', { class: 'field' },
      h('label', { for: 'key' }, 'Anthropic API key'),
      fields.key = h('input', { id: 'key', type: 'password', autocomplete: 'off', placeholder: s.hasAnthropicKey ? 'Saved. Enter a new key to replace it.' : 'sk-ant-…' }),
      h('span', { class: 'hint' }, 'Reviews are billed to this key. ', link('Get a key', 'https://console.anthropic.com/settings/keys'))),
    h('div', { class: 'field' },
      h('label', { for: 'token' }, 'GitHub access token'),
      fields.token = h('input', { id: 'token', type: 'password', autocomplete: 'off', placeholder: s.hasGithubToken ? 'Saved. Enter a new token to replace it.' : 'github_pat_…' }),
      h('span', { class: 'hint' }, 'A fine-grained token with Pull requests: read and write, and Contents: read. ', link('Create a token', 'https://github.com/settings/personal-access-tokens/new'))),
    h('div', { class: 'field' },
      h('label', { for: 'model' }, 'Claude model'),
      fields.model = h('select', { id: 'model' }, s.models.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.label)))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: save, disabled: !!state.busy }, 'Save settings')));
}

function render() {
  for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('on', b.dataset.view === state.view);
  $('lessonCount').textContent = state.lessons.length ? String(state.lessons.length) : '';
  $('repoStatus').textContent = state.busy === 'Loading pull requests' ? 'Loading…' : '';
  const views = { review: viewReview, learn: viewLearn, lessons: viewLessons, settings: viewSettings };
  $('view').replaceChildren(views[state.view]());
}

/* ---------- start ---------- */

$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  state.view = b.dataset.view;
  notify('');
  render();
});
$('repoBar').addEventListener('submit', (e) => {
  e.preventDefault();
  loadRepo($('repo').value);
});

(async function start() {
  try {
    state.settings = await call(api.getSettings);
    $('repo').value = state.settings.lastRepo || '';
    if (!state.settings.hasAnthropicKey || !state.settings.hasGithubToken) {
      state.view = 'settings';
      notify('Welcome. Add your two keys to get started.', true);
    }
  } catch (err) {
    notify(err.message);
  }
  render();
})();
