import { describe, expect, it, vi } from 'vitest';
import {
  canonicalIndex,
  parse,
  query,
  queryIter,
  renderPath,
  type QueryResult,
} from '../src/index.js';

const paths = (results: QueryResult[]) => results.map((r) => r.path);
const values = (results: QueryResult[]) => results.map((r) => r.value);

// ---------------------------------------------------------------------------
// Reference implementation: recursive, independent of the engine.
// Validates the DFS pre-order contract on acyclic JSON data.
// ---------------------------------------------------------------------------

function refChild(node: unknown, field: string): { seg: string | number; value: unknown } | null {
  if (Array.isArray(node)) {
    const idx = canonicalIndex(field);
    if (idx === null || idx >= node.length || !Object.hasOwn(node, idx)) return null;
    return { seg: idx, value: node[idx] };
  }
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(rec, field)) return null;
    return { seg: field, value: rec[field] };
  }
  return null;
}

function refKids(node: unknown): { seg: string | number; value: unknown }[] {
  if (Array.isArray(node)) {
    const out: { seg: number; value: unknown }[] = [];
    for (let i = 0; i < node.length; i++) {
      if (Object.hasOwn(node, i)) out.push({ seg: i, value: node[i] });
    }
    return out;
  }
  if (node && typeof node === 'object') {
    return Object.keys(node as object).map((k) => ({ seg: k, value: (node as Record<string, unknown>)[k] }));
  }
  return [];
}

type RefSel = { kind: 'field'; name: string } | { kind: 'index'; index: number } | { kind: 'wildcard' };

function refDescend(
  root: unknown,
  sel: RefSel,
  cb: (v: unknown, keys: (string | number)[]) => void,
): void {
  const walk = (node: unknown, keys: (string | number)[]): void => {
    // Pre-order: select at this node first.
    if (sel.kind === 'wildcard') {
      if (keys.length > 0) cb(node, keys);
    } else if (sel.kind === 'field') {
      const hit = refChild(node, sel.name);
      if (hit) cb(hit.value, [...keys, hit.seg]);
    } else if (Array.isArray(node) && sel.index < node.length && Object.hasOwn(node, sel.index)) {
      cb(node[sel.index], [...keys, sel.index]);
    }
    // Then children, arrays by index, objects by key enumeration order.
    for (const child of refKids(node)) walk(child.value, [...keys, child.seg]);
  };
  walk(root, []);
}

function refQuery(root: unknown, path: string): QueryResult[] {
  const tokens = parse(path);
  let current: { v: unknown; keys: (string | number)[] }[] = [{ v: root, keys: [] }];
  for (const t of tokens) {
    if (t.kind === 'root') continue;
    const next: typeof current = [];
    if (t.kind === 'field' || t.kind === 'index' || t.kind === 'wildcard') {
      for (const e of current) {
        if (t.kind === 'wildcard') {
          for (const c of refKids(e.v)) next.push({ v: c.value, keys: [...e.keys, c.seg] });
        } else if (t.kind === 'index') {
          if (Array.isArray(e.v) && t.value < e.v.length && Object.hasOwn(e.v, t.value)) {
            next.push({ v: e.v[t.value], keys: [...e.keys, t.value] });
          }
        } else {
          const hit = refChild(e.v, t.value);
          if (hit) next.push({ v: hit.value, keys: [...e.keys, hit.seg] });
        }
      }
    } else {
      const sel: RefSel =
        t.kind === 'recursiveWildcard'
          ? { kind: 'wildcard' }
          : t.kind === 'recursiveField'
            ? { kind: 'field', name: t.value }
            : { kind: 'index', index: t.value };
      for (const e of current) {
        refDescend(e.v, sel, (v, keys) => next.push({ v, keys: [...e.keys, ...keys] }));
      }
    }
    current = next;
  }
  return current.map((e) => ({ value: e.v, keys: e.keys, path: renderPath(e.keys) }));
}

// Seeded PRNG + random JSON (including sparse arrays).
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEY_POOL = ['a', 'b', 'name', 'x', 'y', '0', '1', '2', '10', '01', 'z', '12', '-0'];

function randomJson(rand: () => number, depth: number): unknown {
  if (depth <= 0 || rand() < 0.35) {
    const leaf = [1, 'str', true, false, null, 42];
    return leaf[Math.floor(rand() * leaf.length)];
  }
  if (rand() < 0.5) {
    const len = 1 + Math.floor(rand() * 5);
    const arr: unknown[] = [];
    for (let i = 0; i < len; i++) {
      if (rand() < 0.2) continue; // sparse hole
      arr[i] = randomJson(rand, depth - 1);
    }
    return arr;
  }
  const obj: Record<string, unknown> = {};
  const n = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) {
    const k = KEY_POOL[Math.floor(rand() * KEY_POOL.length)];
    obj[k] = randomJson(rand, depth - 1);
  }
  return obj;
}

const PATHS = [
  '$..name',
  '$..*',
  '$..a',
  '$..[0]',
  '$..[*]',
  '$..a.b',
  '$..x[0]',
  '$.store..price',
  '$..name',
  '$.a',
  '$[0]',
  '$.*',
  "$['01']",
  '$..01',
  "$..['name']",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('basic parsing and immediate selection', () => {
  it('root field', () => {
    expect(values(query({ a: 1 }, parse('$.a')))).toEqual([1]);
  });

  it('bracket field forms', () => {
    const data = { 'a-b': 1, name: 2 };
    expect(values(query(data, parse("$['a-b']")))).toEqual([1]);
    expect(values(query(data, parse('$["name"]')))).toEqual([2]);
    expect(values(query(data, parse("$[name]")))).toEqual([2]);
  });

  it('array index and wildcards', () => {
    const data = [{ x: 1 }, { x: 2 }];
    expect(paths(query(data, parse('$[0]')))).toEqual(['$[0]']);
    expect(values(query(data, parse('$[*].x')))).toEqual([1, 2]);
  });

  it('missing values produce no results', () => {
    expect(query({ a: 1 }, parse('$.b'))).toEqual([]);
    expect(query([1], parse('$[5]'))).toEqual([]);
  });

  it('rejects malformed paths', () => {
    expect(() => parse('a')).toThrow();
    expect(() => parse('$[')).toThrow();
    expect(() => parse('$..')).toThrow();
  });
});

describe('recursive descent: DFS pre-order on mixed structures', () => {
  it('$..name visits in depth-first pre-order with canonical paths', () => {
    const data = {
      name: 'root',
      a: { name: 'a', c: { name: 'c' } },
      b: { name: 'b', d: [{ name: 'd0' }, 'x', { name: 'd2' }] },
    };
    const results = query(data, parse('$..name'));
    expect(values(results)).toEqual(['root', 'a', 'c', 'b', 'd0', 'd2']);
    expect(paths(results)).toEqual([
      "$['name']",
      "$['a']['name']",
      "$['a']['c']['name']",
      "$['b']['name']",
      "$['b']['d'][0]['name']",
      "$['b']['d'][2]['name']",
    ]);
  });

  it('$..* emits every descendant pre-order, root excluded', () => {
    const data = { a: { c: 1 }, b: [2, { d: 3 }] };
    expect(paths(query(data, parse('$..*')))).toEqual([
      "$['a']",
      "$['a']['c']",
      "$['b']",
      "$['b'][0]",
      "$['b'][1]",
      "$['b'][1]['d']",
    ]);
  });

  it('arrays traverse by ascending index even inside objects', () => {
    const data = { list: [{ name: 1 }, { name: 2 }, { name: 3 }], z: { name: 4 } };
    expect(values(query(data, parse('$..name')))).toEqual([1, 2, 3, 4]);
  });

  it('$..[0] matches array element zero at every level', () => {
    const data = [{ a: [{ x: 'deep' }] }, { name: 'no' }];
    expect(values(query(data, parse('$..[0]')))).toEqual([{ a: [{ x: 'deep' }] }, { x: 'deep' }]);
  });

  it('segments after a recursive descent keep working', () => {
    const data = { a: { addr: { city: 'A' } }, b: { addr: { city: 'B' } } };
    expect(values(query(data, parse('$..addr.city')))).toEqual(['A', 'B']);
    expect(paths(query(data, parse('$..addr.city')))).toEqual([
      "$['a']['addr']['city']",
      "$['b']['addr']['city']",
    ]);
  });

  it('is deterministic across repeated runs (no queue ordering races)', () => {
    const data = {
      k: [1, { name: 'n1' }, [{ name: 'n2' }]],
      name: 'top',
      other: { name: 'n3', nested: [true, { name: 'n4' }] },
    };
    const first = paths(query(data, parse('$..name')));
    for (let i = 0; i < 20; i++) {
      expect(paths(query(data, parse('$..name')))).toEqual(first);
    }
  });
});

describe('shared acyclic subobjects are visited per occurrence', () => {
  it('DAG: shared object is NOT globally deduplicated', () => {
    const shared = { name: 'shared' };
    const data = { a: shared, b: { c: shared, d: [shared] } };
    const results = query(data, parse('$..name'));
    // Three occurrences of `shared`, each with its own canonical path.
    expect(values(results)).toEqual(['shared', 'shared', 'shared']);
    expect(paths(results)).toEqual([
      "$['a']['name']",
      "$['b']['c']['name']",
      "$['b']['d'][0]['name']",
    ]);
  });

  it('$..* descends into the shared object from every occurrence', () => {
    const shared = { v: 1 };
    const data = { a: shared, b: shared };
    expect(paths(query(data, parse('$..*')))).toEqual([
      "$['a']",
      "$['a']['v']",
      "$['b']",
      "$['b']['v']",
    ]);
  });

  it('shared array with shared contents is enumerated per occurrence', () => {
    const leaf = { name: 'L' };
    const sharedArr = [leaf, leaf];
    const data = { x: sharedArr, y: sharedArr };
    expect(paths(query(data, parse('$..name')))).toEqual([
      "$['x'][0]['name']",
      "$['x'][1]['name']",
      "$['y'][0]['name']",
      "$['y'][1]['name']",
    ]);
  });
});

describe('real ancestor cycles', () => {
  it('self-referential object terminates and still emits the named field', () => {
    const node: Record<string, unknown> = { name: 'cyclic' };
    node.self = node;
    const results = query(node, parse('$..name'));
    expect(values(results)).toEqual(['cyclic']);
    expect(paths(results)).toEqual(["$['name']"]);
  });

  it('mutual cycle is traversed once per ancestor chain position', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b' };
    a.toB = b;
    b.toA = a;
    const results = query(a, parse('$..name'));
    // root a, then b; b.toA points back to an ancestor -> not re-entered.
    expect(values(results)).toEqual(['a', 'b']);
    expect(paths(results)).toEqual(["$['name']", "$['toB']['name']"]);
  });

  it('wildcard descent does not loop on cycles; the ancestor edge emits nothing', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.b = b;
    b.a = a;
    // $..* -> b is emitted; b.a leads back to an ancestor: no result, no descent.
    expect(paths(query(a, parse('$..*')))).toEqual(["$['b']"]);
  });

  it('a cycle through a named edge is emitted as result but not descended', () => {
    const root: Record<string, unknown> = { name: 'root' };
    root.back = root;
    // $..back selects the back-reference at root; its own descendants are not
    // traversed because root is an ancestor.
    const results = query(root, parse('$..back'));
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(root);
    expect(results[0].path).toBe("$['back']");
  });

  it('cycle via array indices', () => {
    const arr: unknown[] = [];
    arr.push(arr);
    arr.push({ name: 'x' });
    // root -> index 0 (ancestor cycle: skipped, not emitted) -> index 1 -> name
    expect(paths(query(arr, parse('$..name')))).toEqual(["$[1]['name']"]);
    expect(paths(query(arr, parse('$..*')))).toEqual(['$[1]', "$[1]['name']"]);
  });

  it('same object reachable a second time non-ancestrally is still visited', () => {
    // sibling -> shared -> shared forms a branch; then root.sibling2 -> shared
    // after the first branch fully unwound (no longer an ancestor).
    const shared: Record<string, unknown> = { name: 's' };
    const s1 = { shared };
    const s2 = { shared };
    const root = { s1, s2 };
    expect(paths(query(root, parse('$..name')))).toEqual([
      "$['s1']['shared']['name']",
      "$['s2']['shared']['name']",
    ]);
  });
});

describe('sparse arrays', () => {
  it('holes are skipped without affecting index numbering', () => {
    const arr: unknown[] = [];
    arr[0] = { name: 'a' };
    arr[2] = { name: 'c' };
    arr[4] = { name: 'e' };
    expect(paths(query(arr, parse('$..name')))).toEqual([
      "$[0]['name']",
      "$[2]['name']",
      "$[4]['name']",
    ]);
  });

  it('$..[i] only matches present indices', () => {
    const arr: unknown[] = [];
    arr[1] = 'one';
    arr[3] = 'three';
    expect(values(query(arr, parse('$..[1]')))).toEqual(['one']);
    expect(values(query(arr, parse('$..[2]')))).toEqual([]);
    expect(values(query(arr, parse('$..[3]')))).toEqual(['three']);
  });

  it('wildcard lists present entries with true indices', () => {
    const arr: unknown[] = [];
    arr[0] = 'a';
    arr[5] = 'f';
    expect(paths(query(arr, parse('$..*')))).toEqual(['$[0]', '$[5]']);
  });
});

describe('integer-style keys', () => {
  it('canonical index classification', () => {
    expect(canonicalIndex('0')).toBe(0);
    expect(canonicalIndex('1')).toBe(1);
    expect(canonicalIndex('42')).toBe(42);
    expect(canonicalIndex('01')).toBeNull();
    expect(canonicalIndex('-0')).toBeNull();
    expect(canonicalIndex('1.0')).toBeNull();
  });

  it('object integer-like keys enumerate ascending before insertion keys', () => {
    // Insertion order deliberately non-numeric; ES enumeration reorders
    // canonical integer-like keys ascending.
    const obj: Record<string, unknown> = {};
    obj.name = 'n';
    obj[10 as unknown as string] = 'ten';
    obj[2 as unknown as string] = 'two';
    obj[1 as unknown as string] = 'one';
    obj.z = 'z';
    expect(paths(query(obj, parse('$..*')))).toEqual([
      "$['1']",
      "$['2']",
      "$['10']",
      "$['name']",
      "$['z']",
    ]);
  });

  it("'01' is a field name, not index 1, on arrays and objects", () => {
    const obj = { '01': 'field01' };
    expect(values(query(obj, parse("$['01']")))).toEqual(['field01']);
    expect(values(query(obj, parse("$..['01']")))).toEqual(['field01']);
    // On an array the canonical-index coercion must not match index 1.
    const arr = ['zero', 'one'];
    expect(values(query(arr, parse('$..[\'01\']')))).toEqual([]);
  });

  it('numeric index token never matches an object field of the same digits', () => {
    expect(values(query({ '2': 'x' }, parse('$[2]')))).toEqual([]);
  });
});

describe('symbol / non-enumerable / non-JSON properties are ignored', () => {
  it('symbol keys are never selected nor descended', () => {
    const sym = Symbol('name');
    const node: Record<symbol, unknown> = { [sym]: { name: 'inside-symbol' } };
    Object.defineProperty(node, Symbol.for('other'), {
      value: 1,
      enumerable: true,
    });
    expect(query(node, parse('$..name'))).toEqual([]);
    expect(paths(query(node, parse('$..*')))).toEqual([]);
  });

  it('non-enumerable string keys are ignored but enumeration still recurses past them', () => {
    const node = { visible: { name: 'ok' } } as Record<string, unknown>;
    Object.defineProperty(node, 'name', { value: 'hidden', enumerable: false });
    // Node's own non-enumerable `name` is invisible; descent still reaches
    // the enumerable name nested under `visible`.
    expect(values(query(node, parse('$..name')))).toEqual(['ok']);
    expect(paths(query(node, parse('$..*')))).toEqual(["$['visible']", "$['visible']['name']"]);
  });

  it('direct field access on a non-enumerable key yields nothing', () => {
    const node = {} as Record<string, unknown>;
    Object.defineProperty(node, 'name', { value: 'hidden', enumerable: false });
    expect(query(node, parse('$.name'))).toEqual([]);
  });

  it('expando string properties on arrays are ignored', () => {
    const arr = [{ name: 'idx0' }] as unknown[] as Record<string, unknown>;
    arr.name = 'expando';
    arr.foo = 'bar';
    expect(values(query(arr, parse('$..name')))).toEqual(['idx0']);
    expect(paths(query(arr, parse('$..*')))).toEqual(['$[0]', "$[0]['name']"]);
  });

  it('inherited properties are ignored', () => {
    const proto = { name: 'inherited' };
    const node = Object.create(proto);
    node.own = { name: 'own' };
    expect(values(query(node, parse('$..name')))).toEqual(['own']);
  });

  it('length is not selected as a field', () => {
    expect(values(query([1, 2, 3], parse('$..length')))).toEqual([]);
  });
});

describe('deep structures', () => {
  it('traverses a 10,000-deep chain without stack overflow and returns full canonical path', () => {
    const depth = 10_000;
    let root: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < depth; i++) root = { child: root };

    const results = query(root, parse('$..leaf'));
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('$' + "['child']".repeat(depth) + "['leaf']");
  });

  it('deep chain $..* yields exactly depth descendants (root primitive excluded) in order', () => {
    const depth = 2000;
    let root: unknown = 0;
    for (let i = 0; i < depth; i++) root = { child: root };

    const gen = queryIter(root, parse('$..*'));
    const first = gen.next().value!;
    expect(first.path).toBe("$['child']");
    let count = 1;
    let last: QueryResult = first;
    for (const r of gen) {
      last = r;
      count++;
    }
    expect(count).toBe(depth);
    expect(last.value).toBe(0);
    expect(last.path).toBe('$' + "['child']".repeat(depth));
  }, 20_000);

  it('abort signal checked before work starts', () => {
    const ac = new AbortController();
    ac.abort(new Error('boom'));
    expect(() => query({ a: 1 }, parse('$..*'), { signal: ac.signal })).toThrow('boom');
  });

  it('abort during cyclic traversal throws AbortError', () => {
    const node: Record<string, unknown> = { name: 'c' };
    node.self = node;
    const ac = new AbortController();
    // Already aborted — cycle handling must still observe the signal rather
    // than spinning.
    ac.abort();
    expect(() => query(node, parse('$..*'), { signal: ac.signal })).toThrow();
  });

  it('external abort mid-iteration stops the generator', () => {
    const depth = 100_000;
    let root: unknown = 'end';
    for (let i = 0; i < depth; i++) root = { n: i, child: root };

    const ac = new AbortController();
    const gen = queryIter(root, parse('$..n'), { signal: ac.signal });
    let count = 0;
    const err = vi.fn();
    try {
      for (const _ of gen) {
        count++;
        if (count === 100) ac.abort();
      }
    } catch (e) {
      err(e);
    }
    expect(err).toHaveBeenCalledOnce();
    expect(count).toBeLessThan(depth);
  });

  it('breaking out of the generator is a cooperative cancel', () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ name: i }));
    const gen = queryIter(big, parse('$..name'));
    let count = 0;
    for (const _ of gen) {
      count++;
      if (count === 3) break;
    }
    expect(count).toBe(3);
  });
});

describe('parity with recursive reference implementation (acyclic JSON)', () => {
  const pathsToCheck = PATHS;

  it('hand-crafted structures match item-by-item incl. canonical paths', () => {
    const cases = [
      {
        store: {
          book: [
            { category: 'r', price: 1, name: 'A' },
            { category: 'f', price: 2, name: 'B' },
          ],
          price: 3,
        },
        top: [{ price: 4 }, { name: 'C' }],
      },
      { a: [{ b: [{ name: 1 }, { name: 2 }] }], name: 3 },
      [{ '0': 'zero-key', '01': 'f', 2: ['x', { name: 'deep' }] }, 'plain', { name: 'obj' }],
      { '10': 1, '2': 2, a: [{ name: 'z' }], '01': 3, name: 'top' },
    ];

    for (const data of cases) {
      for (const p of pathsToCheck) {
        let got: QueryResult[];
        let ref: QueryResult[];
        try {
          got = query(data, parse(p));
          ref = refQuery(data, p);
        } catch (e) {
          throw new Error(`path ${p} threw: ${(e as Error).message}`);
        }
        expect(got, `values for ${p}`).toEqual(ref);
      }
    }
  });

  it('random generated JSON (with sparse arrays, integer-style keys) matches', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = mulberry32(seed);
      const data = randomJson(rand, 6);
      for (const p of pathsToCheck) {
        const got = query(data, parse(p));
        const ref = refQuery(data, p);
        if (JSON.stringify(got) !== JSON.stringify(ref)) {
          throw new Error(
            `mismatch seed=${seed} path=${p}\n got=${JSON.stringify(paths(got))}\n ref=${JSON.stringify(paths(ref))}`,
          );
        }
      }
    }
  });

  it('shared subobjects still match reference results (reference treats each occurrence)', () => {
    const shared = { name: 's', v: [{ name: 'sv' }] };
    const data = { x: shared, y: [shared, { z: shared }] };
    expect(query(data, parse('$..name'))).toEqual(refQuery(data, '$..name'));
    expect(query(data, parse('$..*'))).toEqual(refQuery(data, '$..*'));
  });
});

describe('primitive roots and leaves', () => {
  it('recursive descent over primitives', () => {
    expect(query(42, parse('$..name'))).toEqual([]);
    expect(query(42, parse('$..*'))).toEqual([]);
    expect(values(query('str', parse('$..name')))).toEqual([]);
    expect(query(null, parse('$..*'))).toEqual([]);
  });

  it('immediate selection on primitives yields nothing', () => {
    expect(query(42, parse('$.a'))).toEqual([]);
    expect(query('x', parse('$[0]'))).toEqual([]);
  });
});
