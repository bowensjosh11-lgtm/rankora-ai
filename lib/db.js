const { DatabaseSync } = require('node:sqlite');
const path = require('path');
function openDb(file = process.env.RANKORA_DB || path.join(__dirname, '..', 'data.sqlite')) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, status TEXT NOT NULL, score INTEGER, error TEXT, result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`);
  return {
    create: url => Number(db.prepare('INSERT INTO scans(url,status) VALUES(?,?)').run(url, 'running').lastInsertRowid),
    finish: (id, r) => db.prepare('UPDATE scans SET status=?,score=?,result=? WHERE id=?').run('done', r.score.total, JSON.stringify(r), id),
    fail: (id, e) => db.prepare('UPDATE scans SET status=?,error=? WHERE id=?').run('failed', e, id),
    get: id => { const r = db.prepare('SELECT * FROM scans WHERE id=?').get(id); return r && { ...r, result: r.result ? JSON.parse(r.result) : null }; },
    list: () => db.prepare('SELECT id,url,status,score,error,created_at FROM scans ORDER BY id DESC LIMIT 100').all(),
    remove: id => db.prepare('DELETE FROM scans WHERE id=?').run(id),
    settings: () => { const s = { maxPages: 10, delayMs: 300, timeout: 8000 }; for (const r of db.prepare('SELECT * FROM settings').all()) s[r.key] = Number(r.value); return s; },
    setSetting: (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)),
    failStale: () => db.prepare("UPDATE scans SET status='failed',error='Interrupted by restart' WHERE status='running'").run()
  };
}
module.exports = { openDb };
