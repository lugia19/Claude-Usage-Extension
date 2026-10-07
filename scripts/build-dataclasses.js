const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

// Shared ES6 modules that need a content-script (plain globals) twin generated.
// Each entry: { src, out } — same regex transform for all of them. No /* global */ pragma: ESLint
// derives the twin's globals from the manifests (common/eslint.base.cjs).
const targets = [
	{
		src: path.join('shared', 'dataclasses.js'),
		out: path.join('content-components', 'ui_dataclasses.js')
	}
];

for (const { src, out } of targets) {
	const source = fs.readFileSync(path.join(rootDir, src), 'utf8');

	// Transform ES6 module → content script globals
	const contentVersion = source
		// Remove import statements
		.replace(/^import\s+.*?;\s*\n/gm, '')
		// Remove export keywords
		.replace(/^export\s+/gm, '')
		// Add 'use strict' at top
		.replace(/^/, `'use strict';\n\n`);

	fs.writeFileSync(path.join(rootDir, out), contentVersion);
	console.log(`Generated ${out.split(path.sep).join('/')}`);
}
