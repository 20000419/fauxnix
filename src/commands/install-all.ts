import { registerAll } from '../registry.js';
import { handlers as files } from './files.js';
import { handlers as textFilters } from './text-filters.js';
import { handlers as textIo } from './text-io.js';
import { handlers as sysinfo } from './sysinfo.js';
import { handlers as net } from './net.js';
import { handlers as archive } from './archive.js';

/** Register every built-in Linux command translator. Side-effectful import. */
export function installAll(): void {
  registerAll(files);
  registerAll(textFilters);
  registerAll(textIo);
  registerAll(sysinfo);
  registerAll(net);
  registerAll(archive);
}

installAll();
