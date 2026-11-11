/**
 * Redirect every console.* to stderr. MUST be the first import of the server.
 *
 * An MCP stdio server's stdout IS the JSON-RPC channel. The UTCP SDK and its
 * protocol plugins log progress with console.log; a single such line corrupts
 * the stream and the host disconnects with no diagnosable error. Importing this
 * first is the only thing standing between a working server and a silent one.
 */
const toStderr = (...args) =>
  process.stderr.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');

console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;
console.error = toStderr;
