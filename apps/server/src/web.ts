import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export function webResponse(directory: string | undefined, pathname: string): Response | undefined {
  if (!directory || !existsSync(join(directory, 'index.html'))) return undefined;
  const root = realpathSync(directory);
  const candidate = resolve(root, `.${pathname}`);
  const inside = (file: string) => {
    const path = relative(root, file);
    return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
  };
  const target = inside(candidate) && existsSync(candidate) && statSync(candidate).isFile() && inside(realpathSync(candidate)) ? candidate : join(root, 'index.html');
  if (!inside(realpathSync(target))) return undefined;
  return new Response(readFileSync(target), { headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' } });
}
