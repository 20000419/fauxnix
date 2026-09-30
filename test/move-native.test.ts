import { describe, expect, it } from 'vitest';
import { PS_MOVE_REPLACE_FN } from '../src/commands/move-native.js';

describe('same-volume move helper contract', () => {
  it('uses one native rename without a predelete or copy fallback', () => {
    expect(PS_MOVE_REPLACE_FN).toContain('MoveFileExW(source, destination, 1)');
    expect(PS_MOVE_REPLACE_FN).not.toContain('File.Delete(');
    expect(PS_MOVE_REPLACE_FN).not.toContain('File.Copy(');
    expect(PS_MOVE_REPLACE_FN).not.toContain('File.Replace(');
    expect(PS_MOVE_REPLACE_FN).toContain('throw new Win32Exception(error)');
  });
  it('checks full file identity and rejects cross-volume and reparse replacement', () => {
    expect(PS_MOVE_REPLACE_FN).toContain('GetFileInformationByHandleEx(handle, 18');
    expect(PS_MOVE_REPLACE_FN).toContain('a.Volume != b.Volume');
    expect(PS_MOVE_REPLACE_FN).toContain('a.Low == b.Low && a.High == b.High');
    expect(PS_MOVE_REPLACE_FN).toContain('FileAttributes.ReparsePoint');
    expect(PS_MOVE_REPLACE_FN).toContain('using (SafeFileHandle sourceHandle');
    expect(PS_MOVE_REPLACE_FN).toContain('using (SafeFileHandle destinationHandle');
  });
  it('loads lazily and makes helper failure terminating', () => {
    expect(PS_MOVE_REPLACE_FN).toContain("if (-not ('Fauxnix.FileMoveV1' -as [type]))");
    expect(PS_MOVE_REPLACE_FN).toContain(' -ErrorAction Stop');
    expect(PS_MOVE_REPLACE_FN.indexOf('Add-Type')).toBeLessThan(
      PS_MOVE_REPLACE_FN.indexOf('[Fauxnix.FileMoveV1]::ReplaceRegular'));
  });
});
