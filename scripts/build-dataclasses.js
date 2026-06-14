const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

// Shared ES6 modules that need a content-script (plain globals) twin generated.
// Each entry: { src, out, pragma } — same regex transform for all of them.
const targets = [
	{
		src: path.join('shared', 'dataclasses.js'),
		out: path.join('content-components', 'ui_dataclasses.js'),
		pragma: '/* global CONFIG */'
	},
	{
		src: path.join('shared', 'localization.js'),
		out: path.join('content-components', 'localization.js'),
		pragma: '/* Generated from shared/localization.js by scripts/build-dataclasses.js — do not edit. */'
	}
];

for (const { src, out, pragma } of targets) {
	const source = fs.readFileSync(path.join(rootDir, src), 'utf8');

	// Transform ES6 module → content script globals
	const contentVersion = source
		// Remove import statements
		.replace(/^import\s+.*?;\s*\n/gm, '')
		// Remove export keywords
		.replace(/^export\s+/gm, '')
		// Add global pragma and 'use strict' at top
		.replace(/^/, `${pragma}\n'use strict';\n\n`);

	fs.writeFileSync(path.join(rootDir, out), contentVersion);
	console.log(`Generated ${out.split(path.sep).join('/')}`);
}
