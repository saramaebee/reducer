import { handlers } from 'objlib';
import * as k from 'keylib';

// Runtime-only key: the analyzer cannot know which keylib export runs.
function pickKey(n) {
  return n % 2 === 0 ? 'first' : 'second';
}

export function handle(text) {
  return handlers.run(text);
}

export function dispatch(n) {
  return k[pickKey(n)](n);
}
