# Absolute soundness invariant: proven-unreachable only

The reducer will only ever remove code it has *proven* unreachable; proven
reachable, possibly reachable, and unknown all mean KEEP, and any uncertainty
introduced by new analysis must widen retention, never narrow it. We chose this
over an optimistic or tiered mode (which would reduce more) because the entire
product identity versus a bundler is "we never break your app" — a single
silent semantic regression would destroy the guarantee that makes the tool
worth using. An opt-in optimistic tier may exist someday behind a loud flag,
but it will never be the default and is out of scope until the sound path is
proven to have a ceiling worth escaping.
