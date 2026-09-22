/**
 * JSONPath core — recursive descent (`..`) with a deterministic
 * depth-first pre-order result order.
 *
 * Ordering contract
 * -----------------
 * - Arrays are enumerated by index (ascending).
 * - Plain objects are enumerated by their own enumerable string keys,
 *   following the engine's own property enumeration order
 *   (integer-style keys ascending, then insertion order).
 * - Symbol-keyed and non-enumerable properties are never visited.
 * - Sparse array holes are skipped (they are not own properties).
 *
 * Cycle policy
 * ------------
 * There is intentionally NO global visited set: a shared (but acyclic)
 * object reached through several paths is emitted once per path.
 * Cycle detection uses only the current ancestor chain.  When an edge
 * points back to an ancestor container, the edge itself is still emitted
 * if it matches, but it is never descended into — so traversal of cyclic
 * graphs terminates and stays deterministic.
 *
 * Traversal is iterative (explicit stack), so deeply nested input does
 * not overflow the call stack.  An AbortSignal may be passed to cancel.
 *
 * Every result carries a canonical path:
 *   root                         $
 *   array element                $[0]
 *   identifier-like member       $.name
 *   any other member (incl. "0") $['a.b'], $['0'], $['']
 */

export type TokenKind = 'root' | 'field' | 'index' | 'wildcard' | 'descend';

export interface Token {
  kind: TokenKind;
  value?: string | number;
}

export interface Match {
  readonly value: unknown;
  readonly path: string;
}

export interface QueryOptions {
  /** Checked throughout traversal; an aborted query throws an AbortError. */
  signal?: AbortSignal;
}

const IDENT_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/;
const DIGITS_RE = /^[0-9]+$/;
// Integer-style keys per the ECMAScript own-property enumeration rules.
const INDEX_KEY_RE = /^(?:0|[1-9][0-9]*)$/;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parses a subset of JSONPath:
 *   $                root
 *   .name            member (dot notation)
 *   ['name'] [".."]  member (bracket notation, backslash escapes the quote)
 *   [0]              index / integer-style key
 *   .*  [*]  ..*     wildcard
 *   ..name  ..[0] …  recursive descent followed by one selector
 */
export function parse(path: string): Token[] {
  if (typeof path !== 'string' || path.length === 0 || path[0] !== '$') {
    throw new Error(`Invalid JSONPath (must start with '$'): ${String(path)}`);
  }

  const tokens: Token[] = [{ kind: 'root' }];
  let p = 1;

  while (p < path.length) {
    let descend = false;
    if (path.startsWith('..', p)) {
      descend = true;
      p += 2;
    } else if (path[p] === '.') {
      p += 1;
    } else if (path[p] !== '[') {
      throw new Error(`Invalid JSONPath at offset ${p}: ${path}`);
    }

    if (descend) tokens.push({ kind: 'descend' });

    const ch = path[p];
    if (ch === undefined) {
      throw new Error(`Dangling '.' in JSONPath: ${path}`);
    }

    if (ch === '[') {
      p = parseBracket(path, p, tokens);
    } else if (
      ch === '*' &&
      (p + 1 === path.length || path[p + 1] === '.' || path[p + 1] === '[')
    ) {
      // A lone '*' is the wildcard; '*name*' etc. is a literal member name.
      tokens.push({ kind: 'wildcard' });
      p += 1;
    } else {
      const start = p;
      while (p < path.length && path[p] !== '.' && path[p] !== '[') p += 1;
      const name = path.slice(start, p);
      if (name.length === 0) {
        throw new Error(`Expected a member name in JSONPath: ${path}`);
      }
      tokens.push({ kind: 'field', value: name });
    }
  }

  if (tokens[tokens.length - 1]?.kind === 'descend') {
    throw new Error(`Recursive descent '..' must be followed by a selector: ${path}`);
  }
  return tokens;
}

function parseBracket(path: string, p: number, tokens: Token[]): number {
  // At the opening '['.
  p += 1;
  const ch = path[p];

  if (ch === '*') {
    if (path[p + 1] !== ']') throw new Error(`Expected ']' in JSONPath: ${path}`);
    tokens.push({ kind: 'wildcard' });
    return p + 2;
  }

  if (ch === "'" || ch === '"') {
    let value: string;
    [value, p] = readQuoted(path, p);
    if (path[p] !== ']') throw new Error(`Expected ']' in JSONPath: ${path}`);
    tokens.push({ kind: 'field', value });
    return p + 1;
  }

  const start = p;
  while (p < path.length && path[p] >= '0' && path[p] <= '9') p += 1;
  const digits = path.slice(start, p);
  if (!DIGITS_RE.test(digits) || path[p] !== ']') {
    throw new Error(`Bracket selector must be *, a quoted name or an integer: ${path}`);
  }
  if (digits.length > 1 && digits[0] === '0') {
    throw new Error(`Index must not have leading zeroes: ${path}`);
  }
  tokens.push({ kind: 'index', value: Number(digits) });
  return p + 1;
}

function readQuoted(path: string, p: number): [string, number] {
  const quote = path[p];
  p += 1;
  let out = '';
  for (;;) {
    if (p >= path.length) {
      throw new Error(`Unterminated string in JSONPath: ${path}`);
    }
    const ch = path[p];
    if (ch === quote) return [out, p + 1];
    if (ch === '\\') {
      const next = path[p + 1];
      if (next === undefined) throw new Error(`Bad escape in JSONPath: ${path}`);
      out += next;
      p += 2;
    } else {
      out += ch;
      p += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Canonical paths
// ---------------------------------------------------------------------------

function quoteMember(key: string): string {
  const escaped = key.replace(/[\\'\n\r\t]/g, (c) => {
    switch (c) {
      case '\\': return '\\\\';
      case "'": return "\\'";
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      default: return c;
    }
  });
  return `['${escaped}']`;
}

function appendPath(parentPath: string, key: string, parentIsArray: boolean): string {
  if (parentIsArray && INDEX_KEY_RE.test(key)) return `${parentPath}[${key}]`;
  if (IDENT_RE.test(key)) return `${parentPath}.${key}`;
  return parentPath + quoteMember(key);
}

// ---------------------------------------------------------------------------
// Compilation: tokens -> segments (a descent flag plus one selector each)
// ---------------------------------------------------------------------------

type Selector =
  | { kind: 'wildcard' }
  | { kind: 'field'; name: string }
  | { kind: 'index'; key: string };

interface Segment {
  descend: boolean;
  selector: Selector;
}

function compile(tokens: Token[]): Segment[] {
  if (tokens.length === 0 || tokens[0].kind !== 'root') {
    throw new Error('Compilation requires a parsed token list starting with root');
  }
  const segments: Segment[] = [];
  for (let i = 1; i < tokens.length; i++) {
    let descend = false;
    if (tokens[i].kind === 'descend') {
      descend = true;
      i += 1;
      if (i >= tokens.length) {
        throw new Error("Recursive descent '..' must be followed by a selector");
      }
    }
    const token = tokens[i];
    let selector: Selector;
    switch (token.kind) {
      case 'wildcard':
        selector = { kind: 'wildcard' };
        break;
      case 'field':
        selector = { kind: 'field', name: String(token.value) };
        break;
      case 'index':
        selector = { kind: 'index', key: String(token.value) };
        break;
      default:
        throw new Error(`Expected a selector after ${descend ? "'..'" : "'.'"}`);
    }
    segments.push({ descend, selector });
  }
  return segments;
}

function selectorMatches(selector: Selector, key: string): boolean {
  switch (selector.kind) {
    case 'wildcard':
      return true;
    case 'field':
      return key === selector.name;
    case 'index':
      // The key space is unified: [0] matches array element 0 and a member
      // whose own key is the integer-style string "0".
      return key === selector.key;
  }
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

const isContainer = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** Link in the ancestor chain; only container values are recorded. */
interface Link {
  v: object;
  tail: Link | null;
}

interface TraversalNode {
  value: unknown;
  path: string;
  /** Container-ancestor chain, nearest first; includes value when container. */
  tail: Link | null;
}

interface Frame {
  v: Record<string, unknown>;
  path: string;
  keys: string[];
  pos: number;
  link: Link | null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function extendTail(tail: Link | null, child: unknown): Link | null {
  return isContainer(child) ? { v: child, tail } : tail;
}

/** One non-descent segment: direct children only. */
function step(
  node: TraversalNode,
  selector: Selector,
  out: TraversalNode[],
  signal?: AbortSignal,
): void {
  const container = node.value;
  if (!isContainer(container)) return;
  const isArray = Array.isArray(container);
  const keys = Object.keys(container);
  for (let i = 0; i < keys.length; i++) {
    throwIfAborted(signal);
    const key = keys[i];
    if (!selectorMatches(selector, key)) continue;
    const value = container[key];
    out.push({
      value,
      path: appendPath(node.path, key, isArray),
      tail: extendTail(node.tail, value),
    });
  }
}

/**
 * One recursive-descent segment: depth-first pre-order over descendant
 * edges.  Iterative so deep input cannot overflow the call stack.
 */
function descend(
  node: TraversalNode,
  selector: Selector,
  out: TraversalNode[],
  signal?: AbortSignal,
): void {
  const root = node.value;
  if (!isContainer(root)) return;

  // The active set contains exactly the current ancestor chain — never a
  // global visited set, so shared acyclic objects are emitted per path.
  const active = new Set<object>();
  for (let l: Link | null = node.tail; l !== null; l = l.tail) active.add(l.v);

  const stack: Frame[] = [{
    v: root,
    path: node.path,
    keys: Object.keys(root),
    pos: 0,
    link: node.tail, // node.tail already has root as its head when root is a container
  }];

  while (stack.length > 0) {
    throwIfAborted(signal);
    const frame = stack[stack.length - 1];

    if (frame.pos >= frame.keys.length) {
      active.delete(frame.v);
      stack.pop();
      continue;
    }

    const key = frame.keys[frame.pos++];
    const value = frame.v[key];
    const path = appendPath(frame.path, key, Array.isArray(frame.v));

    // Pre-order: emit the edge before descending into it.
    if (selectorMatches(selector, key)) {
      out.push({ value, path, tail: extendTail(frame.link, value) });
    }

    if (isContainer(value)) {
      if (active.has(value)) {
        // Real back-edge to an ancestor: emit above if it matched, but do
        // not re-enter, guaranteeing termination on cyclic input.
        continue;
      }
      active.add(value);
      stack.push({
        v: value,
        path,
        keys: Object.keys(value),
        pos: 0,
        link: { v: value, tail: frame.link },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function queryPaths(
  root: unknown,
  pathOrTokens: string | Token[],
  options: QueryOptions = {},
): Match[] {
  throwIfAborted(options.signal);
  const tokens = typeof pathOrTokens === 'string' ? parse(pathOrTokens) : pathOrTokens;
  const segments = compile(tokens);

  let nodes: TraversalNode[] = [{
    value: root,
    path: '$',
    tail: isContainer(root) ? { v: root, tail: null } : null,
  }];

  for (const segment of segments) {
    const next: TraversalNode[] = [];
    for (const node of nodes) {
      if (segment.descend) {
        descend(node, segment.selector, next, options.signal);
      } else {
        step(node, segment.selector, next, options.signal);
      }
    }
    nodes = next;
  }

  return nodes.map((n) => ({ value: n.value, path: n.path }));
}

/** Convenience wrapper returning only the matched values, in canonical order. */
export function query(
  root: unknown,
  pathOrTokens: string | Token[],
  options: QueryOptions = {},
): unknown[] {
  return queryPaths(root, pathOrTokens, options).map((m) => m.value);
}
