import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ExportTarget {
  import: { types: string; default: string };
  require: { types: string; default: string };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
) as {
  exports: Record<string, ExportTarget>;
  types: string;
  typesVersions: Record<string, Record<string, string[]>>;
};

const publicSubpaths = [
  '.',
  './middleware',
  './ml',
  './encryption',
  './otel',
  './subscribe',
  './serverless',
  './serverless/cloudflare',
  './serverless/vercel',
  './serverless/lambda',
  './agent',
  './attest',
  './recorder',
] as const;

describe('package exports', () => {
  it('should expose every documented public subpath for ESM, CJS, and types', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([...publicSubpaths].sort());

    for (const subpath of publicSubpaths) {
      const target = pkg.exports[subpath];
      expect(target, subpath).toBeDefined();
      expect(target.import.types).toMatch(/^\.\/dist\/esm\/.+\.d\.ts$/);
      expect(target.import.default).toMatch(/^\.\/dist\/esm\/.+\.js$/);
      expect(target.require.types).toMatch(/^\.\/dist\/cjs\/.+\.d\.cts$/);
      expect(target.require.default).toMatch(/^\.\/dist\/cjs\/.+\.js$/);
    }
  });

  it('should map every non-root subpath in typesVersions to its dist/esm declaration for classic node resolution', () => {
    // The `exports` conditional `types` fields only satisfy TypeScript's
    // modern (node16/nodenext/bundler) resolution. Classic `moduleResolution:
    // node` ignores `exports` and resolves subpath types via `typesVersions`
    // plus the physical layout, so every non-root subpath must appear there
    // pointing at the exact declaration its `exports` entry uses.
    const wildcard = pkg.typesVersions['*'];
    expect(wildcard, 'typesVersions["*"] should exist').toBeDefined();

    // Root is covered by the top-level `types` field, not typesVersions.
    expect(pkg.types).toMatch(/^\.\/dist\/esm\/index\.d\.ts$/);

    for (const subpath of publicSubpaths) {
      if (subpath === '.') continue;
      const key = subpath.slice(2); // strip leading './'
      const mapped = wildcard[key];
      expect(mapped, `typesVersions should map ${key}`).toBeDefined();
      expect(mapped).toEqual([pkg.exports[subpath].import.types]);
    }

    // typesVersions must not carry stale keys for removed subpaths.
    const expectedKeys = publicSubpaths
      .filter((subpath) => subpath !== '.')
      .map((subpath) => subpath.slice(2))
      .sort();
    expect(Object.keys(wildcard).sort()).toEqual(expectedKeys);
  });

  it('should point every export at a source entry that the build emits', () => {
    for (const target of Object.values(pkg.exports)) {
      for (const condition of [target.import.default, target.require.default]) {
        const sourcePath = condition
          .replace(/^\.\/dist\/(?:esm|cjs)\//, 'src/')
          .replace(/\.js$/, '.ts');
        expect(
          statSync(path.join(root, sourcePath)).isFile(),
          `${condition} should be emitted from ${sourcePath}`,
        ).toBe(true);
      }
    }
  });
});
