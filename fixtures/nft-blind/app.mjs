// Every load in blind-loader is invisible to @vercel/nft by construction:
// computed specifiers for require and dynamic import, plus a computed-fs-path
// asset. The soundness invariant under test: NFT omission must never cause
// those files to be absent from the artifact.
import loader from 'blind-loader';

const a = loader.loadHidden();
const b = await loader.loadEsm();
const c = loader.loadAsset();
console.log(['nft-blind', a, b, c].join('|'));
