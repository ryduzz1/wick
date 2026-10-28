#!/usr/bin/env node
// The `wick` command. See app/cli.js, or run `wick help`.

// Node marks its TypeScript type stripping experimental; that's expected here.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`);
});

const { main } = await import('../app/cli.js');
process.exitCode = await main();
