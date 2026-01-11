const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const sourceFile = path.join(rootDir, 'shared', 'dataclasses.js');
const outputFile = path.join(rootDir, 'content-components', 'ui_dataclasses.js');

// Read source file
const source = fs.readFileSync(sourceFile, 'utf8');

// Transform ES6 module → content script globals
const contentVersion = source
	// Remove import statements
	.replace(/^import\s+.*?;\s*\n/gm, '')
	// Remove export keywords
	.replace(/^export\s+/gm, '')
	// Add global pragma and 'use strict' at top
	.replace(/^/, '/* global CONFIG */\n\'use strict\';\n\n');

// Write output file
fs.writeFileSync(outputFile, contentVersion);

console.log('Generated content-components/ui_dataclasses.js');
