/*
 * Mirrors the repo into debug/chrome, debug/firefox and debug/electron, giving each
 * folder its own manifest.json copied from the matching manifest_<target>.json, so all
 * three can be loaded unpacked at the same time.
 *
 * These have to be real copies. Symlinks/junctions do not work: Chrome resolves each
 * file's real path and refuses to serve anything rooted outside the extension folder
 * (the extension loads but nothing inside it resolves), and Firefox follows the linked
 * manifest.json and re-roots the extension at the repo.
 *
 *   node scripts/mirror-debug.js            one-shot sync
 *   node scripts/mirror-debug.js --watch    sync, then re-sync on every save
 *
 * Syncing is incremental (size + mtime) and prunes files that no longer exist in the
 * repo, so a re-run after adding, editing or deleting files is cheap and exact.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const debugDir = path.join(rootDir, 'debug');
const targets = ['chrome', 'firefox', 'electron'];

// Folders that are never part of the extension. 'debug' must stay here or the mirror
// would recurse into itself.
const excludedDirs = new Set(['.git', 'node_modules', 'web-ext-artifacts', 'debug', 'scripts']);

const isExcludedDir = (name) => excludedDirs.has(name) || name.startsWith('.');

// Dotfiles, art sources and build outputs aren't referenced by any manifest, and the
// .psd files in particular are big enough to make a full copy noticeably slow.
const isExcludedFile = (name) =>
	name.startsWith('.') ||
	/\.(psd|zip)$/i.test(name) ||
	// Each target gets its own manifest.json written from manifest_<target>.json.
	/^manifest.*\.json$/i.test(name);

const isTargetManifest = (name) => /^manifest_.*\.json$/i.test(name);

let copied = 0;
let removed = 0;

function syncDir(srcDir, dstDir, isRoot) {
	fs.mkdirSync(dstDir, { recursive: true });

	const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true })
		.filter(e => (e.isDirectory() ? !isExcludedDir(e.name) : !isExcludedFile(e.name)));
	const keep = new Set(srcEntries.map(e => e.name));

	// Prune first: anything the repo no longer has. The generated manifest.json lives
	// only in the debug folder, so it must survive the sweep.
	for (const entry of fs.readdirSync(dstDir, { withFileTypes: true })) {
		if (keep.has(entry.name)) continue;
		if (isRoot && entry.name === 'manifest.json') continue;
		fs.rmSync(path.join(dstDir, entry.name), { recursive: true, force: true });
		removed++;
	}

	for (const entry of srcEntries) {
		const src = path.join(srcDir, entry.name);
		const dst = path.join(dstDir, entry.name);

		if (entry.isDirectory()) {
			syncDir(src, dst, false);
			continue;
		}

		const srcStat = fs.statSync(src);
		let dstStat = null;
		try { dstStat = fs.statSync(dst); } catch { /* not there yet */ }

		if (dstStat && dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) continue;

		fs.copyFileSync(src, dst);
		copied++;
	}
}

function sync() {
	copied = 0;
	removed = 0;

	for (const target of targets) {
		const manifest = path.join(rootDir, `manifest_${target}.json`);
		if (!fs.existsSync(manifest)) {
			console.warn(`No manifest_${target}.json - skipping ${target}.`);
			continue;
		}

		const dst = path.join(debugDir, target);
		syncDir(rootDir, dst, true);

		// Cheap enough to rewrite every sync, and it keeps the manifest honest if the
		// source manifest_<target>.json was the thing that changed.
		fs.copyFileSync(manifest, path.join(dst, 'manifest.json'));
	}

	return { copied, removed };
}

const stamp = () => new Date().toLocaleTimeString();

const first = sync();
console.log(`[${stamp()}] debug/{${targets.join(',')}} synced - ${first.copied} copied, ${first.removed} removed`);

if (process.argv.includes('--watch')) {
	// Debounced full re-sync: editors touch a file several times per save, and a full
	// sync is cheap because it only copies what actually changed.
	let pending = null;

	fs.watch(rootDir, { recursive: true }, (_event, filename) => {
		if (!filename) return;

		const parts = filename.split(path.sep);
		const base = parts[parts.length - 1];

		if (parts.slice(0, -1).some(isExcludedDir)) return;
		// manifest_<target>.json isn't copied as-is, but it must still trigger a re-sync.
		if (isExcludedFile(base) && !isTargetManifest(base)) return;

		clearTimeout(pending);
		pending = setTimeout(() => {
			try {
				const r = sync();
				if (r.copied || r.removed) {
					console.log(`[${stamp()}] ${filename} -> ${r.copied} copied, ${r.removed} removed`);
				}
			} catch (err) {
				console.error(`[${stamp()}] sync failed: ${err.message}`);
			}
		}, 150);
	});

	console.log('Watching for changes - Ctrl+C to stop.');
} else {
	console.log('Chrome  : chrome://extensions -> Load unpacked -> debug\\chrome');
	console.log('Firefox : about:debugging -> Load Temporary Add-on -> debug\\firefox\\manifest.json');
}
