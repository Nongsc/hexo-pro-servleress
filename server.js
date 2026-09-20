'use strict';

// --- Minimal .env loader (avoids a dotenv dependency) ---------------------
(function loadDotEnv() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) return;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  });
})();

const { createApp } = require('./lib/app');

const port = process.env.PORT || 8001;

createApp().then(app => {
  app.listen(port, () => {
    console.log(`[Hexo Pro]: admin server listening on http://localhost:${port}/pro`);
  });
}).catch(err => {
  console.error('[Hexo Pro]: fatal startup error:', err);
  process.exit(1);
});
