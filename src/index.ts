// JSONPath engine — deterministic recursive descent.
//
// Recursive descent (`..`) is evaluated depth-first, pre-order:
//   arrays  -> ascending canonical index order (sparse holes skipped)
//   objects -> own enumerable STRING keys, in ECMAScript enumeration order
// Symbol-keyed / non-enumerable properties are never selected nor descended;
// expando (non-index) properties on arrays are not JSON data and are ignored.
//
// Cycle detection uses the *ancestor chain only*: an edge leading back to an
// object already on the path from root to the current node is not re-entered.
// A shared but acyclic object is visited once per occurrence — there is no
// global visited set, so results never depend on reference identity beyond
// true ancestor cycles.

export type Token =
  | { kind: 'root' }
  | { kind: 'field'; value: string }
  | { kind: 'index'; value: number }
  | { kind: 'wildcard' }
  | { kind: 'recursiveField'; value: string }
  | { kind: 'recursiveIndex'; value: number }
  | { kind: 'recursiveWildcard' };

export interface QueryResult {
  value: unknown;
  /** Canonical JSONPath, e.g. `$['a'][2]['b']`. */
  path: string;
  /** Structured segments: numbers are array indices, strings object keys. */
  keys: (string | number)[];
}

export interface QueryOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSONPath expression.
 *
 *   $                root
 *   .foo  ['foo']    child field (bracket form may be quoted)
 *   [0]              array index (non-negative canonical integer)
 *   *    [*]         all children of the current nodes
 *   ..foo  ..['foo'] every node's `foo` field (recursive descent)
 *   ..[0]            every node's index 0
 *   ..*   ..[*]      every descendant
 *
 * Segments may be chained after a recursive segment, e.g. `$..addr.city`.
 */
export function parse(path: string): Token[] {
  if (!path.startsWith('$')) throw new Error('path must start with $');

  const out: Token[] = [{ kind: 'root' }];
  let i = 1;

  while (i < path.length) {
    let recursive = false;

    if (path[i] === '.') {
      if (path[i + 1] === '.') {
        recursive = true;
        i += 2;
      } else {
        i += 1;
      }
    } else if (path[i] !== '[') {
      throw new Error(`unexpected character at ${i}: '${path[i]}'`);
    }

    if (path[i] === '[') {
      const end = findBracketEnd(path, i + 1);
      out.push(bracketToken(path.slice(i + 1, end), recursive));
      i = end + 1;
      continue;
    }

    if (path[i] !== '.') {
      // Dot-form child name runs until the next '.' or '['.
      const start = i;
      while (i < path.length && path[i] !== '.' && path[i] !== '[') i++;
      const name = path.slice(start, i);
      if (name === '') throw new Error('empty field name');
      if (name === '*') {
        out.push(recursive ? { kind: 'recursiveWildcard' } : { kind: 'wildcard' });
      } else {
        out.push(recursive ? { kind: 'recursiveField', value: name } : { kind: 'field', value: name });
      }
    } else {
      // `..` immediately followed by another dot — invalid.
      throw new Error('empty field name');
    }
  }

  return out;
}

function findBracketEnd(path: string, from: number): number {
  let i = from;
  let quote = '';
  while (i < path.length) {
    const ch = path[i];
    if (quote) {
      if (ch === '\\') i += 2;
      else if (ch === quote) quote = '';
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
    } else if (ch === ']') {
      return i;
    } else {
      i++;
    }
  }
  throw new Error('unterminated bracket');
}

function bracketToken(inner: string, recursive: boolean): Token {
  if (inner === '*') {
    return recursive ? { kind: 'recursiveWildcard' } : { kind: 'wildcard' };
  }

  let body = inner;
  let quoted = false;
  const first = inner[0];
  if (first === "'" || first === '"') {
    if (inner.length < 2 || inner[inner.length - 1] !== first) {
      throw new Error('unterminated string in bracket');
    }
    body = unquote(inner.slice(1, -1));
    quoted = true;
  }

  if (!quoted && /^(0|[1-9][0-9]*)$/.test(body)) {
    const n = Number(body);
    if (!Number.isSafeInteger(n)) throw new Error(`index out of range: ${body}`);
    return recursive ? { kind: 'recursiveIndex', value: n } : { kind: 'index', value: n };
  }

  if (!quoted && !/^[A-Za-z_$][\w$]*$/.test(body)) {
    throw new Error(`invalid bracket selector: [${inner}]`);
  }

  return recursive ? { kind: 'recursiveField', value: body } : { kind: 'field', value: body };
}

function unquote(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

function isObjectLike(v: unknown): v is Record<string | symbol, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Canonical array index per the ECMAScript spec: `'0'`, or a string of digits
 * without leading zeros whose value is a safe integer. `'01'`, `'-0'`,
 * `'1.0'` do NOT qualify — they are plain object field names.
 */
export function canonicalIndex(key: string): number | null {
  if (key === '0') return 0;
  if (!/^[1-9][0-9]*$/.test(key)) return null;
  const n = Number(key);
  return Number.isSafeInteger(n) ? n : null;
}

interface Child {
  /** Canonical segment: number for array indices, string for fields. */
  seg: string | number;
  value: unknown;
}

/**
 * Enumerate children in canonical traversal order:
 * array elements by ascending index, object keys in own-enumerable order.
 * Sparse holes, symbol keys, non-enumerable keys and array expando properties
 * are skipped.
 */
function childrenOf(node: unknown): Child[] {
  if (Array.isArray(node)) {
    const out: Child[] = [];
    for (let i = 0; i < node.length; i++) {
      if (!Object.hasOwn(node, i)) continue; // sparse hole
      out.push({ seg: i, value: node[i] });
    }
    return out;
  }

  if (isObjectLike(node)) {
    const out: Child[] = [];
    // Object.keys -> own enumerable string keys, ES enumeration order
    // (canonical integer-like keys ascending, then insertion order).
    for (const key of Object.keys(node)) {
      out.push({ seg: key, value: node[key] });
    }
    return out;
  }

  return [];
}

function ownEnumerableField(node: object, name: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(node, name) &&
    Object.prototype.propertyIsEnumerable.call(node, name)
  );
}

function abortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted', 'AbortError');
  }
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? abortError();
}

// ---------------------------------------------------------------------------
// Recursive descent
// ---------------------------------------------------------------------------

type Selector =
  | { type: 'field'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' };

interface DescendEntry {
  value: unknown;
  keys: (string | number)[];
}

/**
 * Depth-first pre-order recursive descent, implemented with an explicit DFS
 * stack and a single mutable path (safe for very deep structures; memory stays
 * proportional to depth).
 *
 * - field/index selector: for every visited node (root included) that has the
 *   matching own enumerable child, emit that child *before* descending. A
 *   match pointing back at an ancestor is still emitted (it is a result), it
 *   is simply never descended into.
 * - wildcard: emit every visited node except the descent root; an edge that
 *   leads back to an ancestor emits nothing and is not descended.
 */
function* descend(root: unknown, selector: Selector, signal?: AbortSignal): Generator<DescendEntry> {
  interface Step {
    value: unknown;
    kids: Child[];
    index: number;
    entered: boolean;
  }

  const stack: Step[] = [{ value: root, kids: childrenOf(root), index: 0, entered: false }];
  // Current path of segments, pushed/popped with DFS enter/exit.
  const path: (string | number)[] = [];
  // Values on the current root-to-node path only — never a global visited set.
  // A value can occur at most once on the chain (a second encounter is a
  // cycle and is not entered), so a Set is exact.
  const ancestors = new Set<unknown>();
  if (isObjectLike(root)) ancestors.add(root);

  const namedChild = (node: unknown): Child | null => {
    if (selector.type === 'field') {
      const name = selector.name;
      if (Array.isArray(node)) {
        const idx = canonicalIndex(name);
        if (idx === null || idx >= node.length || !Object.hasOwn(node, idx)) return null;
        return { seg: idx, value: node[idx] };
      }
      if (isObjectLike(node) && ownEnumerableField(node, name)) {
        return { seg: name, value: node[name] };
      }
      return null;
    }

    if (selector.type !== 'index') return null;
    if (!Array.isArray(node)) return null;
    const n = selector.index;
    if (n >= node.length || !Object.hasOwn(node, n)) return null;
    return { seg: n, value: node[n] };
  };

  while (stack.length > 0) {
    checkSignal(signal);
    const step = stack[stack.length - 1];

    if (!step.entered) {
      step.entered = true;
      if (selector.type === 'wildcard') {
        if (path.length > 0) {
          yield { value: step.value, keys: path.slice() };
        }
      } else {
        const hit = namedChild(step.value);
        if (hit) {
          yield { value: hit.value, keys: [...path, hit.seg] };
        }
      }
    }

    if (step.index < step.kids.length) {
      const child = step.kids[step.index++];
      // Skip re-entry only for a true ancestor cycle. Shared acyclic objects
      // are traversed afresh from every occurrence.
      if (isObjectLike(child.value) && ancestors.has(child.value)) continue;

      path.push(child.seg);
      if (isObjectLike(child.value)) ancestors.add(child.value);
      stack.push({ value: child.value, kids: childrenOf(child.value), index: 0, entered: false });
    } else {
      stack.pop();
      if (isObjectLike(step.value)) ancestors.delete(step.value);
      path.pop();
    }
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export function renderPath(keys: (string | number)[]): string {
  let out = '$';
  for (const seg of keys) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else {
      out += `['${seg.replace(/[\\']/g, '\\$&')}']`;
    }
  }
  return out;
}

function immediateChildren(entry: { value: unknown; keys: (string | number)[] }, token: Token): QueryResult[] {
  const push = (seg: string | number, value: unknown): QueryResult => {
    const keys = [...entry.keys, seg];
    return { value, keys, path: renderPath(keys) };
  };

  const node = entry.value;

  if (token.kind === 'wildcard') {
    return childrenOf(node).map((c) => push(c.seg, c.value));
  }

  if (token.kind === 'index') {
    const n = token.value;
    if (!Array.isArray(node) || n >= node.length || !Object.hasOwn(node, n)) return [];
    return [push(n, node[n])];
  }

  if (token.kind === 'field') {
    const name = token.value;
    if (Array.isArray(node)) {
      const idx = canonicalIndex(name);
      if (idx === null || idx >= node.length || !Object.hasOwn(node, idx)) return [];
      return [push(idx, node[idx])];
    }
    if (isObjectLike(node) && ownEnumerableField(node, name)) {
      return [push(name, node[name])];
    }
    return [];
  }

  return [];
}

type PipeEntry = { value: unknown; keys: (string | number)[] };

function* applyImmediate(source: Iterable<PipeEntry>, token: Token, signal?: AbortSignal): Generator<PipeEntry> {
  for (const entry of source) {
    checkSignal(signal);
    yield* immediateChildren(entry, token);
  }
}

function* applyRecursive(source: Iterable<PipeEntry>, selector: Selector, signal?: AbortSignal): Generator<PipeEntry> {
  for (const entry of source) {
    checkSignal(signal);
    for (const hit of descend(entry.value, selector, signal)) {
      yield { value: hit.value, keys: [...entry.keys, ...hit.keys] };
    }
  }
}

/**
 * Streaming query. Consume with a `for...of` loop; breaking out of it is a
 * cooperative cancellation. Pass `options.signal` to abort an in-progress
 * (possibly cyclic or very deep) traversal; each token stage is a lazy
 * generator, so no result list is materialized beyond what is consumed.
 */
export function* queryIter(value: unknown, tokens: Token[], options: QueryOptions = {}): Generator<QueryResult> {
  checkSignal(options.signal);

  let stream: Iterable<PipeEntry> = [{ value, keys: [] }];

  for (const token of tokens) {
    if (token.kind === 'root') continue;

    if (token.kind === 'recursiveWildcard' || token.kind === 'recursiveField' || token.kind === 'recursiveIndex') {
      const selector: Selector =
        token.kind === 'recursiveWildcard'
          ? { type: 'wildcard' }
          : token.kind === 'recursiveField'
            ? { type: 'field', name: token.value }
            : { type: 'index', index: token.value };
      stream = applyRecursive(stream, selector, options.signal);
    } else {
      stream = applyImmediate(stream, token, options.signal);
    }
  }

  for (const entry of stream) {
    checkSignal(options.signal);
    yield { value: entry.value, keys: entry.keys, path: renderPath(entry.keys) };
  }
}

/** Eager query; throws the abort reason when `options.signal` is/gets aborted. */
export function query(value: unknown, tokens: Token[], options?: QueryOptions): QueryResult[] {
  return Array.from(queryIter(value, tokens, options));
}
