import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve, join } from 'node:path';

const source = import.meta.url;
const output = process.argv[2];
if (!output) throw new Error('Usage: node build.mjs <output directory>');
const destination = resolve(output);
const read = file => readFile(new URL(file, source), 'utf8');
const manifest = JSON.parse(await read('manifest.json'));

const legacy = await read('../fleamarket-extension/core.js');
const config = legacy.split(/\r?\n/).filter(line => /^export const (API|PUBLIC_KEY)\s*=/.test(line));
if (config.length !== 2) throw new Error('Existing Supabase public configuration was not found.');

const estimates = stripTypeScriptTypes(await read('../../apps/admin/src/productEstimates.ts'));
const [style, panelStyle, amazon, shipping, markup, view, content] = await Promise.all(
  ['style.css', 'panel.css', 'amazon.js', 'shipping.js', 'catalog-markup.js', 'catalog-view.js', 'content.js'].map(read),
);
// Chrome loads a manifest content script as a classic script. Keep these local
// modules in a private scope and include their CSS at build time.
const sharedView = view.replace(/^import \{[\s\S]*?\} from '\.\/(?:product-estimates|shipping)\.js';\s*/gm, '');
const scripts = [estimates, amazon, shipping, markup, sharedView, content]
  .map(script => script.replace(/^export (?=(?:const|function) )/gm, ''));
const panelCss = style.replace(':root', ':host') + panelStyle;
const bundledContent = ['(() => {', ...scripts, 'mountAmazonCatalog(' + JSON.stringify(panelCss) + ');', '})();'].join('\n');

await mkdir(destination, { recursive: true });
await Promise.all([
  ...['background.js', 'amazon.js', 'shipping.js', 'catalog.js', 'catalog-markup.js', 'catalog-view.js', 'keepa.js', 'options.html', 'options.js', 'popup.html', 'popup.js', 'style.css']
    .map(file => copyFile(new URL(file, source), join(destination, file))),
  writeFile(join(destination, 'content.js'), bundledContent),
  writeFile(join(destination, 'build-version.js'), 'export const buildVersion = ' + JSON.stringify(manifest.version) + ';\n'),
  writeFile(join(destination, 'public-config.js'), config.join('\n') + '\n'),
  writeFile(join(destination, 'product-estimates.js'), estimates),
]);
// Publish the version only after all of its files are ready.
const pendingManifest = join(destination, 'manifest.json.pending');
await writeFile(pendingManifest, JSON.stringify(manifest, null, 2) + '\n');
await rename(pendingManifest, join(destination, 'manifest.json'));
