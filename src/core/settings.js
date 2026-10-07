'use strict';
// Settings on disk. Secrets are encrypted with the operating system's
// credential protection (DPAPI on Windows) and never leave the main process.

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_MODEL } = require('./claude');

function createSettings({ dir, crypto }) {
  const file = path.join(dir, 'settings.json');

  function read() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  }
  function write(data) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
  function seal(value) {
    if (!crypto.isEncryptionAvailable()) throw new Error('This computer cannot store secrets securely, so the key was not saved.');
    return crypto.encryptString(value).toString('base64');
  }
  function open(sealed) {
    if (!sealed) return '';
    try { return crypto.decryptString(Buffer.from(sealed, 'base64')); } catch { return ''; }
  }

  return {
    publicView() {
      const s = read();
      return { model: s.model || DEFAULT_MODEL, hasAnthropicKey: !!open(s.anthropicKey), hasGithubToken: !!open(s.githubToken), lastRepo: s.lastRepo || '' };
    },
    secrets() {
      const s = read();
      return { model: s.model || DEFAULT_MODEL, anthropicKey: open(s.anthropicKey), githubToken: open(s.githubToken) };
    },
    save({ model, anthropicKey, githubToken, lastRepo }) {
      const s = read();
      if (typeof model === 'string' && model.trim()) s.model = model.trim();
      if (typeof lastRepo === 'string') s.lastRepo = lastRepo;
      // An empty string means "leave as is"; null means "remove".
      if (anthropicKey === null) delete s.anthropicKey;
      else if (typeof anthropicKey === 'string' && anthropicKey.trim()) s.anthropicKey = seal(anthropicKey.trim());
      if (githubToken === null) delete s.githubToken;
      else if (typeof githubToken === 'string' && githubToken.trim()) s.githubToken = seal(githubToken.trim());
      write(s);
    }
  };
}

module.exports = { createSettings };
