#!/usr/bin/env node
/**
 * Entry point.
 *
 * No arguments means an MCP host spawned us: start the stdio server, where
 * stdout is the protocol channel and nothing may be printed to it. With
 * arguments a human is at a terminal: run the credential CLI, where stdout is
 * exactly where output belongs.
 *
 * The two cases must not share an import graph, because server.mjs redirects
 * every console.* to stderr the moment it loads.
 */
const [, , command] = process.argv;

if (!command) {
  await import('./server.mjs');
} else {
  const { runCli } = await import('./cli.mjs');
  process.exitCode = await runCli(process.argv.slice(2));
}
