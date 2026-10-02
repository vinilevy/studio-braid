import { execFile } from 'node:child_process';
import { BridgeError } from '@screen-studio-bridge/core';

const execute = (binary: string, args: string[], timeout = 600_000): Promise<string> => new Promise((ok, fail) => {
  execFile(binary, args, { shell: false, windowsHide: true, timeout, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      // macOS user cancellation is error -128. Windows/Linux dialogs below exit 0/1 on cancel.
      if (/\(-128\)/u.test(stderr) || (process.platform === 'linux' && error.code === 1)) return ok('');
      return fail(new BridgeError('SYSTEM_DIALOG_FAILED', 'Não foi possível abrir o diálogo local. Use o caminho absoluto.', 503));
    }
    ok(stdout.trim());
  });
});
export async function pickInput(kind: 'folder' | 'zip'): Promise<string | null> {
  if (process.platform === 'darwin') {
    const script = kind === 'folder' ? 'POSIX path of (choose folder with prompt "Selecione o projeto .screenstudio" with showing package contents)' : 'POSIX path of (choose file with prompt "Selecione o projeto .screenstudio.zip" of type {"zip"})';
    return await execute('/usr/bin/osascript', ['-e', script]) || null;
  }
  if (process.platform === 'win32') {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; ' + (kind === 'folder'
      ? '$d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description="Selecione o projeto .screenstudio"; if($d.ShowDialog() -eq "OK"){[Console]::Write($d.SelectedPath)}'
      : '$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter="Screen Studio ZIP|*.zip"; if($d.ShowDialog() -eq "OK"){[Console]::Write($d.FileName)}');
    return await execute('powershell.exe', ['-NoProfile', '-STA', '-Command', script]) || null;
  }
  return await execute('zenity', ['--file-selection', ...(kind === 'folder' ? ['--directory'] : ['--file-filter=*.zip'])]) || null;
}
export async function openOutput(path: string): Promise<void> {
  // Path is taken ONLY from a completed job snapshot, never an HTTP argument.
  if (process.platform === 'darwin') { await execute('/usr/bin/open', [path], 10_000); return; }
  if (process.platform === 'win32') { await execute('explorer.exe', [path], 10_000); return; }
  await execute('xdg-open', [path], 10_000);
}
