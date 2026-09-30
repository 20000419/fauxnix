import { psStr } from '../registry.js';
import { nodeEngineRange } from '../runtime-support.js';

/** Trusted program, no user text interpolation. It only reads input and emits bytes. */
export const GZIP_DECODER_SOURCE = String.raw`
const { createReadStream } = require('node:fs');
const { createGunzip } = require('node:zlib');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
(async () => {
  const controller = new AbortController();
  const parent = Number(process.argv[3]);
  const watcher = Number.isSafeInteger(parent) && parent > 0 ? setInterval(() => {
    try { process.kill(parent, 0); }
    catch (error) {
      if (error.code === 'ESRCH') {
        clearInterval(watcher);
        controller.abort();
        // A stalled inherited pipe can retain a pending native write after
        // stream destruction. Once the parent is gone, terminate only this
        // read-only decoder after a bounded best-effort diagnostic drain.
        setTimeout(() => process.exit(1), 1000).unref();
      }
    }
  }, 250) : undefined;
  watcher?.unref();
  process.stderr.on('error', () => {});
  try {
    const minimum = ${JSON.stringify(nodeEngineRange.slice(2).split('.').map(Number))};
    const actual = process.versions.node.split('.').map(Number);
    let supported = actual.every(Number.isSafeInteger);
    for (let i = 0; supported && i < 3; i++) {
      if (actual[i] !== minimum[i]) { supported = actual[i] > minimum[i]; break; }
    }
    if (!supported) throw new Error('Node.js ${nodeEngineRange} is required for strict gzip decoding');
    const path = Buffer.from(process.argv[1], 'base64').toString('utf8');
    const mode = process.argv[2];
    if (mode !== 'test' && mode !== 'stream') throw new Error('invalid decoder mode');
    const sink = mode === 'test' ? new Writable({ write(chunk, encoding, next) { next(); } }) : process.stdout;
    await pipeline(createReadStream(path), createGunzip(), sink, { signal: controller.signal });
  } catch (error) {
    process.stderr.write('gzip decoder: ' + String(error.message).slice(0, 2048) + '\n');
    process.exitCode = error.code === 'Z_DATA_ERROR' || error.code === 'Z_BUF_ERROR' ? 2 : 1;
  } finally { if (watcher) clearInterval(watcher); }
})();
`;

export function gzipNodeFunctions(pure: boolean): string {
  const program = Buffer.from(GZIP_DECODER_SOURCE, 'utf8').toString('base64');
  const prefix = `-e "eval(Buffer.from('${program}','base64').toString())" -- `;
  const node = pure
    ? "(Get-Command node.exe -CommandType Application -ErrorAction Stop).Source"
    : psStr(process.execPath);
  return [
    'function fx-gz-decode($src, $isBytes, $sink, $testOnly) {',
    '  $fx_raw = $null; $fx_process = $null',
    '  try {',
    '    if ($isBytes) {',
    "      $fx_inputPath = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'fauxnix-gzip-input-' + [Guid]::NewGuid().ToString('N') + '.tmp')",
    '      $fx_raw = New-Object IO.FileStream($fx_inputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, ([IO.FileShare]::Read -bor [IO.FileShare]::Delete), 65536, [IO.FileOptions]::DeleteOnClose)',
    '      $fx_raw.Write($src, 0, $src.Length); $fx_raw.Flush()',
    '    } else {',
    '      $fx_inputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($src)',
    '      $fx_raw = [IO.File]::Open($fx_inputPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    '    }',
    '    $fx_psi = New-Object Diagnostics.ProcessStartInfo',
    '    $fx_psi.FileName = ' + node,
    '    $fx_psi.UseShellExecute = $false; $fx_psi.CreateNoWindow = $true',
    '    $fx_psi.RedirectStandardOutput = $true; $fx_psi.RedirectStandardError = $true',
    '    $fx_psi.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)',
    "    $fx_mode = 'stream'; if ($testOnly) { $fx_mode = 'test' }",
    '    $fx_psi.Arguments = ' + psStr(prefix) + " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fx_inputPath)) + ' ' + $fx_mode + ' ' + $PID",
    '    $fx_process = New-Object Diagnostics.Process',
    '    $fx_process.StartInfo = $fx_psi',
    "    if (-not $fx_process.Start()) { throw 'unable to start the Node gzip decoder' }",
    '    $fx_errors = $fx_process.StandardError.ReadToEndAsync()',
    // Binary stdout never passes through PowerShell's text pipeline.
    '    try { $fx_process.StandardOutput.BaseStream.CopyTo($sink, 65536) }',
    "    catch { throw ('gzip output transfer failed: ' + $_.Exception.Message) }",
    '    $fx_process.WaitForExit()',
    '    $fx_errorText = $fx_errors.Result',
    "    if ($fx_process.ExitCode -eq 2) { throw ('not in gzip format: strict gzip decode failed: ' + $fx_errorText.Trim()) }",
    "    if ($fx_process.ExitCode -ne 0) { throw ('gzip decoder failed: ' + $fx_errorText.Trim()) }",
    '  } finally {',
    '    if ($null -ne $fx_process) {',
    '      try { if (-not $fx_process.HasExited) { $fx_process.Kill(); [void]$fx_process.WaitForExit(5000) } } catch {}',
    '      $fx_process.Dispose()',
    '    }',
    '    if ($null -ne $fx_raw) { $fx_raw.Dispose() }',
    '  }',
    '}',
    'function fx-gz-open($src, $isBytes) {',
    "  $fx_path = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'fauxnix-gzip-stdout-' + [Guid]::NewGuid().ToString('N') + '.tmp')",
    '  $fx_decoded = New-Object IO.FileStream($fx_path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 65536, [IO.FileOptions]::DeleteOnClose)',
    '  try {',
    '    fx-gz-decode $src $isBytes $fx_decoded $false',
    '    $fx_decoded.Position = 0',
    '    return $fx_decoded',
    '  } catch { $fx_decoded.Dispose(); throw }',
    '}',
  ].join('\n');
}
