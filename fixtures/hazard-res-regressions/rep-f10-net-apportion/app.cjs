// REP-F10. Three predicted stubs in one file. Their per-symbol `netBytes` are
// the file's net delta APPORTIONED by bodyBytes, so they sum to the file net
// exactly. The old figure re-ran the transform per symbol and recharged the
// fixed emit overhead to each one, so the column could not be added up.
console.log('keep ->', require('tiny').keep());
