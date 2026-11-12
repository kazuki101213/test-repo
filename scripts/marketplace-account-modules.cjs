const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const modules = {};
for (const name of ['constants', 'salesChannels', 'marketplaceAccounts', 'stateSearch']) {
  const source = fs.readFileSync(path.join(__dirname, '../packages/shared/src', name + '.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const context = { exports: {}, require: id => modules[id.slice(2)] };
  vm.runInNewContext(outputText, context);
  modules[name] = context.exports;
}

module.exports = { ...modules.marketplaceAccounts, ...modules.stateSearch };
