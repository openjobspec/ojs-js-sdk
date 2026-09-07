import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esmRoot = path.join(root, 'dist', 'esm');
const cjsRoot = path.join(root, 'dist', 'cjs');
let generated = 0;

removeDeclarations(cjsRoot);

for (const declarationPath of discoverDeclarations(esmRoot)) {
  const relative = path.relative(esmRoot, declarationPath);
  const destination = path.join(
    cjsRoot,
    relative.replace(/\.d\.ts$/, '.d.cts'),
  );
  const declaration = readFileSync(declarationPath, 'utf8')
    .replaceAll(/(from\s+['"]|import\(['"])(\.[^'"]+)\.js(['"]\)?)/g, '$1$2.cjs$3')
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, declaration);
  generated += 1;
}

console.log(`Generated ${generated} CommonJS declaration files.`);

function discoverDeclarations(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return discoverDeclarations(entryPath);
    return entry.name.endsWith('.d.ts') ? [entryPath] : [];
  });
}

function removeDeclarations(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removeDeclarations(entryPath);
    } else if (entry.name.endsWith('.d.cts')) {
      rmSync(entryPath);
    }
  }
}
