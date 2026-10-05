// Self-contained entry for the experimental bash.exe launcher (RFC #224).
// The launcher build bundles this file with esbuild into a single CJS blob,
// injected into a copy of node.exe named bash.exe via Node SEA + postject.
// Claude Code then spawns `bash.exe -c "<cmd>"` / keeps a persistent stdin
// session — argv contract is handled by runFacade.
import './commands/install-all.js';
import { runFacade } from './facade.js';

void (async () => {
  const code = await runFacade(process.argv.slice(2));
  process.exit(code);
})();
