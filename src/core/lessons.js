'use strict';
// Lessons are the prevention rules Hindsight builds up for a repository.
// They live in a JSON file per repo and can be shared as .hindsight/lessons.md.

const fs = require('node:fs');
const path = require('node:path');

const CATEGORIES = ['correctness', 'security', 'concurrency', 'data', 'error-handling', 'performance', 'testing', 'api', 'configuration', 'other'];
const REPO_FILE = '.hindsight/lessons.md';

function clean(text, max) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normaliseLesson(raw) {
  const title = clean(raw.title, 120);
  const rule = clean(raw.rule, 600);
  if (!title || !rule) throw new Error('A lesson needs a title and a rule.');
  const category = CATEGORIES.includes(raw.category) ? raw.category : 'other';
  return {
    title,
    rule,
    category,
    rationale: clean(raw.rationale, 800),
    source: clean(raw.source, 120)
  };
}

function nextId(lessons) {
  const max = lessons.reduce((m, l) => {
    const n = /^L-(\d+)$/.exec(l.id || '');
    return n ? Math.max(m, Number(n[1])) : m;
  }, 0);
  return `L-${String(max + 1).padStart(3, '0')}`;
}

const sameLesson = (a, b) => a.title.toLowerCase() === b.title.toLowerCase() && a.rule.toLowerCase() === b.rule.toLowerCase();

function createLessonStore(dir) {
  const fileFor = (owner, repo) => path.join(dir, `${owner}__${repo}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '_') + '.json');

  function load(owner, repo) {
    try {
      const data = JSON.parse(fs.readFileSync(fileFor(owner, repo), 'utf8'));
      return Array.isArray(data.lessons) ? data.lessons : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new Error(`Could not read the saved lessons for ${owner}/${repo}: ${err.message}`);
    }
  }

  function save(owner, repo, lessons) {
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(owner, repo);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ repo: `${owner}/${repo}`, lessons }, null, 2));
    fs.renameSync(tmp, file);
    return lessons;
  }

  return {
    load,
    add(owner, repo, raw, now = new Date()) {
      const lessons = load(owner, repo);
      const lesson = normaliseLesson(raw);
      if (lessons.some((l) => sameLesson(l, lesson))) throw new Error('That lesson is already saved.');
      const full = { id: nextId(lessons), ...lesson, active: true, timesTriggered: 0, createdAt: now.toISOString().slice(0, 10) };
      save(owner, repo, [...lessons, full]);
      return full;
    },
    update(owner, repo, id, changes) {
      const lessons = load(owner, repo);
      const i = lessons.findIndex((l) => l.id === id);
      if (i < 0) throw new Error('That lesson no longer exists.');
      const merged = { ...lessons[i] };
      if (typeof changes.active === 'boolean') merged.active = changes.active;
      if (changes.title != null || changes.rule != null) {
        Object.assign(merged, normaliseLesson({ ...merged, ...changes }));
      }
      lessons[i] = merged;
      save(owner, repo, lessons);
      return merged;
    },
    remove(owner, repo, id) {
      save(owner, repo, load(owner, repo).filter((l) => l.id !== id));
    },
    recordTriggers(owner, repo, ids) {
      const set = new Set(ids);
      if (!set.size) return;
      save(owner, repo, load(owner, repo).map((l) => (set.has(l.id) ? { ...l, timesTriggered: (l.timesTriggered || 0) + 1 } : l)));
    },
    importLessons(owner, repo, incoming, now = new Date()) {
      const lessons = load(owner, repo);
      let added = 0;
      for (const raw of incoming) {
        const lesson = normaliseLesson(raw);
        if (lessons.some((l) => sameLesson(l, lesson))) continue;
        lessons.push({ id: nextId(lessons), ...lesson, active: true, timesTriggered: 0, createdAt: now.toISOString().slice(0, 10) });
        added++;
      }
      save(owner, repo, lessons);
      return added;
    }
  };
}

function toMarkdown(repoName, lessons) {
  const lines = [
    `# Hindsight lessons for ${repoName}`,
    '',
    'Rules learned from past mistakes. Hindsight applies them to every pull request review.',
    'Commit this file as `.hindsight/lessons.md` to share the lessons with your team.',
    ''
  ];
  for (const l of lessons) {
    lines.push(`## ${l.id}: ${l.title}`, '', `- Category: ${l.category}`);
    if (l.createdAt) lines.push(`- Added: ${l.createdAt}`);
    if (l.source) lines.push(`- Source: ${l.source}`);
    lines.push('', `**Rule:** ${l.rule}`);
    if (l.rationale) lines.push('', `**Why:** ${l.rationale}`);
    lines.push('');
  }
  return lines.join('\n');
}

function fromMarkdown(text) {
  const out = [];
  const sections = String(text || '').split(/^## +/m).slice(1);
  for (const section of sections) {
    const [heading, ...rest] = section.split('\n');
    const body = rest.join('\n');
    const title = heading.replace(/^L-\d+:\s*/, '').trim();
    const grab = (re) => {
      const m = re.exec(body);
      return m ? m[1].trim() : '';
    };
    const rule = grab(/\*\*Rule:\*\*\s*([^\n]+)/);
    if (!title || !rule) continue;
    out.push({
      title,
      rule,
      rationale: grab(/\*\*Why:\*\*\s*([^\n]+)/),
      category: grab(/^- Category:\s*([^\n]+)/m),
      source: grab(/^- Source:\s*([^\n]+)/m)
    });
  }
  return out;
}

// Local lessons plus any the team has committed to the repo, without duplicates.
function mergeForReview(local, shared) {
  const merged = local.filter((l) => l.active !== false);
  let n = 0;
  for (const raw of shared) {
    let lesson;
    try { lesson = normaliseLesson(raw); } catch { continue; }
    if (local.some((l) => sameLesson(l, lesson))) continue;
    merged.push({ id: `R-${String(++n).padStart(3, '0')}`, ...lesson, active: true, shared: true });
  }
  return merged;
}

module.exports = { createLessonStore, normaliseLesson, toMarkdown, fromMarkdown, mergeForReview, CATEGORIES, REPO_FILE };
