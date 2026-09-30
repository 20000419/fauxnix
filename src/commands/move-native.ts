import { psStr } from '../registry.js';

// No user data is interpolated into C#. Paths are ordinary method arguments.
// Windows 8+ FILE_ID_INFO retains ReFS's full 128-bit identity; unsupported
// filesystems fail closed rather than falling back to a partial identifier.
const nativeSource = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace Fauxnix {
  public static class FileMoveV1 {
    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo {
      public ulong Volume;
      public ulong Low;
      public ulong High;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access,
      uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
      int infoClass, out FileIdInfo information, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(string source, string destination, uint flags);

    private static SafeFileHandle OpenIdentity(string path) {
      // Metadata-only access, read/write/delete sharing, OPEN_EXISTING,
      // FILE_FLAG_OPEN_REPARSE_POINT: never create or modify the inspected file.
      SafeFileHandle handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
      if (handle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        handle.Dispose();
        throw new Win32Exception(error);
      }
      return handle;
    }
    private static FileIdInfo Identity(SafeFileHandle handle) {
      FileIdInfo info;
      if (!GetFileInformationByHandleEx(handle, 18, out info, (uint)Marshal.SizeOf(typeof(FileIdInfo))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return info;
    }
    public static void ReplaceRegular(string source, string destination) {
      FileAttributes disallowed = FileAttributes.Directory | FileAttributes.ReparsePoint;
      if ((File.GetAttributes(source) & disallowed) != 0 ||
          (File.GetAttributes(destination) & disallowed) != 0)
        throw new IOException("replacement of directories or reparse points is unsupported");
      using (SafeFileHandle sourceHandle = OpenIdentity(source))
      using (SafeFileHandle destinationHandle = OpenIdentity(destination)) {
        FileIdInfo a = Identity(sourceHandle);
        FileIdInfo b = Identity(destinationHandle);
        if (a.Volume != b.Volume)
          throw new IOException("cross-volume replacement is unsupported; both files retained");
        if (a.Low == b.Low && a.High == b.High)
          throw new IOException("source and destination are the same file");
        // MOVEFILE_REPLACE_EXISTING only. No COPY_ALLOWED/predelete fallback.
        if (!MoveFileExW(source, destination, 1)) {
          int error = Marshal.GetLastWin32Error();
          if (error == 17)
            throw new IOException("cross-volume replacement is unsupported; both files retained");
          throw new Win32Exception(error);
        }
      }
    }
  }
}
`;

export const PS_MOVE_REPLACE_FN = [
  'function fx-move-replace-file($source, $destination) {',
  "  if (-not ('Fauxnix.FileMoveV1' -as [type])) {",
  '    Add-Type -TypeDefinition ' + psStr(nativeSource) + ' -ErrorAction Stop',
  '  }',
  '  [Fauxnix.FileMoveV1]::ReplaceRegular($source, $destination)',
  '}',
].join('\n');
