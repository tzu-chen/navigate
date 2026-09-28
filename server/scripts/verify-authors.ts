import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const emptyFeed = '<feed><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults></feed>';
let calls = 0;

// No request in this verification reaches arXiv.
globalThis.fetch = async (input) => {
  calls++;
  const url = String(input);
  if (url.includes('Blocked')) {
    return new Response('', { status: 429, headers: { 'Retry-After': '30' } });
  }
  return new Response(emptyFeed, { status: 200 });
};

async function main() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'navigate-author-verify-'));
  process.env.SUITE_DATA_ROOT = dataRoot;
  const { ArxivAuthorRateLimitError, searchByAuthor } = await import('../src/services/arxiv');

  const [first, second] = await Promise.all([
    searchByAuthor('Shared Author', 10),
    searchByAuthor('Shared Author', 10),
  ]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1, 'simultaneous searches must share one arXiv request');

  await searchByAuthor('Shared Author', 10);
  assert.equal(calls, 1, 'recent results should come from cache');

  const blocked = await Promise.allSettled([
    searchByAuthor('Blocked Author', 10),
    searchByAuthor('Blocked Author', 10),
  ]);
  assert.equal(calls, 2, 'rate-limited searches must not each retry');
  assert(blocked.every(result => result.status === 'rejected' && result.reason instanceof ArxivAuthorRateLimitError));

  await assert.rejects(searchByAuthor('Another Author', 10), ArxivAuthorRateLimitError);
  assert.equal(calls, 2, 'the cooldown must prevent more uncached author searches');
  const stored = JSON.parse(fs.readFileSync(path.join(dataRoot, 'navigate', 'author-search-cache.json'), 'utf8'));
  assert(stored.entries['Shared Author::10'], 'successful searches must persist across restarts');
  assert(stored.rateLimitUntil > Date.now(), 'the rate-limit cooldown must persist across restarts');
  console.log('Favorite-author request verification passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
