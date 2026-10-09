'use strict';

// Mount lifecycle of the usage tracker's UI on claude.ai: does it appear, does it stay, does it come
// back, and does it ever end up twice. The page is jsdom; the scripts are the extension's real ones
// (see helpers/content-env.js). Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, WEB_SIDEBAR, WEB_SIDEBAR_EMPTY_WRAPPER } = require('./helpers/content-env.cjs');

const SIDEBAR = '.ut-usage-sidebar';
const STAT_LINE = '#ut-chat-stat-line';

// Boots both UI actors and lets their async init() finish; frames are then driven by the test.
async function boot(options) {
	const env = createEnv(options);
	env.setConfig();
	await env.flush();
	await new Promise(resolve => setTimeout(resolve, 150)); // init() sleeps 100ms polling for CONFIG
	await env.flush();
	assert.ok(env.logs.some(l => l.text === 'UsageUI: Ready'), 'UsageUI should have finished init');
	assert.ok(env.logs.some(l => l.text === 'LengthUI: Ready'), 'LengthUI should have finished init');
	return env;
}

const count = (env, selector) => env.document.querySelectorAll(selector).length;

// ---- anchors -------------------------------------------------------------------------------------

test('control: the sidebar and stat line mount on the first frame when the page is ready', async () => {
	const env = await boot();
	await env.frame();
	assert.equal(count(env, SIDEBAR), 1);
	assert.equal(count(env, STAT_LINE), 1);
});

test('a sidebar whose scroll wrapper has no blocks yet reads as "not there yet", not as a crash', async () => {
	const env = await boot({ sidebar: WEB_SIDEBAR_EMPTY_WRAPPER });
	assert.doesNotThrow(() => env.run("LayoutManager.getAnchor('sidebar')"));
	assert.equal(env.run("LayoutManager.getAnchor('sidebar')"), null);
});

// ---- the loop that owns mounting ----------------------------------------------------------------

test('mounts once the sidebar appears, when the page started without it', async () => {
	const env = await boot({ sidebar: WEB_SIDEBAR_EMPTY_WRAPPER });
	await env.frame();
	assert.equal(count(env, SIDEBAR), 0, 'nothing to mount into yet');

	env.replaceSidebar(WEB_SIDEBAR);
	await env.frame();
	assert.equal(count(env, SIDEBAR), 1);
	assert.deepEqual(env.uncaught, []);
});

test('a data-dependent step that throws does not stop the UI from mounting', async () => {
	const env = await boot();
	// renderResetTimes() runs before the mount calls in UsageUI's tick and reads the usage data.
	env.run(`usageUI.state.usageData = { getActiveLimits() { throw new Error('bad usage data'); }, limits: {} }`);
	await env.frame();
	assert.equal(count(env, SIDEBAR), 1, 'the sidebar should mount regardless of the usage data');
	assert.equal(count(env, STAT_LINE), 1);
});

test('the loop survives a throwing step and remounts after React discards the sidebar', async () => {
	const env = await boot();
	env.run(`usageUI.state.usageData = { getActiveLimits() { throw new Error('bad usage data'); }, limits: {} }`);
	await env.frame();
	assert.ok(env.pendingFrames() > 0, 'the frame loop must still be scheduled');

	env.replaceSidebar(WEB_SIDEBAR); // navigation: the old sidebar and our section in it are gone
	assert.equal(count(env, SIDEBAR), 0);
	await env.frame();
	assert.equal(count(env, SIDEBAR), 1);
});

test('LengthUI keeps mounting its stat line after one of its steps throws', async () => {
	const env = await boot();
	env.run(`lengthUI.checkModelChange = async () => { throw new Error('picker exploded'); }`);
	const estimateMounted = () => env.run(`document.getElementById('ut-stat-right').contains(lengthUI.elements.statLine.estimate)`);

	// Two frames: LengthUI's tick comes first in a frame, and #ut-stat-right is UsageUI's to create.
	await env.frame();
	await env.frame();
	assert.ok(estimateMounted(), 'the stat line mounts even though a step before it throws');

	env.run(`lengthUI.elements.statLine.estimate.remove()`); // React re-rendered the composer
	await env.frame();
	assert.ok(estimateMounted(), 'and the loop is still running to put it back');
});

// ---- navigation, hidden tabs, duplicates ----------------------------------------------------------

test('never mounts twice, however many frames pass or times the sidebar is re-rendered', async () => {
	const env = await boot();
	for (let i = 0; i < 5; i++) await env.frame();
	env.replaceSidebar(WEB_SIDEBAR);
	for (let i = 0; i < 3; i++) await env.frame();
	env.replaceSidebar(WEB_SIDEBAR);
	await env.frame();
	assert.equal(count(env, SIDEBAR), 1);
	assert.equal(count(env, STAT_LINE), 1);
});

test('a tab that was hidden remounts on its first visible frame', async () => {
	const env = await boot();
	await env.frame();
	// Hidden: the browser stops delivering animation frames, so nothing runs while claude.ai re-renders.
	env.replaceSidebar(WEB_SIDEBAR);
	assert.equal(count(env, SIDEBAR), 0);
	assert.ok(env.pendingFrames() > 0, 'the next frame is queued, waiting for the tab to be shown');

	await env.frame(10 * 60 * 1000); // shown again, ten minutes later
	assert.equal(count(env, SIDEBAR), 1);
});

// ---- diagnosing a missing UI --------------------------------------------------------------------

test('an anchor missing for a while is logged once, and again when it returns - not every tick', async () => {
	const env = await boot({ sidebar: WEB_SIDEBAR_EMPTY_WRAPPER });
	const missing = () => env.logsAt('warn').filter(text => text.includes('"sidebar"') && text.includes('not found'));

	await env.frame();
	assert.equal(missing().length, 0, 'still within the time a page legitimately takes to render');

	env.advanceClock(6000);
	for (let i = 0; i < 5; i++) await env.frame();
	assert.equal(missing().length, 1, `expected exactly one warning, got: ${JSON.stringify(env.logsAt('warn'))}`);

	env.replaceSidebar(WEB_SIDEBAR);
	await env.frame();
	assert.equal(env.logs.filter(l => l.text.includes('"sidebar"') && l.text.includes('found again')).length, 1);
});

test('an anchor function that throws is reported once and treated as missing', async () => {
	const env = await boot();
	env.run(`pageLayouts.chat.anchors.sidebar = () => { throw new Error('selector drift'); }`);
	for (let i = 0; i < 4; i++) await env.frame();
	assert.equal(env.logsAt('error').filter(text => text.includes('selector drift') || text.includes('"sidebar" anchor failed')).length, 1);
	assert.deepEqual(env.uncaught, []);
});

test('a step that keeps failing is logged when it first fails, not once per frame', async () => {
	const env = await boot();
	env.run(`usageUI.state.usageData = { getActiveLimits() { throw new Error('bad usage data'); }, limits: {} }`);
	const failures = () => env.logsAt('error').filter(text => text.includes('bad usage data'));

	await env.frame();
	const afterFirstFrame = failures().length;
	assert.ok(afterFirstFrame > 0, 'the failure must be visible in the log');

	for (let i = 0; i < 5; i++) await env.frame();
	assert.equal(failures().length, afterFirstFrame, 'repeats of the same failure are not logged again');
});
