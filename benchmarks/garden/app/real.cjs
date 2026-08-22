/**
 * Real-package wiring (CJS on purpose: these packages are consumed from CJS in
 * the calibration corpus, and CJS gives the lexical `require` that
 * optional-require's API needs).
 *
 * Every route exercises the package's hazard/boundary on a live path with
 * fixed inputs — bodies must be byte-identical across replays.
 */
'use strict';

const path = require('node:path');

const validator = require('validator');
const _ = require('lodash');
const depd = require('depd');
const optionalRequire = require('optional-require')(require);
const requireAt = require('require-at');
const Database = require('better-sqlite3');
const initSqlJs = require('sql.js');

// depd: direct eval with non-constant source builds the deprecation wrapper.
const deprecate = depd('reducer-garden');
const deprecatedGreet = deprecate.function(function greet(who) {
  return `deprecated-greet:${String(who).toUpperCase()}`;
}, 'greet');

let sqlJsPromise = null;

function registerRealRoutes(app, wrap) {
  app.get('/real/validator/isEmail', wrap(() => ({
    valid: validator.isEmail('gardener@example.com'),
    invalid: validator.isEmail('not-an-email'),
  })));

  app.get('/real/validator/isURL', wrap(() => ({
    valid: validator.isURL('https://example.com/garden'),
    invalid: validator.isURL('::not a url::'),
  })));

  app.get('/real/lodash', wrap(() => {
    const merged = _.merge({ a: { b: 1 } }, { a: { c: 2 } });
    return { merged, picked: _.get(merged, 'a.c'), chunked: _.chunk(['g', 'a', 'r', 'd'], 2) };
  }));

  app.get('/real/depd', wrap(() => ({ value: deprecatedGreet('garden') })));

  app.get('/real/optional-require', wrap(() => ({
    present: optionalRequire('lodash') === _,
    absent: optionalRequire('garden-package-that-does-not-exist') === undefined,
  })));

  app.get('/real/require-at', wrap(() => {
    const lodashHere = requireAt(__dirname)('lodash');
    return { sameInstance: lodashHere === _, version: lodashHere.VERSION };
  }));

  app.get('/real/better-sqlite3', wrap(() => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE plots (id INTEGER PRIMARY KEY, crop TEXT)');
    const insert = db.prepare('INSERT INTO plots (crop) VALUES (?)');
    for (const crop of ['nightshade', 'mandrake', 'wolfsbane']) insert.run(crop);
    const rows = db.prepare('SELECT id, crop FROM plots ORDER BY id').all();
    db.close();
    return { rows };
  }));

  app.get('/real/sqljs', wrap(async () => {
    if (!sqlJsPromise) sqlJsPromise = initSqlJs();
    const SQL = await sqlJsPromise;
    const db = new SQL.Database();
    db.run('CREATE TABLE spells (name TEXT, power INTEGER)');
    db.run("INSERT INTO spells VALUES ('bloom', 6), ('wither', 7)");
    const res = db.exec('SELECT name, power FROM spells ORDER BY power');
    db.close();
    return { result: res };
  }));

  // express/lib/view.js is the dynamic-require hazard; res.render walks it.
  app.get('/real/express-view', (req, res, next) => {
    res.render('garden', { name: 'garden' }, (err, html) => {
      if (err) return next(err);
      res.type('text/plain').send(html);
    });
  });
}

module.exports = { registerRealRoutes };
