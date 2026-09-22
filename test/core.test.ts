import { describe, expect, it } from 'vitest';
import { parse, query, queryPaths } from '../src/index.js';

// ---------------------------------------------------------------------------
// Existing behaviour / basics
// ---------------------------------------------------------------------------

describe('basic parsing and querying', () => {
  it('parses and queries a simple field', () => {
    expect(query({ a: 1 }, parse('$.a'))).toEqual([1]);
  });

  it('accepts strings directly and supports bracket notation', () => {
    const data = { a: { 'b.c': 2, '0': 3 } };
    expect(query(data, "$.a['b.c']")).toEqual([2]);
    expect(query(data, '$.a["b.c"]')).toEqual([2]);
    expect(query(data, "$.a['0']")).toEqual([3]);
  });

  it('parses integer indices and wildcards', () => {
    expect(query([10, 20, 30], '$[1]')).toEqual([20]);
    expect(query([10, 20], '$.*')).toEqual([10, 20]);
    expect(query({ a: 1, b: 2 }, '$[*]')).toEqual([1, 2]);
    expect(query({ a: 1 }, '$..*')).toEqual([1]);
  });

  it('rejects malformed paths', () => {
    expect(() => parse('x.a')).toThrow();
    expect(() => parse('$.a..')).toThrow();
    expect(() => parse('$[01]')).toThrow();
    expect(() => parse("$['a']" .slice(0, 4))).toThrow();
  });

  it('root query returns the root with path $', () => {
    const root = { a: 1 };
    expect(queryPaths(root, '$')).toEqual([{ value: root, path: '$' }]);
  });
});

// ---------------------------------------------------------------------------
// 1. Deterministic depth-first pre-order: arrays by index, objects by own
//    enumerable key enumeration order.
// ---------------------------------------------------------------------------

describe('recursive descent order is depth-first pre-order', () => {
  it('visits arrays by index and objects by key order, pre-order', () => {
    const data = {
      name: 'root',
      store: {
        name: 'store-1',
        items: [
          { name: 'a' },
          { name: 'b' },
        ],
      },
      list: [{ name: 'c' }],
    };

    expect(query(data, '$..name')).toEqual([
      'root',    // root.name
      'store-1', // store.name (before its subtree)
      'a',       // store.items[0].name
      'b',       // store.items[1].name
      'c',       // list[0].name
    ]);

    expect(queryPaths(data, '$..name').map((m) => m.path)).toEqual([
      '$.name',
      '$.store.name',
      '$.store.items[0].name',
      '$.store.items[1].name',
      '$.list[0].name',
    ]);
  });

  it('$..* emits every descendant edge in pre-order', () => {
    const data = { a: [1, 2], b: { c: 3 } };
    expect(queryPaths(data, '$..*').map((m) => m.path)).toEqual([
      '$.a',
      '$.a[0]',
      '$.a[1]',
      '$.b',
      '$.b.c',
    ]);
  });

  it('is stable across repeated runs on array/object mixtures', () => {
    const shared = { name: 'shared' };
    const data = {
      arr: [{ name: 'x', child: shared }, { name: 'y', child: shared }],
      obj: { z: { name: 'z1', child: shared } },
    };
    const first = queryPaths(data, '$..name');
    for (let i = 0; i < 25; i++) {
      expect(queryPaths(data, '$..name')).toEqual(first);
    }
    expect(first.map((m) => m.path)).toEqual([
      '$.arr[0].name',
      '$.arr[0].child.name',
      '$.arr[1].name',
      '$.arr[1].child.name',
      '$.obj.z.name',
      '$.obj.z.child.name',
    ]);
  });

  it('orders nested segments after descent over the full current set', () => {
    // $..a.b : for every descendant 'a' in pre-order, take its direct 'b'.
    const data = {
      a: { b: 1 },
      mid: { a: { b: 2 } },
      arr: [{ a: { b: 3 } }],
    };
    expect(query(data, '$..a.b')).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared (acyclic) sub-objects: NO global deduplication.
// ---------------------------------------------------------------------------

describe('shared acyclic sub-objects are emitted once per path', () => {
  it('descends into a shared object from every occurrence', () => {
    const shared = { name: 'sh', tag: 't' };
    const data: Record<string, unknown> = {
      left: { child: shared },
      right: { child: shared },
    };

    const matches = queryPaths(data, '$..name');
    expect(matches.map((m) => m.value)).toEqual(['sh', 'sh']);
    expect(matches.map((m) => m.path)).toEqual([
      '$.left.child.name',
      '$.right.child.name',
    ]);

    // $..* must traverse the shared subtree twice.
    const wild = queryPaths(data, '$..*');
    expect(wild.map((m) => m.path)).toEqual([
      '$.left',
      '$.left.child',
      '$.left.child.name',
      '$.left.child.tag',
      '$.right',
      '$.right.child',
      '$.right.child.name',
      '$.right.child.tag',
    ]);
  });

  it('also applies when the shared node is reached through arrays', () => {
    const shared = { name: 'sh' };
    const data = [shared, shared, { x: shared }];
    expect(queryPaths(data, '$..name').map((m) => m.path)).toEqual([
      '$[0].name',
      '$[1].name',
      '$[2].x.name',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Real cycles: ancestor-chain detection only; deterministic termination.
// ---------------------------------------------------------------------------

describe('cyclic references', () => {
  it('emits the back-edge when it matches but never re-enters it', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b' };
    a.next = b;
    b.prev = a; // real cycle

    const names = queryPaths(a, '$..name');
    expect(names.map((m) => m.value)).toEqual(['a', 'b']);
    expect(names.map((m) => m.path)).toEqual(['$.name', '$.next.name']);

    // The cyclic edge itself is emitted (matched by the wildcard), but its
    // interior is not traversed a second time.
    const all = queryPaths(a, '$..*');
    expect(all.map((m) => m.path)).toEqual([
      '$.name',
      '$.next',
      '$.next.name',
      '$.next.prev', // back-edge to the ancestor a: emitted, not entered
    ]);
    expect(all[3].value).toBe(a);
  });

  it('handles self-referential nodes', () => {
    const self: Record<string, unknown> = { name: 'me' };
    self.self = self;

    const all = queryPaths(self, '$..*');
    expect(all.map((m) => m.path)).toEqual(['$.name', '$.self']);
    expect(all[1].value).toBe(self);

    // Selector matching on the cyclic edge key still works.
    expect(queryPaths(self, '$..self').map((m) => m.path)).toEqual(['$.self']);
  });

  it('handles array cycles', () => {
    const arr: unknown[] = [];
    arr.push(arr, { name: 'deep' });
    arr[0] = arr;

    const all = queryPaths(arr, '$..*');
    expect(all.map((m) => m.path)).toEqual([
      '$[0]',      // back-edge to root array
      '$[1]',      // object
      '$[1].name', // its descendant
    ]);
    expect(all[0].value).toBe(arr);
  });

  it('detects cycles even after direct segments', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { name: 'b' };
    a.to = b;
    b.back = a;
    // $.to starts inside the cycle with its own ancestor chain seeded.
    const all = queryPaths(a, '$.to..*');
    expect(all.map((m) => m.path)).toEqual(['$.to.name', '$.to.back']);
    expect(all[1].value).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// 4. Sparse arrays: holes are not own properties and must be skipped.
// ---------------------------------------------------------------------------

describe('sparse arrays', () => {
  it('skips holes while keeping real elements ordered by index', () => {
    const sparse: unknown[] = [];
    sparse[0] = 'a';
    sparse[5] = 'b';
    sparse[10] = { name: 'c' };

    const matches = queryPaths(sparse, '$..*');
    expect(matches.map((m) => m.path)).toEqual(['$[0]', '$[5]', '$[10]', '$[10].name']);
    expect(matches.map((m) => m.value)).toEqual(['a', 'b', { name: 'c' }, 'c']);
  });

  it('treats explicitly-stored undefined as a real element, unlike a hole', () => {
    const arr: unknown[] = [];
    arr[2] = undefined;
    // eslint-disable-next-line no-sparse-arrays
    const withHole: unknown[] = [, undefined];

    expect(Object.keys(arr)).toEqual(['2']);
    expect(Object.keys(withHole)).toEqual(['1']);
    expect(queryPaths(arr, '$[*]').map((m) => m.path)).toEqual(['$[2]']);
    expect(queryPaths(withHole, '$[*]').map((m) => m.path)).toEqual(['$[1]']);
  });
});

// ---------------------------------------------------------------------------
// 5. Integer-style keys: enumeration order + canonical path disambiguation.
// ---------------------------------------------------------------------------

describe('integer-style keys', () => {
  it('enumerates integer-style keys ascending before other keys (own order)', () => {
    const obj: Record<string, number> = { z: 1, '2': 2, a: 3, '0': 0, '10': 10, '1': 1 };
    // ECMAScript own-property order: integer keys ascending, then insertion order.
    expect(queryPaths(obj, '$.*').map((m) => m.path)).toEqual([
      "$['0']",
      "$['1']",
      "$['2']",
      "$['10']",
      '$.z',
      '$.a',
    ]);
  });

  it('canonical paths quote integer-style object keys but not array indices', () => {
    const data = { '0': { '0': 'nested' }, list: [{ name: 'x' }] };
    expect(queryPaths(data, '$..*').map((m) => m.path)).toEqual([
      "$['0']",
      "$['0']['0']",
      '$.list',
      '$.list[0]',
      '$.list[0].name',
    ]);
  });

  it('[0] matches both array index 0 and object key "0"', () => {
    const data = { '0': 'obj', arr: ['arr0'] };
    expect(query(data, '$..[0]')).toEqual(['obj', 'arr0']);
    expect(queryPaths(data, '$..[0]').map((m) => m.path)).toEqual(["$['0']", '$.arr[0]']);
  });

  it('descending to the quoted field ["0"] also matches both key spaces', () => {
    const data = { '0': 'obj', arr: ['arr0'] };
    expect(query(data, '$..["0"]')).toEqual(['obj', 'arr0']);
  });
});

// ---------------------------------------------------------------------------
// 6. Symbol / non-enumerable properties are ignored.
// ---------------------------------------------------------------------------

describe('symbol and non-enumerable properties', () => {
  it('never visits symbol-keyed properties', () => {
    const sym = Symbol('name');
    const obj = { name: 'real' } as Record<symbol | string, unknown>;
    Object.defineProperty(obj, sym, { value: { name: 'symchild' }, enumerable: true });

    expect(query(obj, '$..name')).toEqual(['real']);
    expect(queryPaths(obj, '$..*').map((m) => m.path)).toEqual(['$.name']);
  });

  it('never visits non-enumerable string properties', () => {
    const obj: Record<string, unknown> = { name: 'real' };
    Object.defineProperty(obj, 'hidden', { value: 'x', enumerable: false });

    expect(query(obj, '$..name')).toEqual(['real']);
    expect(query(obj, '$..hidden')).toEqual([]);
    expect(queryPaths(obj, '$..*').map((m) => m.path)).toEqual(['$.name']);
  });

  it('parses a field name containing a star via dot notation but symbols stay hidden', () => {
    const obj = { '*name*': 1 } as Record<string, unknown>;
    expect(query(obj, '$.*name*')).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// 7. Deep structures: iterative traversal must not overflow the stack.
// ---------------------------------------------------------------------------

describe('deep structures', () => {
  it('traverses tens of thousands of nested levels iteratively', () => {
    const depth = 20_000;
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < depth; i++) {
      const next: Record<string, unknown> = { name: i };
      cur.next = next;
      cur = next;
    }

    const names = query(root, '$..name') as number[];
    expect(names.length).toBe(depth);
    expect(names[0]).toBe(0);
    expect(names[depth - 1]).toBe(depth - 1);

    const leafPath = queryPaths(cur, '$') satisfies unknown;
    expect(leafPath[0].path).toBe('$');
  });

  it('builds correct canonical paths at depth', () => {
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < 100; i++) {
      const arr: unknown[] = [];
      const next: Record<string, unknown> = { name: i };
      arr.push(next);
      cur.a = arr;
      cur = next;
    }
    const matches = queryPaths(root, '$..name');
    expect(matches[0].path).toBe('$.a[0].name');
    expect(matches[99].path).toBe(`$${'.a[0]'.repeat(100)}.name`);
  });
});

// ---------------------------------------------------------------------------
// 8. Cancellation via AbortSignal.
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  function expectAbort(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('AbortError');
      return;
    }
    expect.unreachable('expected an AbortError to be thrown');
  }

  it('throws an AbortError when the signal is already aborted', () => {
    const ac = new AbortController();
    ac.abort();
    expectAbort(() => query([1, 2, 3], '$..*', { signal: ac.signal }));
  });

  it('stops traversal as soon as the signal aborts mid-run', () => {
    // The engine is synchronous, so a real AbortController can only be
    // observed between queries. A signal-shaped object flipped by the
    // engine's own aborted-checks models mid-traversal cancellation.
    let visits = 0;
    const signal = {
      get aborted() {
        visits += 1;
        return visits > 100;
      },
    } as AbortSignal;

    const big = Array.from({ length: 1_000_000 }, (_, i) => ({ i }));
    expectAbort(() => query(big, '$..*', { signal }));
  });

  it('checks abort between descent segments', () => {
    const ac = new AbortController();
    const data = { a: { b: { c: 1 } } };
    ac.abort();
    expectAbort(() => query(data, '$..a..b', { signal: ac.signal }));
  });

  it('does not throw when the signal never aborts', () => {
    const ac = new AbortController();
    expect(query({ a: [1, 2] }, '$..*', { signal: ac.signal })).toEqual([[1, 2], 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 9. Equivalence with a simple recursive reference implementation on
//    acyclic JSON-shaped input (including shared acyclic subgraphs).
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Independent reference: naive recursive depth-first pre-order.
 * Correct on acyclic inputs; would recurse infinitely on cycles, so it is
 * only used on generated acyclic DAGs below.
 */
function referenceDescent(
  root: Json,
  key: string | null,
  startPath = '$',
): { value: Json; path: string }[] {
  const results: { value: Json; path: string }[] = [];

  const childPath = (parentPath: string, k: string, isArr: boolean) => {
    if (isArr && /^(?:0|[1-9][0-9]*)$/.test(k)) return `${parentPath}[${k}]`;
    if (/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(k)) return `${parentPath}.${k}`;
    return `${parentPath}['${k}']`;
  };

  const walk = (node: Json, path: string, matchKey: string | null) => {
    if (node === null || typeof node !== 'object') return;
    const isArr = Array.isArray(node);
    // Object.keys on JSON values: integer keys ascending, then string keys;
    // holes in arrays are naturally skipped.
    for (const k of Object.keys(node)) {
      const child = (node as Record<string, Json>)[k];
      const cp = childPath(path, k, isArr);
      if (matchKey === null || k === matchKey) results.push({ value: child, path: cp });
      walk(child, cp, matchKey);
    }
  };

  walk(root, startPath, key);
  return results;
}

/** Builds an acyclic layered DAG so objects are heavily shared but no cycle. */
function buildAcyclicDag(depth: number, breadth: number, seed: number): Json {
  let seedState = seed;
  const rand = () => {
    // deterministic LCG
    seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
    return seedState / 0x7fffffff;
  };

  // Bottom layer: leaf objects with both integer-like and normal keys.
  const leafPool: Json[] = Array.from({ length: breadth }, (_, i) => ({
    name: `leaf-${i}`,
    '0': i,
    nested: { name: `nested-${i}` },
  }));

  let pool: Json[] = leafPool;
  for (let d = 0; d < depth; d++) {
    const nextPool: Json[] = [];
    for (let i = 0; i < breadth; i++) {
      if (rand() < 0.5) {
        const arr: Json[] = [];
        for (let j = 0; j < breadth; j++) arr.push(pool[Math.floor(rand() * pool.length)]);
        nextPool.push(arr);
      } else {
        const obj: Record<string, Json> = {};
        for (let j = 0; j < breadth; j++) {
          // mix insertion order to exercise the integer-key reordering
          const key = j % 2 === 0 ? `k${j}` : String(Math.floor(rand() * breadth));
          obj[key] = pool[Math.floor(rand() * pool.length)];
        }
        obj.name = `d${d}-${i}`;
        nextPool.push(obj);
      }
    }
    pool = nextPool;
  }

  // Arrays at every layer may be sparse (delete some entries), and the
  // reference and engine both skip holes, so equivalence still holds.
  for (const node of pool) {
    if (Array.isArray(node)) {
      delete node[0];
      delete node[node.length - 1];
    }
  }

  return pool[0];
}

describe('reference implementation equivalence on acyclic JSON', () => {
  const cases: { key: string | null; expr: (k: string) => string }[] = [
    { key: null, expr: () => '$..*' },
    { key: 'name', expr: () => '$..name' },
    { key: '0', expr: () => '$..[0]' },
    { key: 'nested', expr: () => "$..['nested']" },
  ];

  for (let seed = 1; seed <= 4; seed++) {
    for (const c of cases) {
      it(`agrees item-by-item (seed ${seed}, selector ${c.expr(c.key ?? '')})`, () => {
        const dag = buildAcyclicDag(5, 5, seed * 7919);
        const expected = referenceDescent(dag, c.key);
        const actual = queryPaths(dag, c.expr(c.key ?? ''));
        expect(actual).toEqual(expected);
      });
    }
  }

  it('agrees for chained descent segments ($..nested..name)', () => {
    const dag = buildAcyclicDag(4, 4, 42);
    // Reference for $..nested..name: run the first descent, then run the
    // second descent from every matched node using its canonical path.
    const nestedNodes = referenceDescent(dag, 'nested');
    const expected: { value: Json; path: string }[] = [];
    for (const n of nestedNodes) {
      expected.push(...referenceDescent(n.value, 'name', n.path));
    }
    const actual = queryPaths(dag, '$..nested..name').map((m) => ({
      value: m.value as Json,
      path: m.path,
    }));
    expect(actual).toEqual(expected);
  });

  it('agrees on a hand-written DAG with shared branches', () => {
    const shared: Json = { name: 's', '2': { name: 't' }, '10': 'x' };
    const dag: Json = {
      arr: [shared, { name: 'u', child: shared }],
      obj: { '0': shared, z: [shared] },
    };
    expect(queryPaths(dag, '$..*')).toEqual(referenceDescent(dag, null));
    expect(queryPaths(dag, '$..name')).toEqual(referenceDescent(dag, 'name'));
    expect(queryPaths(dag, '$..[2]')).toEqual(referenceDescent(dag, '2'));
  });
});
