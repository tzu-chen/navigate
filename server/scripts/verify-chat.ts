// Verification harness for the chat backend.
//
// Covers everything that needs neither the network nor a model: the flag vector
// (whose prime/resume symmetry IS the prefix-identity rule, mechanized), system
// prompt freezing, context-mode resolution and its fallback chain, the NDJSON
// input framing and its no-cache_control rule, result-event parsing, the CLI
// session store's reaping, and migration idempotency. Runs against an isolated
// temporary data dir — it never touches real data and never spends a call.
//
// Run:  npm run verify:chat --prefix server
// Exits non-zero if any check fails.

import fs from 'fs';
import os from 'os';
import path from 'path';

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

/** Every string anywhere in a JSON value, for "no cache_control anywhere" style checks. */
function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) keysDeep(v, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysDeep(v, found);
    }
  }
  return found;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-verify-'));
  process.env.SUITE_DATA_ROOT = tmp;

  const db = await import('../src/services/database');
  const chat = await import('../src/services/chat');
  db.initializeDatabase();

  // ---------------------------------------------------------------------------
  console.log('Phase 1 — the flag vector (prefix identity, mechanized)\n');

  const systemPrompt = 'You are a research assistant.\n\nWith a newline and "quotes".';
  const prime = chat.buildChatArgs({
    systemPrompt,
    model: 'claude-opus-5',
    effort: 'medium',
    sessionId: '11111111-2222-3333-4444-555555555555',
  });
  const resume = chat.buildChatArgs({
    systemPrompt,
    model: 'claude-opus-5',
    effort: 'medium',
    resumeId: '11111111-2222-3333-4444-555555555555',
  });

  // THE check. A cache hit needs a byte-identical prefix on every turn, and a
  // miss is silent and ~17x. If these two vectors ever differ anywhere else,
  // every resumed turn re-sends the whole paper and nothing raises an error.
  ok(prime.length === resume.length, 'prime and resume vectors are the same length');
  ok(
    JSON.stringify(prime.slice(0, -2)) === JSON.stringify(resume.slice(0, -2)) &&
      prime[prime.length - 2] === '--session-id' &&
      resume[resume.length - 2] === '--resume',
    'prime and resume differ ONLY in --session-id vs --resume (the prefix-identity rule)'
  );

  const flagAt = (flag: string, args: string[]) => args[args.indexOf(flag) + 1];
  ok(prime.includes('-p'), '--print');
  ok(flagAt('--input-format', prime) === 'stream-json', 'stream-json input (how a PDF reaches the model)');
  ok(flagAt('--output-format', prime) === 'stream-json', 'stream-json output');
  ok(prime.includes('--include-partial-messages'), 'partial messages, so the answer streams');
  // The CLI refuses --output-format stream-json under -p without this.
  ok(prime.includes('--verbose'), '--verbose, which stream-json output requires under -p');
  ok(flagAt('--tools', prime) === '', 'every built-in tool is disabled');
  ok(flagAt('--system-prompt', prime) === systemPrompt, 'the frozen prompt is passed verbatim');
  ok(flagAt('--setting-sources', prime) === '', 'hermetic: no ambient settings, no SessionStart hooks');
  ok(prime.includes('--strict-mcp-config'), 'no ambient MCP servers');
  // Resume reads the session from disk; disabling persistence would break the
  // entire mechanism this backend exists for.
  ok(!prime.includes('--no-session-persistence'), 'session persistence is NOT disabled');
  ok(!prime.includes('--bare'), '--bare is never used (it cannot bill the plan)');
  ok(
    flagAt('--model', prime) === 'claude-opus-5' && flagAt('--effort', prime) === 'medium',
    'model and effort are part of the vector, hence part of the prefix'
  );

  let threw = false;
  try {
    chat.buildChatArgs({ systemPrompt, model: 'm', effort: 'medium' });
  } catch {
    threw = true;
  }
  ok(threw, 'a vector with neither session id nor resume id is refused');

  // ---------------------------------------------------------------------------
  console.log('\nPhase 2 — the frozen system prompt\n');

  const paper = {
    arxivId: '1706.03762',
    title: 'Attention Is All You Need',
    summary: 'The dominant sequence transduction models...',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    categories: ['cs.CL', 'cs.LG'],
  };

  const promptA = chat.buildPaperSystemPrompt({
    paper,
    relatedWorldlines: [{ worldlineName: 'Transformers', titles: ['GPT-2', 'BERT'] }],
    contextMode: 'tex',
  });
  const promptAgain = chat.buildPaperSystemPrompt({
    paper,
    relatedWorldlines: [{ worldlineName: 'Transformers', titles: ['GPT-2', 'BERT'] }],
    contextMode: 'tex',
  });
  ok(promptA === promptAgain, 'rendering is deterministic (same inputs, same bytes)');

  const promptWithNewThread = chat.buildPaperSystemPrompt({
    paper,
    relatedWorldlines: [
      { worldlineName: 'Transformers', titles: ['GPT-2', 'BERT', 'Mamba'] },
    ],
    contextMode: 'tex',
  });
  ok(
    promptWithNewThread !== promptA,
    'adding a worldline sibling DOES change a freshly rendered prompt (which is why it is frozen)'
  );

  ok(promptA.includes('1706.03762') && promptA.includes('Ashish Vaswani'), 'prompt names the paper');
  ok(promptA.includes('Transformers') && promptA.includes('BERT'), 'prompt carries the research thread');
  ok(
    /no pagination|page numbers/i.test(promptA),
    'tex mode tells the model it has no page numbers to cite'
  );
  ok(
    chat.buildPaperSystemPrompt({ paper, relatedWorldlines: [], contextMode: 'pdf' }).includes('PDF'),
    'pdf mode says the PDF is attached'
  );
  const abstractPrompt = chat.buildPaperSystemPrompt({
    paper,
    relatedWorldlines: [],
    contextMode: 'abstract',
  });
  ok(
    abstractPrompt.includes(paper.summary),
    'abstract mode is the only mode that puts the abstract in the prompt'
  );
  ok(
    !chat.buildPaperSystemPrompt({
      paper: { ...paper, arxivId: 'upload-123' },
      relatedWorldlines: [],
      contextMode: 'pdf',
    }).includes('ArXiv ID'),
    'an uploaded paper is not given a fictitious arXiv id'
  );

  const withWalkthrough = chat.buildPaperSystemPrompt({
    paper,
    relatedWorldlines: [],
    contextMode: 'tex',
    walkthrough: {
      thesis: 'Attention alone suffices.',
      scenes: [{ title: 'Scaled dot-product attention', narration: 'A softmax over scores.' }],
    },
  });
  ok(
    withWalkthrough.includes('Scaled dot-product attention'),
    'a built walkthrough contributes its outline to the prompt'
  );
  ok(
    /source wins|not the paper itself/i.test(withWalkthrough),
    "the walkthrough is framed as a model's reading, subordinate to the source"
  );

  const worldlinePrompt = chat.buildWorldlineSystemPrompt({
    worldline: {
      worldlineName: 'Diffusion',
      papers: [
        { title: 'DDPM', authors: ['Ho'], summary: 'Denoising diffusion.', arxivId: '2006.11239' },
      ],
    },
  });
  ok(worldlinePrompt.includes('DDPM') && worldlinePrompt.includes('2006.11239'), 'worldline prompt lists its papers');
  ok(/not the full texts/i.test(worldlinePrompt), 'worldline prompt states it has abstracts only');

  // Freezing at the storage layer: what goes in comes back out unchanged, even
  // after the thread it was rendered from has moved on.
  db.createChatSession({ id: 'sess-1', arxiv_id: paper.arxivId, paper_title: paper.title, session_type: 'paper' });
  db.setChatSessionPriming('sess-1', {
    cli_session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    context_mode: 'tex',
    system_prompt: promptA,
    backend: 'cli',
    model: 'claude-opus-5',
  });
  const stored = db.getChatSessionPriming('sess-1');
  ok(stored?.system_prompt === promptA, 'the frozen prompt round-trips byte-for-byte');
  ok(stored?.context_mode === 'tex' && stored?.backend === 'cli', 'mode and backend are frozen with it');
  ok(
    stored!.system_prompt !== promptWithNewThread,
    'a worldline change after creation does not alter the stored prompt'
  );

  db.setChatSessionCliId('sess-1', '99999999-8888-7777-6666-555555555555');
  ok(
    db.getChatSessionPriming('sess-1')?.system_prompt === promptA,
    're-priming swaps the CLI session id and leaves the prompt alone'
  );

  // ---------------------------------------------------------------------------
  console.log('\nPhase 3 — context resolution and its fallback chain\n');

  const pdfOk = async () => 'JVBERi0xLjQK';
  const pdfMissing = async () => {
    throw new Error('Uploaded PDF not found on disk');
  };

  const upload = await chat.resolvePaperContext('upload-abc', 'tex', pdfOk);
  ok(upload.mode === 'pdf', 'upload-* forces pdf — there is no arXiv source by construction');
  ok(!!upload.pdfBase64, 'the upload carries its base64 PDF');

  const uploadNoPdf = await chat.resolvePaperContext('upload-gone', 'tex', pdfMissing);
  ok(uploadNoPdf.mode === 'abstract', 'an upload whose PDF is missing degrades to abstract');
  ok(
    uploadNoPdf.warnings.some(w => /pdf/i.test(w)),
    'the degradation is recorded as a warning rather than hidden'
  );

  // A `pdf` preference must not silently reach for the network to try TeX first.
  const preferPdf = await chat.resolvePaperContext('upload-abc2', 'pdf', pdfOk);
  ok(preferPdf.mode === 'pdf', 'the pdf preference is honoured');

  ok(
    chat.CHAT_CONTEXT_MODES.join(',') === 'tex,pdf,abstract',
    'the fallback chain is tex → pdf → abstract'
  );

  // ---------------------------------------------------------------------------
  console.log('\nPhase 4 — NDJSON input framing\n');

  const texCtx = { mode: 'tex' as const, tex: '\\documentclass{article}', warnings: [] };
  const pdfCtx = { mode: 'pdf' as const, pdfBase64: 'JVBERi0xLjQK', warnings: [] };

  const texLine = chat.frameUserMessage(chat.primeBlocks(texCtx, '', 'What is the loss?'));
  const pdfLine = chat.frameUserMessage(chat.primeBlocks(pdfCtx, '', 'What is the loss?'));

  ok(texLine.endsWith('\n') && texLine.trimEnd().split('\n').length === 1, 'one NDJSON line per message');
  const texMsg = JSON.parse(texLine);
  const pdfMsg = JSON.parse(pdfLine);
  ok(texMsg.type === 'user' && texMsg.message.role === 'user', 'framed as a user message');
  ok(texMsg.message.content[0].type === 'text', 'tex context is a text block');
  ok(pdfMsg.message.content[0].type === 'document', 'pdf context is a document block');
  ok(
    pdfMsg.message.content[0].source.media_type === 'application/pdf' &&
      pdfMsg.message.content[0].source.type === 'base64',
    'the document block is a base64 PDF source'
  );
  ok(
    texMsg.message.content[texMsg.message.content.length - 1].text === 'What is the loss?',
    'the question is the last block'
  );

  // ⚠️ The CLI already places four cache breakpoints; a fifth is a hard 400.
  for (const [name, msg] of [['tex', texMsg], ['pdf', pdfMsg]] as const) {
    ok(!keysDeep(msg).has('cache_control'), `no cache_control anywhere in the ${name} message`);
  }

  const abstractBlocks = chat.primeBlocks({ mode: 'abstract', warnings: [] }, '', 'Hi');
  ok(abstractBlocks.length === 1, 'abstract mode sends the question and nothing else');

  const withReplay = chat.primeBlocks(texCtx, 'REPLAYED', 'Next question');
  ok(
    withReplay.length === 3 && (withReplay[1] as any).text === 'REPLAYED',
    'a replayed transcript rides after the context block, before the question'
  );

  // ---------------------------------------------------------------------------
  console.log('\nPhase 5 — transcript replay\n');

  ok(chat.renderTranscriptReplay([]) === '', 'an empty history replays nothing');

  const replay = chat.renderTranscriptReplay([
    { role: 'user', content: 'What is attention?' },
    { role: 'assistant', content: 'A weighted sum.' },
  ]);
  ok(replay.includes('What is attention?') && replay.includes('A weighted sum.'), 'both roles are replayed');
  ok(/already happened/i.test(replay), 'the model is told the exchange already happened');
  ok(/do not greet/i.test(replay), 'and told not to restart the conversation');

  // "User: NEWEST" is 12 chars and "Assistant: " + 400 is 411; a 430-char cap
  // admits both and leaves no room for the 12 the oldest turn needs.
  const long = chat.renderTranscriptReplay(
    [
      { role: 'user' as const, content: 'OLDEST' },
      { role: 'assistant' as const, content: 'x'.repeat(400) },
      { role: 'user' as const, content: 'NEWEST' },
    ],
    430
  );
  ok(!long.includes('OLDEST') && long.includes('NEWEST'), 'the cap drops the oldest turns first');
  ok(/omitted/i.test(long), 'and says how many were dropped');

  // ---------------------------------------------------------------------------
  console.log('\nPhase 6 — result-event parsing\n');

  ok(
    chat.interpretChatStreamLine('not json').length === 0,
    'a partial or malformed line is ignored, not fatal'
  );
  ok(
    chat.interpretChatStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' })
    )[0]?.type === 'init',
    'the init event is recognized'
  );

  const delta = chat.interpretChatStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
    })
  );
  ok(delta.length === 1 && delta[0].type === 'delta' && (delta[0] as any).text === 'Hel', 'text deltas are forwarded');

  // The user asked about a paper, not to watch the model deliberate.
  ok(
    chat.interpretChatStreamLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
      })
    ).length === 0,
    'thinking deltas are NOT forwarded'
  );

  const resultEvent = chat.interpretChatStreamLine(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'The loss is cross-entropy.',
      session_id: 'sess-uuid',
      total_cost_usd: 0.0058,
      usage: {
        input_tokens: 152,
        output_tokens: 600,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 43832,
      },
      modelUsage: { 'claude-opus-5': {} },
    })
  )[0] as any;
  ok(resultEvent.type === 'result' && !resultEvent.isError, 'a success envelope parses as a result');
  ok(resultEvent.text === 'The loss is cross-entropy.', 'the answer text is taken from the envelope');
  ok(resultEvent.usage.cache_read_input_tokens === 43832, 'cache reads are extracted (the 17x tripwire)');
  ok(resultEvent.costUsd === 0.0058, 'the CLI prices the call itself');
  ok(resultEvent.sessionId === 'sess-uuid', 'the session id comes back');
  // `modelUsage` enumerates every model the session touched, including the small
  // background model the CLI uses for its own housekeeping, and its key order is
  // not "the" model. Reading a model out of it and freezing that on the session
  // made turn 2 of a live conversation resume as Haiku — the wrong model, and a
  // guaranteed cache miss since --model is part of the prefix. The requested
  // model is the only correct answer, so the event does not offer another.
  ok(!('model' in resultEvent), 'the result event exposes no model to be mistakenly frozen');

  const errorEvent = chat.interpretChatStreamLine(
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' })
  )[0] as any;
  ok(errorEvent.isError === true, 'an is_error envelope is recognized as a failure');
  const nonSuccess = chat.interpretChatStreamLine(
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'nope' })
  )[0] as any;
  ok(!!nonSuccess.isError, 'a non-success subtype is a failure even without is_error');

  ok(
    chat.isMissingSessionError('No conversation found with session ID abc'),
    'a vanished session id is detected, so the turn can re-prime instead of failing'
  );
  ok(!chat.isMissingSessionError('Credit balance too low'), 'an unrelated failure is not mistaken for one');

  // ---------------------------------------------------------------------------
  console.log('\nPhase 7 — cost accounting\n');

  const opus = chat.estimateCost(
    {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    'claude-opus-5'
  );
  ok(Math.abs(opus - 5) < 1e-9, 'Opus 5 input is $5/M');
  const cacheRead = chat.estimateCost(
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    },
    'claude-opus-5'
  );
  ok(Math.abs(cacheRead - 0.5) < 1e-9, 'a cache read is a tenth of the input price — the whole point');
  ok(chat.priceFor('claude-sonnet-4-20250514').input === 3, 'an older model prices at its own rate');
  ok(chat.priceFor('some-unknown-model').input === 5, 'an unknown model falls back to the default price');

  // ---------------------------------------------------------------------------
  console.log('\nPhase 8 — the CLI working directory and its session store\n');

  ok(chat.projectSlug('/home/u/Codes/x') === '-home-u-Codes-x', 'the project slug matches the CLI’s encoding');
  ok(chat.projectSlug('/a/.b/c') === '-a--b-c', 'dots slugify like separators');

  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cwd-clean-'));
  ok(chat.findClaudeMdAncestor(clean) === null, 'a clean directory has no CLAUDE.md ancestor');
  const polluted = path.join(clean, 'nested', 'deeper');
  fs.mkdirSync(polluted, { recursive: true });
  fs.writeFileSync(path.join(clean, 'CLAUDE.md'), '# project');
  ok(
    chat.findClaudeMdAncestor(polluted) === path.join(clean, 'CLAUDE.md'),
    'a CLAUDE.md three levels up IS found (10,835 vs 602 tokens per message if it is not)'
  );

  const cwd = chat.chatSessionsCwd();
  ok(fs.existsSync(cwd), 'the chat working directory exists');
  ok(
    chat.findClaudeMdAncestor(cwd) === null,
    'the chosen working directory has no CLAUDE.md on any ancestor'
  );
  ok(chat.chatSessionsCwd() === cwd, 'the directory is stable across calls (resume keys off cwd)');

  ok(!chat.reapCliSession('../../etc/passwd'), 'reaping refuses anything that is not a uuid');
  ok(!chat.reapCliSession('sess-1'), 'reaping refuses an app session id');

  const slugDir = path.join(os.homedir(), '.claude', 'projects', chat.projectSlug(cwd));
  let sweepChecked = false;
  try {
    fs.mkdirSync(slugDir, { recursive: true });
    const live = '11111111-1111-1111-1111-111111111111';
    const dead = '22222222-2222-2222-2222-222222222222';
    const young = '33333333-3333-3333-3333-333333333333';
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    for (const id of [live, dead]) {
      fs.writeFileSync(path.join(slugDir, `${id}.jsonl`), '{}');
      fs.utimesSync(path.join(slugDir, `${id}.jsonl`), old / 1000, old / 1000);
    }
    fs.writeFileSync(path.join(slugDir, `${young}.jsonl`), '{}');
    fs.writeFileSync(path.join(slugDir, 'not-a-session.txt'), 'keep me');

    const removed = chat.sweepCliSessions(new Set([live]));
    ok(removed === 1, 'the sweep removes exactly the stale, unreferenced transcript');
    ok(fs.existsSync(path.join(slugDir, `${live}.jsonl`)), 'a live session is kept however old it is');
    ok(!fs.existsSync(path.join(slugDir, `${dead}.jsonl`)), 'an unreferenced old session is removed');
    ok(fs.existsSync(path.join(slugDir, `${young}.jsonl`)), 'a recent session is kept');
    ok(fs.existsSync(path.join(slugDir, 'not-a-session.txt')), 'anything not named like a session is untouched');

    ok(chat.reapCliSession(young), 'reaping a real session id removes its transcript');
    ok(!fs.existsSync(path.join(slugDir, `${young}.jsonl`)), 'and the file is gone');

    fs.rmSync(slugDir, { recursive: true, force: true });
    sweepChecked = true;
  } catch (err) {
    console.error(`  ! could not exercise the session sweep: ${err}`);
  }
  ok(sweepChecked, 'the session sweep was exercised');

  // ---------------------------------------------------------------------------
  console.log('\nPhase 9 — migration idempotency\n');

  let migrationThrew = false;
  try {
    db.initializeDatabase();
    db.initializeDatabase();
  } catch {
    migrationThrew = true;
  }
  ok(!migrationThrew, 'the chat_sessions ALTER TABLEs run twice without error');
  ok(
    db.getChatSessionPriming('sess-1')?.cli_session_id === '99999999-8888-7777-6666-555555555555',
    'the migration preserves existing rows'
  );

  const liveIds = db.getLiveCliSessionIds();
  ok(liveIds.includes('99999999-8888-7777-6666-555555555555'), 'live CLI session ids are readable for the sweep');
  ok(
    db.getCliSessionIdsForPaper('1706.03762').length === 1,
    'a paper’s CLI sessions are findable, so deleting the paper reaps them'
  );

  db.deleteChatSession('sess-1');
  ok(db.getChatSessionPriming('sess-1') === undefined, 'deleting the row removes the priming with it');

  // ---------------------------------------------------------------------------
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(clean, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
