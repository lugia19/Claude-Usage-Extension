// Daily UI checks against the live claude.ai: does the tracker still mount where it should, showing
// real values, in the right language? claude.ai's DOM changes break the anchors silently (2026-11:
// the composer box's colour class changed and the message-bar stat line vanished), so this runs
// headless every day and opens a report in VS Code when something broke. Nothing is sent: every
// check only reads the page.
//
//   node scripts/ui-tests.mjs               run now; on failure write a report and print its path
//   node scripts/ui-tests.mjs --open        same, and open the report in VS Code
//   node scripts/ui-tests.mjs --scheduled   the Task Scheduler entry (scripts/register-ui-tests-task.ps1):
//                                           at most one completed run a day, debug\ synced first,
//                                           the report opened in VS Code on failure
//
// Needs the harness profile (scripts/chrome-harness.mjs) and a test conversation in
// %LOCALAPPDATA%\ChromeDebug\ui-tests.json: { "testConversation": "<uuid>" }.
//
// Exit codes: 0 pass, 1 a check failed, 2 setup error (profile, login, Cloudflare, config),
// 3 skipped (the profile is open in another Chrome).

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { HARNESS_DIR, HarnessError, launchChrome } from './chrome-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(HARNESS_DIR, 'ui-tests.json');
const STAMP_FILE = path.join(HARNESS_DIR, 'ui-tests.last-run');
const REPORTS_DIR = path.join(HARNESS_DIR, 'reports');
const KEEP_REPORTS = 30;
const CHECK_TIMEOUT_MS = 20000;
const PAGE_TIMEOUT_MS = 30000;

const INPUT_SELECTOR = '[data-testid="chat-input"], [data-testid="code-prompt-input"]';

// ---- Page-side checks ----
// Each runs in the page (MAIN world: it only reads the DOM) and returns { pass, reason, context }.
// `context` is an ancestor chain from the nearest page landmark, for fixing a broken anchor.

const PAGE_HELPERS = `
	const chainOf = (el, depth = 12) => {
		const out = [];
		for (let n = el, i = 0; n && n !== document.documentElement && i < depth; n = n.parentElement, i++) {
			const cls = typeof n.className === 'string' ? n.className.trim().slice(0, 220) : '';
			const testid = n.dataset?.testid ? '[data-testid="' + n.dataset.testid + '"]' : '';
			out.push(n.tagName.toLowerCase() + testid + (cls ? ' .' + cls : ''));
		}
		return out;
	};
	const isVisible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
	const fail = (reason, el) => ({ pass: false, reason, context: el ? chainOf(el) : null });
	const PASS = { pass: true };
`;

// The page loaded as a logged-in claude.ai page with a composer. null while still loading.
const sanityCheck = `(() => {
	if (/just a moment/i.test(document.title)) return null;
	if (location.pathname.startsWith('/login')) return { state: 'login', url: location.href };
	if (document.querySelector(${JSON.stringify(INPUT_SELECTOR)})) return { state: 'ok' };
	return null;
})()`;

// The extension's real string tables and normalizeLocale(), loaded here so the language check
// predicts the UI language exactly as the content script resolves it.
function loadI18n() {
	const ctx = vm.createContext({});
	for (const file of ['common/i18n/all.js', 'i18n/all.js', 'common/i18n/i18n-core.js']) {
		vm.runInContext(fs.readFileSync(path.join(REPO, file), 'utf8'), ctx, { filename: file });
	}
	return ctx;
}
const i18n = loadI18n();

const checks = {
	// The tracker's language follows claude.ai's: the language override if one is set, else the
	// page's own language (<html lang>, which the account locale cache should agree with). A
	// language with no table falls back to English, on purpose; the note says so.
	language: `(() => { ${PAGE_HELPERS}
		const I18N_LOCALES = ${JSON.stringify(i18n.I18N_LOCALES)};
		const normalizeLocale = ${i18n.normalizeLocale.toString()};
		const HEADERS = ${JSON.stringify(Object.fromEntries(i18n.I18N_LOCALES.map(l => [l, i18n.translate(l, 'usage.header')])))};
		const el = document.querySelector('.ut-usage-sidebar .ut-usage-toggle h3');
		if (!el) return fail('sidebar header not mounted', document.querySelector('.ut-usage-sidebar'));
		const pageLang = document.documentElement.lang;
		if (!pageLang) return fail('claude.ai set no <html lang>', null);
		const override = localStorage.getItem('claude_ext_language');
		const expected = normalizeLocale(override || pageLang);
		const actual = el.textContent.trim();
		const shown = Object.keys(HEADERS).filter(l => HEADERS[l] === actual);
		if (actual !== HEADERS[expected]) {
			let cache = null;
			try { cache = JSON.parse(localStorage.getItem('claude_ext_locale_cache'))?.locale; } catch (e) { /* bad JSON */ }
			return fail('expected ' + expected + ' (' + JSON.stringify(HEADERS[expected]) + ') for page lang ' + pageLang
				+ (override ? ', override ' + override : '') + ', got ' + JSON.stringify(actual)
				+ (shown.length ? ' (' + shown.join('/') + ')' : '') + '; account locale cache: ' + cache, el);
		}
		const supported = normalizeLocale(pageLang) !== 'en' || pageLang.toLowerCase().split('-')[0] === 'en';
		if (!override && !supported) return { pass: true, note: 'claude.ai is in ' + pageLang + ', which has no table: the tracker falls back to English' };
		return { pass: true, note: 'tracker in ' + expected + (override ? ' (override)' : '') };
	})()`,

	sidebar: `(() => { ${PAGE_HELPERS}
		const sidebar = document.querySelector('aside.dframe-sidebar') || document.querySelector('nav');
		const el = document.querySelector('.ut-usage-sidebar');
		if (!el) return fail('not mounted', sidebar?.querySelector('a[href]') || sidebar);
		if (!el.closest('aside.dframe-sidebar, nav')) return fail('mounted outside the sidebar', el);
		if (!isVisible(el)) return fail('mounted but not visible (zero size)', el);
		const rows = [...el.querySelectorAll('.ut-limit-row')];
		if (!rows.some(r => /\\d+%/.test(r.innerText))) return fail('no limit row shows a percentage (' + rows.length + ' rows)', el);
		return PASS;
	})()`,

	statLine: `(() => { ${PAGE_HELPERS}
		const input = document.querySelector(${JSON.stringify(INPUT_SELECTOR)});
		const line = document.getElementById('ut-chat-stat-line');
		if (!line || !line.isConnected) return fail('not mounted', input);
		const box = input.closest('.rounded-composer, .bg-surface-3');
		if (!box) return fail('composer box not found around the input (rounded-composer / bg-surface-3)', input);
		if (!box.contains(line)) return fail('mounted outside the composer box', line);
		if (!isVisible(line)) return fail('mounted but not visible (zero size)', line);
		const lr = line.getBoundingClientRect(), ir = input.getBoundingClientRect();
		if (lr.top < ir.bottom - 2) return fail('not below the input (line top ' + Math.round(lr.top) + ', input bottom ' + Math.round(ir.bottom) + ')', line);
		if (lr.bottom > innerHeight + 1 || lr.top < 0) return fail('outside the viewport (top ' + Math.round(lr.top) + ', viewport ' + innerHeight + ')', line);
		if (!/\\d+%/.test(line.innerText)) return fail('no usage percentage: ' + JSON.stringify(line.innerText), line);
		return PASS;
	})()`,

	titleLine: `(() => { ${PAGE_HELPERS}
		const el = document.querySelector('.ut-title-stats');
		const title = document.querySelector('[data-testid="session-title-split"], [data-testid="chat-title-split"]');
		if (!el || !el.isConnected) return fail('not mounted', title);
		if (!isVisible(el)) return fail('mounted but not visible (zero size)', el);
		const r = el.getBoundingClientRect();
		if (r.top > 200) return fail('not near the top of the page (top ' + Math.round(r.top) + ')', el);
		const numbers = el.innerText.match(/\\d[\\d.,]*/g) || [];
		if (numbers.length < 2) return fail('no length and cost figures: ' + JSON.stringify(el.innerText), el);
		return PASS;
	})()`,
};

const PAGES = conversationId => [
	{ name: 'home', url: 'https://claude.ai/new', checks: ['sidebar', 'statLine', 'language'] },
	{ name: 'conversation', url: `https://claude.ai/chat/${conversationId}`, checks: ['sidebar', 'statLine', 'titleLine'] },
	{ name: 'code', url: 'https://claude.ai/code', checks: ['sidebar', 'statLine'] },
	// Incognito is a full-screen page with no sidebar (2026-11). Its title line needs a sent message.
	{ name: 'incognito', url: 'https://claude.ai/new?incognito', checks: ['statLine'] },
];

// ---- Running ----

class SetupError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Polls a check until it passes; on timeout returns its last failure.
async function runCheck(page, expr) {
	const end = Date.now() + CHECK_TIMEOUT_MS;
	let last = { pass: false, reason: 'never evaluated' };
	while (Date.now() < end) {
		try {
			last = await page.evaluate(expr);
		} catch (e) {
			last = { pass: false, reason: `evaluation threw: ${e.message}` };
		}
		if (last?.pass) return last;
		await sleep(400);
	}
	return last;
}

function readConfig() {
	let config;
	try {
		config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
	} catch {
		throw new SetupError(`No usable config at ${CONFIG_FILE}. Create a short dedicated chat on claude.ai, then write { "testConversation": "<its uuid>" } there.`);
	}
	if (!/^[0-9a-f-]{36}$/i.test(config.testConversation || '')) {
		throw new SetupError(`${CONFIG_FILE}: "testConversation" must be a conversation uuid.`);
	}
	return config;
}

async function runAll(shotDir) {
	const config = readConfig();
	const results = [];
	const chrome = await launchChrome();
	try {
		const page = await chrome.openPage();
		for (const def of PAGES(config.testConversation)) {
			const pageResult = { ...def, results: [], screenshot: null };
			results.push(pageResult);
			try {
				await page.navigate(def.url, { timeoutMs: PAGE_TIMEOUT_MS });
			} catch (e) {
				pageResult.error = `navigation failed: ${e.message}`;
				continue;
			}
			const sanity = await page.waitFor(sanityCheck, { timeoutMs: PAGE_TIMEOUT_MS, intervalMs: 500 });
			if (!sanity) {
				const title = await page.evaluate('document.title').catch(() => '?');
				await saveShot(page, shotDir, pageResult);
				pageResult.error = `the page never showed a composer (title "${title}")`;
				throw new SetupError(`${def.name}: the page never showed a composer (title "${title}"). A Cloudflare challenge, claude.ai is down, or the page's input changed.`);
			}
			if (sanity.state === 'login') {
				pageResult.error = 'redirected to login';
				throw new SetupError(`Not logged in (${sanity.url}). Run: node scripts/chrome-harness.mjs login`);
			}

			for (const name of def.checks) {
				pageResult.results.push({ name, ...await runCheck(page, checks[name]) });
			}
			if (pageResult.results.some(r => !r.pass)) await saveShot(page, shotDir, pageResult);
		}
	} catch (e) {
		// Keep what the earlier pages found (and this page's screenshot) for the report: a later
		// page failing its sanity check is as likely a changed page as a setup problem.
		if (e instanceof SetupError) e.results = results;
		throw e;
	} finally {
		await chrome.close();
	}
	return results;
}

async function saveShot(page, shotDir, pageResult) {
	try {
		fs.mkdirSync(shotDir, { recursive: true });
		const file = path.join(shotDir, `${pageResult.name}.png`);
		await page.screenshot(file);
		pageResult.screenshot = file;
	} catch { /* a missing screenshot shouldn't hide the failure */ }
}

// ---- Report ----

function gitState() {
	const git = (...args) => { try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim(); } catch { return '?'; } };
	const dirty = git('status', '--porcelain');
	return `${git('rev-parse', '--abbrev-ref', 'HEAD')} @ ${git('rev-parse', '--short', 'HEAD')}${dirty && dirty !== '?' ? ` (uncommitted changes: ${dirty.split('\n').length} files)` : ''}`;
}

function writeReport(stamp, { results, setupError, crash }) {
	const lines = [`# Usage Tracker UI checks: ${setupError ? 'SETUP ERROR' : 'FAILED'}`, '',
		`- When: ${new Date().toLocaleString()}`, `- Tree: ${gitState()}`, ''];
	if (setupError) lines.push('## Setup error', '', setupError, '');
	if (crash) lines.push('## The run crashed', '', '```', crash, '```', '');
	for (const p of results || []) {
		const bad = p.error || p.results.some(r => !r.pass);
		lines.push(`## ${bad ? '❌' : '✅'} ${p.name}: ${p.url}`, '');
		if (p.error) lines.push(`- ${p.error}`);
		for (const r of p.results) lines.push(`- ${r.pass ? '✅' : '❌'} **${r.name}**${r.pass ? '' : `: ${r.reason}`}`);
		if (p.screenshot) lines.push('', `![${p.name}](${path.relative(REPORTS_DIR, p.screenshot).replaceAll('\\', '/')})`);
		lines.push('');
		for (const r of p.results.filter(x => !x.pass && x.context)) {
			lines.push(`<details><summary>${r.name}: DOM context (innermost first)</summary>`, '', '```', ...r.context, '```', '</details>', '');
		}
	}
	fs.mkdirSync(REPORTS_DIR, { recursive: true });
	const file = path.join(REPORTS_DIR, `${stamp}.md`);
	fs.writeFileSync(file, lines.join('\n'));
	pruneReports();
	return file;
}

function pruneReports() {
	const reports = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort();
	for (const f of reports.slice(0, -KEEP_REPORTS)) {
		fs.rmSync(path.join(REPORTS_DIR, f), { force: true });
		fs.rmSync(path.join(REPORTS_DIR, f.slice(0, -3)), { recursive: true, force: true });
	}
}

function openInVsCode(file) {
	const fallback = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
	const code = fs.existsSync(fallback) ? fallback : 'code';
	// A .cmd needs a shell to run; detached so a scheduled run can exit while VS Code stays open.
	spawn('cmd.exe', ['/d', '/c', code, file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Brings debug\chrome in line with the checked-out tree before a scheduled run.
function syncDebug() {
	try {
		execFileSync(process.execPath, ['common/scripts/mirror-debug.js'], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
	} catch (e) {
		const output = `${e.stderr || ''}${e.stdout || ''}`.trim();
		throw new SetupError(`Syncing debug\\ failed (common/scripts/mirror-debug.js): ${output || e.message}`);
	}
}

// ---- Main ----

const localDate = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD
const fileStamp = () => new Date().toLocaleString('sv').replace(' ', '_').replaceAll(':', '').slice(0, 15); // YYYY-MM-DD_HHmm

async function main() {
	const scheduled = process.argv.includes('--scheduled');
	const open = scheduled || process.argv.includes('--open');

	if (scheduled) {
		const last = fs.existsSync(STAMP_FILE) ? fs.readFileSync(STAMP_FILE, 'utf8').trim() : '';
		if (last === localDate()) return 0;
	}

	const stamp = fileStamp();
	const shotDir = path.join(REPORTS_DIR, stamp);
	let outcome;
	try {
		// Inside the try, so a failed sync is reported like any other setup error rather than
		// silently failing every hourly retry.
		if (scheduled) syncDebug();
		const results = await runAll(shotDir);
		const failed = results.some(p => p.error || p.results.some(r => !r.pass));
		for (const p of results) {
			console.log(`${p.name}: ${p.error || p.results.map(r => `${r.pass ? 'ok' : 'FAIL'} ${r.name}${r.pass ? (r.note ? ` (${r.note})` : '') : ` (${r.reason})`}`).join(', ')}`);
		}
		outcome = failed ? { code: 1, report: { results } } : { code: 0 };
	} catch (e) {
		if (e instanceof HarnessError && e.code === 3) {
			console.log(e.message);
			return 3; // no stamp: a later trigger retries
		}
		const setup = e instanceof SetupError || e instanceof HarnessError;
		console.error(setup ? `Setup error: ${e.message}` : e.stack);
		outcome = { code: setup ? 2 : 1, report: setup ? { setupError: e.message, results: e.results } : { crash: e.stack } };
	}

	if (scheduled) {
		fs.mkdirSync(HARNESS_DIR, { recursive: true });
		fs.writeFileSync(STAMP_FILE, localDate());
	}
	if (outcome.report) {
		const file = writeReport(stamp, outcome.report);
		console.log(`Report: ${file}`);
		if (open) openInVsCode(file);
	} else {
		console.log('All checks passed.');
	}
	return outcome.code;
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
