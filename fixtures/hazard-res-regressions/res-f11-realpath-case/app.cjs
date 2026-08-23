// RES-F11. On a case-insensitive filesystem `./foo.js` and `./Foo.js` are ONE
// physical file. `fs.realpathSync` does not canonicalize case; `realpathSync.native`
// does, so identity is the same under node and under bun. Either the edge
// resolves onto the single existing record, or (case-sensitive FS) it does not
// resolve and widens — never a second phantom record, never a double-counted D.
console.log('big ->', require('pkg').big());
