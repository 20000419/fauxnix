import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/cli.js', () => ({ runCli: state.run }));
const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});
it('lets fatal CLI diagnostics drain before exiting', async () => {
  const message = 'fixture error';
  state.run.mockRejectedValueOnce(new Error(message));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await import('../src/index.js');
  await Promise.resolve();
  expect(error).toHaveBeenCalledWith(message);
  expect(process.exitCode).toBe(1);
  expect(exit).not.toHaveBeenCalled();
});
