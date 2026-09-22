# JSONPath engine

TypeScript library for JSON query and update.

Run `npm install`, then `npm test` and `npm run build`.

## Recursive descent semantics

`$..name` (and `..` with any selector) is evaluated with a deterministic
**depth-first pre-order** traversal:

- Arrays are enumerated by index, ascending.
- Objects are enumerated by their own enumerable string keys in the
  engine's own property order (integer-style keys ascending, then
  insertion order).
- Symbol-keyed and non-enumerable properties are never visited.
- Sparse array holes are skipped.

**Cycles vs. sharing.** There is no global `visited` set: a shared but
acyclic object is emitted once per path that reaches it. Cycle detection
uses only the current ancestor chain — an edge pointing back to an
ancestor is still emitted if it matches, but never re-entered, so cyclic
input terminates deterministically.

**Results.** `queryPaths` returns `{ value, path }` where `path` is a
canonical path: `$` root, `$[0]` array elements, `$.name` identifier-like
members, `$['a.b']` / `$['0']` for everything else (integer-style object
keys are quoted to stay distinguishable from array indices).

**Traversal & cancellation.** Traversal is iterative (no call-stack
overflow on deep input) and accepts an `AbortSignal`; an aborted query
throws an `AbortError`.

```ts
import { query, queryPaths } from 'jsonpath-recursive-order-core';

queryPaths(store, '$..name');
// [ { value: 'root', path: '$.name' }, { value: 'a', path: '$.items[0].name' }, … ]
```
