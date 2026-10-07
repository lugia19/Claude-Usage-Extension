// ESLint: the shared config (common/eslint.base.cjs). Cross-file globals are derived from the
// manifests, the popup's <script> tags and the background's import graph, so no /* global */ lists.
const { baseConfig, manifestGroups, htmlGroups, moduleGroup } = require('./common/eslint.base.cjs');

module.exports = baseConfig({
	root: __dirname,
	groups: [
		// injections/webrequest-polyfill.js is injected into the page by a <script> tag
		// (electron_reciever.js), so it shares the MAIN world with the MAIN content scripts.
		...['manifest_chrome.json', 'manifest_firefox.json', 'manifest_electron.json']
			.flatMap(m => manifestGroups(__dirname, m))
			.map(g => (g.name.endsWith('(MAIN)') ? { ...g, files: [...g.files, 'injections/webrequest-polyfill.js'] } : g)),
		...htmlGroups(__dirname, ['popup.html']),
		moduleGroup(__dirname, 'background.js'),
	],
	libGlobals: { 'lib/o200k_base.js': ['GPTTokenizer_o200k_base'] },
	modules: ['background.js', 'bg-components/**/*.js', 'shared/**/*.js'],
	ignores: ['lib/**'],
});
