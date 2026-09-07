import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(
  readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
);
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
if (lock.version !== pkg.version || lock.packages['']?.version !== pkg.version) {
  throw new Error('package.json and package-lock.json versions do not match');
}
if (!changelog.includes(`## [${pkg.version}]`)) {
  throw new Error(`CHANGELOG.md has no ${pkg.version} release heading`);
}
const specifiers = Object.keys(pkg.exports).map((subpath) =>
  subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`,
);
const integrationPeers = [
  '@grpc/grpc-js',
  '@grpc/proto-loader',
  '@opentelemetry/api',
].map((name) => `${name}@${pkg.devDependencies[name]}`);
let tarball;
const temp = path.join(root, '.package-smoke');

try {
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  const dryRun = JSON.parse(run('npm', ['pack', '--dry-run', '--json'], root));
  assertPackTargets(dryRun[0]?.files ?? []);

  const packed = JSON.parse(run('npm', ['pack', '--json'], root));
  tarball = path.join(root, packed[0].filename);

  writeFileSync(
    path.join(temp, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
      ...integrationPeers,
    ],
    temp,
  );

  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await Promise.all(${JSON.stringify(specifiers)}.map((id) => import(id)));`,
    ],
    temp,
  );
  run(
    process.execPath,
    [
      '--input-type=commonjs',
      '--eval',
      `for (const id of ${JSON.stringify(specifiers)}) require(id);`,
    ],
    temp,
  );

  const imports = specifiers
    .map((specifier, index) => `import * as entry${index} from '${specifier}';`)
    .join('\n');
  const uses = `void [${specifiers.map((_, index) => `entry${index}`).join(', ')}];\n`;
  writeFileSync(path.join(temp, 'consumer.ts'), `${imports}\n${uses}`);
  const cjsImports = specifiers
    .map(
      (specifier, index) =>
        `import entry${index} = require('${specifier}');`,
    )
    .join('\n');
  writeFileSync(path.join(temp, 'consumer.cts'), `${cjsImports}\n${uses}`);
  writeFileSync(
    path.join(temp, 'tsconfig.node.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ['consumer.ts'],
    }),
  );
  writeFileSync(
    path.join(temp, 'tsconfig.browser.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ['consumer.ts'],
    }),
  );
  // Classic TypeScript resolution: `module: CommonJS` + `moduleResolution:
  // node` ignores the package `exports` map entirely and resolves subpath
  // declarations via `typesVersions` + physical layout. This guards the
  // typesVersions mappings for consumers still on the classic algorithm.
  writeFileSync(
    path.join(temp, 'tsconfig.classic.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'node',
        esModuleInterop: true,
        lib: ['ES2022', 'DOM'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ['consumer.ts'],
    }),
  );
  for (const moduleKind of ['Node16', 'NodeNext']) {
    writeFileSync(
      path.join(temp, `tsconfig.cjs-${moduleKind.toLowerCase()}.json`),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: moduleKind,
          moduleResolution: moduleKind,
          lib: ['ES2022', 'DOM'],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['consumer.cts'],
      }),
    );
  }

  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '-p', 'tsconfig.node.json'], temp);
  run(process.execPath, [tsc, '-p', 'tsconfig.browser.json'], temp);
  run(process.execPath, [tsc, '-p', 'tsconfig.classic.json'], temp);
  run(process.execPath, [tsc, '-p', 'tsconfig.cjs-node16.json'], temp);
  run(process.execPath, [tsc, '-p', 'tsconfig.cjs-nodenext.json'], temp);

  console.log(
    `Verified ${specifiers.length} package entry points under ESM/CJS runtime, ESM types, Node16/NodeNext CJS types, browser types, and classic types.`,
  );
} finally {
  if (tarball) rmSync(tarball, { force: true });
  rmSync(temp, { recursive: true, force: true });
}

function assertPackTargets(files) {
  const packed = new Set(files.map((file) => file.path));
  for (const target of Object.values(pkg.exports)) {
    for (const branch of [target.import, target.require]) {
      for (const file of [branch.types, branch.default]) {
        const packedPath = file.replace(/^\.\//, '');
        if (!packed.has(packedPath)) {
          throw new Error(`npm pack --dry-run omitted export target: ${packedPath}`);
        }
      }
    }
  }
  if (!packed.has('dist/cjs/package.json')) {
    throw new Error('npm pack --dry-run omitted dist/cjs/package.json');
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}
