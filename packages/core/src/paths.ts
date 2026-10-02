import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BridgeError } from './errors.js';

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export function safeRelativePath(name: string): string {
  // Fail closed for Windows ADS/devices/UNC as well, even when executing on macOS.
  if (!name || /[\x00-\x1f\\:]/u.test(name) || name.startsWith('/') || isAbsolute(name))
    throw new BridgeError('UNSAFE_PATH', 'Caminho absoluto, de rede ou inválido no pacote.');
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$|[<>"|?*]/u.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p)))
    throw new BridgeError('UNSAFE_PATH', 'Caminho relativo inseguro no pacote.');
  return parts.join('/').normalize('NFC');
}
export async function confinedFile(root: string, path: string): Promise<string> {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]).catch(() => {
    throw new BridgeError('MISSING_FILE', `Arquivo obrigatório não encontrado: ${path}`);
  });
  if (!isWithin(realRoot, realFile) || !(await stat(realFile)).isFile())
    throw new BridgeError('UNSAFE_PATH', `Referência fora do pacote ou arquivo inválido: ${path}`);
  return realFile;
}
export function safeProjectName(name: string): string {
  return name.normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/gu, '_').replace(/[. ]+$/u, '').slice(0, 120) || 'Projeto';
}
