/**
 * The login prompts, on the path a test normally never takes.
 *
 * Every other test here pipes its answers in, and the piped path is a
 * different branch of `Prompter` entirely — which is why three defects lived
 * on the terminal path through a green suite, and why `cat | za-codemode
 * login` "worked" while typing the same answers did not:
 *
 *  1. `for await (const chunk of stdin)` left with `break` DESTROYS stdin, so
 *     the prompt after the Client Secret died with "AbortError: The operation
 *     was aborted" before it could be answered. Reproduced over a real pty on
 *     Node 24 and reported on Node 25.
 *  2. A readline interface left open over the same stdin ECHOES the
 *     keystrokes the secret prompt exists to hide — the client secret was
 *     printed in full into the scrollback.
 *  3. A pasted secret arrives as one chunk with its own trailing newline, and
 *     the old loop discarded the whole chunk. Measured: a 42-character paste
 *     was captured as the empty string, and the run ended with "Nothing was
 *     stored."
 *
 * These fakes are a terminal as far as `Prompter` and readline can tell:
 * `isTTY`, `setRawMode` and an output that records what it was asked to
 * print. That is the whole point — with `isTTY` false, readline never echoes
 * and case 2 cannot be observed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { Prompter } from '../src/cli.mjs';

const ANSI = /\[[0-9;?]*[A-Za-z]|[()][B0]/g;

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; return input; };

  const chunks = [];
  const output = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString('utf8')); cb(); },
  });
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;

  return { input, output, printed: () => chunks.join('').replace(ANSI, '') };
}

/** Let the prompt attach its listeners before anything is typed. */
const settle = () => new Promise((done) => setImmediate(done));

async function openTerminal() {
  const io = terminal();
  const prompter = new Prompter(io);
  await prompter.open();
  return { ...io, prompter };
}

test('a secret is returned but never printed', async () => {
  const { input, prompter, printed } = await openTerminal();

  const pending = prompter.secret('  Client Secret: ');
  await settle();
  for (const ch of 'hunter2-not-for-scrollback') input.write(ch);
  input.write('\r');

  assert.equal(await pending, 'hunter2-not-for-scrollback');
  assert.match(printed(), /Client Secret: /, 'the label must still be shown');
  assert.ok(!printed().includes('hunter2'),
    `the secret reached the output: ${JSON.stringify(printed())}`);
});

test('the prompt after a secret still works — the AbortError crash', async () => {
  // This is the reported bug. Everything below the Client Secret prompt was
  // unreachable: stdin had been destroyed by the secret loop, and the
  // readline interface attached to it raised an unhandled 'error' event.
  const { input, prompter } = await openTerminal();

  const secret = prompter.secret('  Client Secret: ');
  await settle();
  input.write('s3cret\r');
  assert.equal(await secret, 's3cret');

  assert.equal(input.destroyed, false, 'the secret prompt must not destroy stdin');

  const asked = prompter.ask('  Organization ID: ');
  await settle();
  input.write('55511666\n');
  assert.equal(await asked, '55511666');
});

test('secret and visible prompts alternate indefinitely', async () => {
  // A real login asks secret, visible, secret, visible. One working handover
  // is not enough to know the stream survives the pattern.
  const { input, prompter } = await openTerminal();

  for (const round of [1, 2, 3]) {
    const secret = prompter.secret(`  secret ${round}: `);
    await settle();
    input.write(`value-${round}\r`);
    assert.equal(await secret, `value-${round}`);

    const visible = prompter.ask(`  visible ${round}: `);
    await settle();
    input.write(`seen-${round}\n`);
    assert.equal(await visible, `seen-${round}`);
  }
});

test('a pasted secret arriving in one chunk with a newline is kept', async () => {
  // Measured against the old loop over a pty: captured as '', length 0.
  const { input, prompter } = await openTerminal();
  const pasted = '9b041a3a94ffcd78d2022eb85c8b5ac2ffb51fe90f';

  const pending = prompter.secret('  Client Secret: ');
  await settle();
  input.write(`${pasted}\r`);          // one write, as a terminal delivers a paste

  assert.equal(await pending, pasted);
});

test('backspace edits, and an arrow key does not corrupt the value', async () => {
  const { input, prompter } = await openTerminal();

  const pending = prompter.secret('  Client Secret: ');
  await settle();
  input.write('abcX');
  input.write('');               // DEL — the common terminal backspace
  input.write('');               // BS  — the other one
  input.write('[A');             // up arrow: must leave nothing behind
  input.write('de\r');

  assert.equal(await pending, 'abde');
});

test('raw mode is turned on for the secret and restored afterwards', async () => {
  const { input, prompter } = await openTerminal();
  assert.equal(input.isRaw, false);

  const pending = prompter.secret('  Client Secret: ');
  await settle();
  assert.equal(input.isRaw, true, 'keystrokes must not be line-buffered or echoed');
  input.write('x\r');
  await pending;

  assert.equal(input.isRaw, false, 'the terminal must be handed back as it was found');
});

test('end of input ends the secret rather than hanging', async () => {
  const { input, prompter } = await openTerminal();

  const pending = prompter.secret('  Client Secret: ');
  await settle();
  input.write('partial');
  input.end();

  assert.equal(await pending, 'partial');
});

test('piped answers still take the non-terminal path', async () => {
  // The workaround people were told to use — `cat | za-codemode login` — must
  // keep working, and keep not echoing the secret.
  const input = new PassThrough();
  const chunks = [];
  const output = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString('utf8')); cb(); },
  });
  input.end('3\n1000.CLIENTID\ntop-secret\n55511666\n');

  const prompter = new Prompter({ input, output });
  await prompter.open();

  assert.equal(await prompter.ask('  Data centre: '), '3');
  assert.equal(await prompter.ask('  Client ID: '), '1000.CLIENTID');
  assert.equal(await prompter.secret('  Client Secret: '), 'top-secret');
  assert.equal(await prompter.ask('  Organization ID: '), '55511666');

  const printed = chunks.join('');
  assert.ok(!printed.includes('top-secret'), 'a piped secret must not be echoed either');
  assert.match(printed, /Client Secret: \(from stdin\)/);
});

test('running out of piped answers yields empty strings, not a hang', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_c, _e, cb) { cb(); } });
  input.end('only-one\n');

  const prompter = new Prompter({ input, output });
  await prompter.open();

  assert.equal(await prompter.ask('  first: '), 'only-one');
  assert.equal(await prompter.ask('  second: '), '');
  assert.equal(await prompter.secret('  third: '), '');
});
