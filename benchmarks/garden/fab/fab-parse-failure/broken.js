// GARDEN FIXTURE: this file is intentionally NOT JavaScript.
// It exists so the analyzer's parse gate fires (unsupported-syntax).
// It is referenced only behind GARDEN_ENABLE_BROKEN, which is never set,
// so stock node never compiles it at runtime.
%%% definitely not a token stream %%%
:: parse failure payload :: unbalanced } ) ( { braces everywhere
<<<<<<< these are not the droids the lexer is looking for
1 2 3 } ) ( { ~~ @@@@ ## not-an-identifier not-a-string not-a-number
segment-one :: segment-two :: segment-three :: segment-four :: segment-five
the quick brown fox refuses to parse over the lazy analyzer %% end payload %%
