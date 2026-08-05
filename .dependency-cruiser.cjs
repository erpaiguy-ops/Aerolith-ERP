/**
 * Module boundary enforcement.
 *
 * This file is what stops the modular monolith from quietly becoming a monolith.
 * See docs/02-architecture.md, "Boundary rules".
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-imports',
      severity: 'error',
      comment:
        'A module may not import another module. Communicate through published events ' +
        '(kernel/events) or a kernel-registered service contract instead.',
      from: { path: '^packages/modules/([^/]+)/' },
      to: {
        path: '^packages/modules/([^/]+)/',
        pathNot: ['^packages/modules/$1/'],
      },
    },
    {
      name: 'kernel-is-independent',
      severity: 'error',
      comment:
        'The kernel must not depend on any business module. If the kernel needs it, ' +
        'it belongs in the kernel.',
      from: { path: '^packages/kernel/' },
      to: { path: '^packages/modules/' },
    },
    {
      name: 'no-module-internals-from-apps',
      severity: 'error',
      comment:
        'Apps must consume a module through its package entry point, not by reaching ' +
        'into its source tree.',
      from: { path: '^apps/' },
      to: { path: '^packages/modules/[^/]+/src/(?!index)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make module extraction impossible later.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '(^|/)tsconfig\\.json$',
          // Tool configs are entry points for their own tooling, not orphans.
          '(^|/)(drizzle|vitest|eslint|next|postcss|tailwind)\\.config\\.(ts|js|mjs|cjs)$',
          // Next's file conventions are entry points too: the framework finds
          // them by name, so nothing imports them. A `not-found.tsx` that
          // renders one link has no local dependency either way.
          '(^|/)(page|layout|template|loading|error|not-found|route|middleware)\\.tsx?$',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: 'Production code must not import a devDependency.',
      from: { path: '^(packages|apps)/', pathNot: '\\.(spec|test)\\.ts$' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|dist|\\.next|drizzle/meta)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.ts', '.tsx', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
