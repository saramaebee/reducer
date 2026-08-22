import { stubFunctions } from './__probe-transformer-8c4b104';
const origSource = `export function secret() { return "REMOVED_BODY_SENTINEL"; }
export function keep() { return 1; }
`;
const map = { version: 3, sources: ['orig.js'], names: [], mappings: '', sourcesContent: [origSource] };
const b64 = Buffer.from(JSON.stringify(map)).toString('base64');
const code = origSource + `//# sourceMappingURL=data:application/json;base64,${b64}\n`;
const res = stubFunctions(code, 'orig.js', [{ symbol: 'secret', localName: 'secret' }]);
const emitted = `${res.code}\n//# sourceMappingURL=orig.js.map\n`;
console.log(emitted);
console.log('data: comment present:', emitted.includes('sourceMappingURL=data:'));
const m = emitted.match(/sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/);
if (m) {
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  console.log('decoded contains removed body:', decoded.includes('REMOVED_BODY_SENTINEL'));
}
