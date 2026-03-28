import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const getLocalTscEntrypoint = (repoRoot) => {
  const tscEntrypoint = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (!fs.existsSync(tscEntrypoint)) {
    throw new Error(`Cannot find local TypeScript compiler at ${tscEntrypoint}. Run npm install before running this script.`);
  }
  return tscEntrypoint;
};

export const runLocalTsc = (repoRoot, tscArgs) => {
  execFileSync(process.execPath, [getLocalTscEntrypoint(repoRoot), ...tscArgs], {
    cwd: repoRoot,
    stdio: 'inherit'
  });
};
