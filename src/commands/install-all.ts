import { registerAll, registerSpecs } from '../registry.js';
import { handlers as files, specs as fileSpecs } from './files.js';
import { handlers as textFilters } from './text-filters.js';
import { handlers as textIo, specs as textIoSpecs } from './text-io.js';
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
  registerSpecs(fileSpecs);
  registerSpecs(textIoSpecs);
}

installAll();
