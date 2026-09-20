import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// "Select all matching" enumerates a whole folder / search result with
// Email/query alone. These tests pin the walk: page size follows the server's
// maxObjectsInGet, pages stop when the server's total is reached (no trailing
// empty request), ids repeated across pages (mail arriving mid-walk) are
// dropped, and the empty filter is omitted rather than sent as `{}`.

function createClient(maxObjectsInGet?: number): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'primary-account',
    username: 'user@example.com',
    capabilities: maxObjectsInGet ? { 'urn:ietf:params:jmap:core': { maxObjectsInGet } } : {},
  });
  return client;
}

type QueryArgs = { accountId: string; filter?: unknown; limit: number; position: number; calculateTotal?: boolean };

function mockQuery(allIds: string[], opts: { total?: number; duplicateAt?: number } = {}) {
  const calls: QueryArgs[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as { methodCalls: [string, QueryArgs, string][] };
    const [, args] = body.methodCalls[0];
    calls.push(args);
    let ids = allIds.slice(args.position, args.position + args.limit);
    // Simulate a message that arrived mid-walk: the first id of this page
    // was already the last id of the previous one.
    if (opts.duplicateAt !== undefined && args.position === opts.duplicateAt && args.position > 0) {
      ids = [allIds[args.position - 1], ...ids.slice(0, -1)];
    }
    const result: Record<string, unknown> = { accountId: args.accountId, ids, position: args.position };
    if (args.calculateTotal) result.total = opts.total ?? allIds.length;
    return new Response(JSON.stringify({ methodResponses: [['Email/query', result, '0']] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

const idsOf = (n: number) => Array.from({ length: n }, (_, i) => `m${i + 1}`);

describe('JMAPClient.queryAllEmailIds', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('walks every page at the advertised maxObjectsInGet and stops at the total', async () => {
    const client = createClient(3);
    const calls = mockQuery(idsOf(7));

    const result = await client.queryAllEmailIds({ inMailbox: 'inbox' }, 'shared-owner');

    expect(result).toEqual({ ids: idsOf(7), total: 7, complete: true });
    expect(calls.map((c) => [c.position, c.limit])).toEqual([[0, 3], [3, 3], [6, 3]]);
    // The total is only asked for once, on the first page.
    expect(calls.map((c) => c.calculateTotal)).toEqual([true, false, false]);
    expect(calls.every((c) => c.accountId === 'shared-owner')).toBe(true);
    expect(calls[0].filter).toEqual({ inMailbox: 'inbox' });
  });

  it('needs a single request when the folder fits one page', async () => {
    const client = createClient(500);
    const calls = mockQuery(idsOf(42));

    const result = await client.queryAllEmailIds({ inMailbox: 'inbox' });

    expect(result.ids).toHaveLength(42);
    expect(result.complete).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].accountId).toBe('primary-account');
  });

  it('drops an id repeated across pages by mail arriving mid-walk', async () => {
    const client = createClient(3);
    mockQuery(idsOf(6), { duplicateAt: 3 });

    const result = await client.queryAllEmailIds({ inMailbox: 'inbox' });

    expect(new Set(result.ids).size).toBe(result.ids.length);
    expect(result.ids).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('omits an empty filter instead of sending {}', async () => {
    const client = createClient(10);
    const calls = mockQuery(idsOf(2));

    await client.queryAllEmailIds({});

    expect('filter' in calls[0]).toBe(false);
  });

  it('reports an incomplete walk when maxIds caps it', async () => {
    const client = createClient(3);
    const calls = mockQuery(idsOf(10));

    const result = await client.queryAllEmailIds({ inMailbox: 'inbox' }, undefined, { maxIds: 4 });

    expect(result.ids).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(result.complete).toBe(false);
    expect(result.total).toBe(10);
    // The second page is trimmed to what is left under the cap.
    expect(calls.map((c) => c.limit)).toEqual([3, 1]);
  });

  it('keeps walking on a full page when the server gives no total', async () => {
    const client = createClient(4);
    const calls = mockQuery(idsOf(8), { total: 0 });

    const result = await client.queryAllEmailIds({ inMailbox: 'inbox' });

    expect(result.ids).toEqual(idsOf(8));
    expect(result.complete).toBe(true);
    // Two full pages, then the empty page that ends the walk.
    expect(calls.map((c) => c.position)).toEqual([0, 4, 8]);
  });

  it('surfaces a method-level error', async () => {
    const client = createClient(3);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      methodResponses: [['error', { type: 'unsupportedFilter', description: 'bad filter' }, '0']],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(client.queryAllEmailIds({ inMailbox: 'x' })).rejects.toThrow('bad filter');
  });
});
