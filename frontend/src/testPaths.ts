import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Python interpreter used by the image tests (needs Pillow).
 * Order: COLORLAB_PYTHON, the repo's ../.venv, then `python3` on PATH.
 */
export function pythonBin(): string {
  if (process.env.COLORLAB_PYTHON) return process.env.COLORLAB_PYTHON;
  const venv = resolve('../.venv/bin/python');
  return existsSync(venv) ? venv : 'python3';
}

/**
 * Private camera photos are never committed. Point COLORLAB_REAL_PHOTO_DIR at the
 * folder that holds them to enable the tests that need them; without it (or when the
 * file is absent) this returns undefined and those tests are skipped.
 */
export function realPhotoPath(fileName: string): string | undefined {
  const dir = process.env.COLORLAB_REAL_PHOTO_DIR;
  if (!dir) return undefined;
  const path = resolve(dir, fileName);
  return existsSync(path) ? path : undefined;
}
