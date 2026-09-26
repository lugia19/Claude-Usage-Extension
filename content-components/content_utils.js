/* global createLogger, configureLogger, localize, fmtNum, getActiveOrgId, getConversationId, getIncognitoConversationId, isIncognito,
   isCodePage, currentLocale, pinLocale, refreshAccountLocale, getLanguageOverride,
   setLanguageOverride, createClaudeTooltip, isMobileLayout,
   modelFamilyFromVersion, MODEL_UNKNOWN */
'use strict';

// Constants
const BLUE_HIGHLIGHT = "#2c84db";
const RED_WARNING = "#de2929";
const SUCCESS_GREEN = "#22c55e";

const SELECTORS = {
	MODEL_PICKER: '[data-testid="model-selector-dropdown"]',
	CHAT_MENU: '[data-testid="chat-title-split"]',
	MODEL_SELECTOR: '[data-testid="model-selector-dropdown"]',
	INIT_LOGIN_SCREEN: 'button[data-testid="login-with-google"]',
	VERIF_LOGIN_SCREEN: 'input[data-testid="code"]'
};
// Global variables that will be shared across all content scripts
let CONFIG;

// Logging (common/log/logger.js): always on, to the console and the debug log viewer. Log(level?, ...args)
// keeps its old signature; the leading level argument is still accepted.
configureLogger({ app: 'tracker', prefix: '[UsageTracker]' });
const Log = createLogger('content');

// Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// The conversation being viewed, incognito chats included (common/claude/page.js has the pieces).
function getCurrentConversationId() {
	return isIncognito() ? getIncognitoConversationId() : getConversationId();
}

async function sendBackgroundMessage(message) {
	const enrichedMessage = {
		...message,
		orgId: getActiveOrgId()
	};
	let counter = 10;
	while (counter > 0) {
		try {
			const response = await browser.runtime.sendMessage(enrichedMessage);
			return response;
		} catch (error) {
			// Check if it's the specific "receiving end does not exist" error
			if (error.message?.includes('Receiving end does not exist')) {
				await Log("warn", 'Background script not ready, retrying...', error);
				await sleep(200);
			} else {
				// For any other error, throw immediately
				throw error;
			}
		}
		counter--;
	}
	throw new Error("Failed to send message to background script after 10 retries.");
}

// Encode bytes as base64 (chunked to avoid stack overflow on large file downloads). Used to ship
// proxyFetch response bodies back to the background, which rebuilds a Response from them.
function bytesToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

// Brave hides containers from extension APIs, so the background can't read this container's cookies.
// Tell it whether we're on Brave; if so, it proxies claude.ai fetches back through this tab.
async function reportBraveStatus() {
	try {
		const isBrave = !!(navigator.brave && typeof navigator.brave.isBrave === 'function' && await navigator.brave.isBrave());
		await sendBackgroundMessage({ type: 'reportBrave', isBrave });
	} catch (e) {
		await Log("warn", "Brave detection failed:", e);
	}
}

async function waitForElement(target, selector, maxTime = 1000) {
	let elapsed = 0;
	const waitInterval = 100
	while (elapsed < maxTime) {
		const element = target.querySelector(selector);
		if (element) return element;
		await sleep(waitInterval);
		elapsed += waitInterval;
	}

	return null;
}

// An unreadable picker is a standing condition, not an event: checkModelChange re-reads it every
// highUpdateFrequency ms off the rAF loop, so logging unconditionally would fill debug_logs with
// the same line hundreds of times a minute. Warn once per distinct label instead.
let lastWarnedPickerLabel = null;
function warnUnreadablePickerOnce(label) {
	if (label === lastWarnedPickerLabel) return;
	lastWarnedPickerLabel = label;
	Log("warn", "Model picker present but no known model in its label:", label);
}

// The API model id the NEXT message will use, read out of the picker. Three answers:
//   a model id    - the picker is there and names a model we know
//   MODEL_UNKNOWN - the picker is there but we can't make sense of it (see below)
//   null          - there is no picker to read
async function getCurrentModelVersion(maxWait = 3000) {
	const modelSelector = await waitForElement(document, SELECTORS.MODEL_PICKER, maxWait);
	// No picker: null, "not observed", and NOT the tier default. This used to return claude.ai's
	// default picker selection for the plan, which on Max is Opus, so any poll that found the
	// control unmounted (it is re-rendered with the composer; the reports were Fable conversations
	// read as Opus during long tool-heavy responses, and this was the only path that could produce
	// that) reported a "model change": the message was re-priced at the Opus weight and, since
	// isCurrentlyCached compares the reading against the conversation's own model, the cache
	// indicator vanished. A missing control is not evidence of anything; null lets every consumer
	// fall back to what the conversation itself says.
	if (!modelSelector) return null;

	// Read the BUTTON's own label rather than a descendant styling class. claude.ai's CDS redesign
	// moved `whitespace-nowrap` from an inner span onto the button itself, and querySelector never
	// matches the element it is called on - so the old lookup silently returned null and every
	// conversation was reported as the tier's default model, which killed cache tracking on every
	// chat not using that model. aria-label is the primary source (semantic, and required for a11y);
	// textContent is the backup.
	const label = (modelSelector.getAttribute('aria-label') || modelSelector.textContent || '')
		.trim().toLowerCase();

	// Longest key first so "opus 4.5" wins over "opus 4" without depending on the insertion order of
	// MODEL_VERSION_MAP. `includes` rather than `startsWith` because the label carries decoration on
	// both sides: "Model: " in front, the effort level ("High", "Medium") behind.
	const matchedModel = Object.keys(CONFIG.MODEL_VERSION_MAP)
		.sort((a, b) => b.length - a.length)
		.find(key => label.includes(key));
	if (matchedModel) return CONFIG.MODEL_VERSION_MAP[matchedModel];

	// Picker is there but unreadable - restyled again, or a model we don't ship a label for yet.
	// MODEL_UNKNOWN, not the tier default and not a bare null: it says "we looked and could not
	// tell", which isCurrentlyCached treats as a reason to withhold the cache claim rather than as
	// permission to skip the check. A confident wrong guess instead disables cache tracking with no
	// visible symptom - which is exactly how this rotted last time.
	warnUnreadablePickerOnce(label);
	return MODEL_UNKNOWN;
}

// The effort/thinking selection shown after the model in the picker: "Model: Opus 5 · High".
//
// Returned as the RAW label, lowercased, and NOT mapped to an API value - deliberately. claude.ai
// renders these through react-intl (Low/Medium/High/Extra/Max on models with an effort ladder,
// thinking-mode wording like "Extended" on those without), so the visible word tracks the account
// language while the API values do not - and they don't line up anyway: "Extra" is `xhigh` in the
// request body. Mapping label -> API value would mean shipping claude.ai's translations of five
// strings across nine locales and keeping them in sync forever.
//
// We never need the value itself, only whether it CHANGED since the cache was written, and both
// sides of that comparison are taken from this same string - see isCurrentlyCached. The background
// can't supply it either: switching effort inside a conversation fires no request at all, and the
// choice is ephemeral React state that reverts to the conversation's own effort on reload. That
// reversion is what makes the reading at data-arrival time a valid baseline.
//
// aria-label only. textContent renders as "Opus 5 High" with no separator, so there is nothing to
// split on there. null means "not observed" - no picker, no label, or a model with no selector at
// all - which isCurrentlyCached treats as no opinion rather than as a change.
async function getCurrentEffortLabel(maxWait = 3000) {
	const modelSelector = await waitForElement(document, SELECTORS.MODEL_PICKER, maxWait);
	if (!modelSelector) return null;

	const label = modelSelector.getAttribute('aria-label');
	if (!label) return null;

	const separator = label.indexOf('·');
	if (separator === -1) return null;

	return label.slice(separator + 1).trim().toLowerCase() || null;
}

// Model family (Opus/Sonnet/...) for the picker's selection. Delegates so there is one parser.
//
// Returns null - not MODEL_UNKNOWN - when the model can't be identified, and that asymmetry with
// getCurrentModelVersion is deliberate. This value picks the limits and the fallback price family
// for a cost estimate, where null makes the consumers fall back to the conversation's own model;
// handing them MODEL_UNKNOWN would instead land on FALLBACK_MODEL_WEIGHT and price every unknown
// model as Opus. Estimates may degrade to something plausible, but the cache claim may not - see
// isCurrentlyCached.
async function getCurrentModel(maxWait = 3000) {
	const modelVersion = await getCurrentModelVersion(maxWait);
	if (!modelVersion || modelVersion === MODEL_UNKNOWN) return null;
	return modelFamilyFromVersion(modelVersion);
}


// Which pieces of the sidebar section the user wants shown. Purely content-side UI state — the
// background never reads it — so it lives in storage.local directly, like usageSectionCollapsed.
// Keys are limit keys ('session', 'weekly', 'fableWeekly', 'extraUsage') plus the footer links below.
// A missing key means visible, so an empty object is the default "show everything".
const SIDEBAR_DISPLAY_KEY = 'sidebarDisplay';
// The non-limit keys, so the bar logic and the settings card can tell the two apart.
const SIDEBAR_LINK_KEYS = ['desktopLink', 'qolLink', 'bugLink'];

// Whether the LengthUI stats (length / cost / cached / messages left) are shown at all. Content-side
// only, like usageSectionCollapsed: LengthUI reads it once at boot and never mounts when it's set.
const LENGTH_DISPLAY_KEY = 'lengthDisplayHidden';

async function getSidebarDisplayPrefs() {
	const stored = await browser.storage.local.get(SIDEBAR_DISPLAY_KEY);
	const prefs = stored[SIDEBAR_DISPLAY_KEY];
	return (prefs && typeof prefs === 'object') ? prefs : {};
}

// Written whole, once, when the settings card is saved — never per-checkbox, so there is no
// read-modify-write for concurrent edits to race over.
async function setSidebarDisplayPrefs(prefs) {
	await browser.storage.local.set({ [SIDEBAR_DISPLAY_KEY]: prefs });
}

function isSidebarItemVisible(prefs, key) {
	return prefs[key] !== false;
}


// The UI language comes from common/i18n (shared with Claude QoL: see i18n-core.js). Before that,
// the tracker kept its own override in storage.local; move it over once, if the user hasn't picked a
// language in the shared picker since. Awaited before anything localizes a card or the settings.
const localeReady = (async () => {
	try {
		const { languageOverride } = await browser.storage.local.get('languageOverride');
		if (languageOverride === undefined) return;
		if (languageOverride && !getLanguageOverride()) {
			setLanguageOverride(languageOverride);
			pinLocale(languageOverride); // in case something already localized with the old locale
		}
		await browser.storage.local.remove('languageOverride');
	} catch (e) { /* nothing to migrate */ }
})();

// Persist the resolved language as lastLang, for the popup and background (which can't see
// claude.ai's localStorage), and keep the shared account locale cache fresh.
async function applyLocale() {
	await localeReady;
	refreshAccountLocale();
	await browser.storage.local.set({ lastLang: currentLocale() });
}

function getResetTimeHTML(timeInfo) {
	const prefix = localize('reset.prefix');

	if (!timeInfo || !timeInfo.timestamp || timeInfo.expired) {
		return `${prefix} <span>${localize('reset.not_set')}</span>`;
	}

	const now = Date.now();
	const diff = timeInfo.timestamp - now;

	// Convert to seconds and round to nearest minute
	const totalMinutes = Math.round(diff / (1000 * 60));

	if (totalMinutes === 0) {
		return `${prefix} <span style="color: ${BLUE_HIGHLIGHT}">${localize('reset.under_1m')}</span>`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	const timeString = hours > 0 ? localize('time.hm', { h: hours, m: minutes }) : localize('time.m', { m: totalMinutes });

	return `${prefix} <span style="color: ${BLUE_HIGHLIGHT}">${timeString}</span>`;
}

// Progress bar component
class ProgressBar {
	constructor(options = {}) {
		const {
			width = '100%',
			height = '6px'
		} = options;

		this.container = document.createElement('div');
		this.container.className = 'ut-progress';
		if (width !== '100%') this.container.style.width = width;

		this.track = document.createElement('div');
		this.track.className = 'bg-bg-500 ut-progress-track';
		if (height !== '6px') this.track.style.height = height;

		this.bar = document.createElement('div');
		this.bar.className = 'ut-progress-bar';
		this.bar.style.background = BLUE_HIGHLIGHT;

		this.track.appendChild(this.bar);
		this.container.appendChild(this.track);
		this.container.style.cursor = 'help';
		this.tooltip = createClaudeTooltip(this.container, '');
	}

	updateProgress(total, maxTokens) {
		const percentage = (total / maxTokens) * 100;
		this.bar.style.width = `${Math.min(percentage, 100)}%`;
		this.bar.style.background = total >= maxTokens * CONFIG.WARNING.PERCENT_THRESHOLD ? RED_WARNING : BLUE_HIGHLIGHT;
		this.tooltip.updateText(localize('usage.bar_credits', { used: fmtNum(total), total: fmtNum(maxTokens), pct: percentage.toFixed(1) }));
	}

	setMarker(percentage, label) {
		if (!this.marker) {
			this.marker = document.createElement('div');
			this.marker.className = 'ut-weekly-marker';
			this.marker.style.setProperty('--marker-color', RED_WARNING);
			this.container.style.paddingTop = '10px';
			this.container.style.marginTop = '-10px';
			this.container.appendChild(this.marker);

			this.marker.style.cursor = 'help';
			this.markerTooltip = createClaudeTooltip(this.marker, '');
		}
		this.marker.style.left = `${Math.min(percentage, 100)}%`;
		this.marker.style.display = 'block';
		if (label) this.markerTooltip.updateText(label);
	}

	clearMarker() {
		if (this.marker) {
			this.marker.style.display = 'none';
			this.container.style.paddingTop = '';
			this.container.style.marginTop = '';
		}
	}
}

// Message handlers for background script requests
browser.runtime.onMessage.addListener(async (message) => {
	if (message.type === 'getActiveModel') {
		return await getCurrentModel();
	}
	if (message.action === "getOrgID") {
		return Promise.resolve({ orgId: getActiveOrgId() });
	}
	if (message.type === 'proxyFetch') {
		// Brave: perform a fetch in this tab's container context and ship the result to the background.
		try {
			const r = await fetch(message.url, { ...(message.options || {}), credentials: 'include' });
			const buf = await r.arrayBuffer();
			return { ok: r.ok, status: r.status, statusText: r.statusText, body: bytesToBase64(buf) };
		} catch (e) {
			await Log("error", "proxyFetch failed:", message.url, e);
			return { ok: false, status: 0, statusText: String(e), body: '' };
		}
	}
});

// Style injection
async function injectStyles() {
	if (document.getElementById('ut-styles')) return;
	try {
		const cssContent = await fetch(browser.runtime.getURL('tracker-styles.css')).then(r => r.text());
		const style = document.createElement('link');
		style.rel = 'stylesheet';
		style.id = 'ut-styles';
		style.href = `data:text/css;charset=utf-8,${encodeURIComponent(cssContent)}`;
		document.head.appendChild(style);
	} catch (error) {
		await Log("error", 'Failed to load tracker styles:', error);
	}
}

// ========== PAGE LAYOUTS ==========
// Centralized layout detection and anchor resolution.
// Each layout has match() to detect the page and anchors to find DOM insertion points.
// Checked in order; first match() wins.

function getSidebarRegularAnchor() {
	const sidebarNav = document.querySelector('nav.flex');
	if (!sidebarNav) return null;

	const containerWrapper = sidebarNav.querySelector('.flex.flex-grow.flex-col.overflow-y-auto');
	const containers = containerWrapper?.querySelectorAll('.flex-1.relative');
	if (!containers) return null;

	let mainContainer = containers[containers.length - 1].querySelector('.px-2.mt-4');
	if (!mainContainer) mainContainer = containers[containers.length - 1].querySelector('.px-2.pt-2');
	if (!mainContainer) return null;

	const starredSection = mainContainer.querySelector('div.flex.flex-col.mb-4');
	const prefSwitcher = mainContainer.querySelector('.preset-switcher-section');
	const referenceNode = prefSwitcher || starredSection || mainContainer.firstChild || null;

	return {
		parent: mainContainer,
		referenceNode,
		classes: { remove: ['px-2'] },
	};
}

function getSidebarDesktopAnchor() {
	const sidebarBody = document.querySelector('.dframe-sidebar-body');
	if (!sidebarBody) return null;

	const navScroll = sidebarBody.querySelector('.dframe-nav-scroll');
	if (!navScroll) return null;

	// Mount INSIDE the scroll area, above the recents, rather than as a fixed block above it.
	// Sitting outside meant our ~220px of bars ate the scroll area's flex basis: on a short
	// viewport the recents collapsed to a few pixels and our own content overflowed onto the
	// bottom tray, with no way to scroll any of it back. Inside, everything scrolls together.
	// shrink-0 keeps the bars at full height instead of being squashed by the flex column.
	// The Projects/Artifacts/... links now sit inside the scroll area too, ahead of the recents,
	// so anchor on the recents block to land below the links. When the recents block isn't
	// rendered (e.g. an account with no chats yet), the first non-extension child is the links
	// block itself, so go after it instead; a null referenceNode appends.
	const recents = navScroll.querySelector(':scope > .dframe-recents-by-mode');
	const navLinks = Array.from(navScroll.children).find(child => !child.classList.contains('ut-usage-sidebar'));
	const referenceNode = recents || navLinks?.nextElementSibling || null;

	return {
		parent: navScroll,
		referenceNode,
		classes: { add: ['shrink-0'] },
	};
}

function getChatAreaRegularAnchor() {
	// Redesigned composer (2026-08): a rounded bg-surface-3 box whose single flow child holds the
	// input, with the controls either absolutely positioned inside that child (home page) or moved
	// out to a footer row below the box entirely (conversation view). Neither the picker nor a
	// full-width toolbar row is a reliable anchor any more — the old `.flex.w-full.items-center`
	// closest() from the picker walks past the box and false-matches the whole page column,
	// stranding the stat line at the bottom of the page. Resolve from the input instead and sit
	// after the flow child, which stacks the line inside the box beneath the input in both views.
	const chatInput = document.querySelector('[data-testid="chat-input"]');
	const composerFlowChild = chatInput?.closest('.bg-surface-3 > .relative.w-full.min-w-0');
	if (composerFlowChild) {
		return {
			insertAfter: composerFlowChild,
			styles: { paddingLeft: '6px', paddingRight: '', paddingBottom: '' },
		};
	}

	// Pre-redesign composer: the picker sits in a full-width flex toolbar row. A real toolbar row
	// sits beside the input, never around it — so a match that contains the input is the redesign's
	// failure mode (the selector walking up to the whole page column), and mounting nothing beats
	// mounting the line at the bottom of the page.
	const modelSelector = document.querySelector(SELECTORS.MODEL_SELECTOR);
	if (!modelSelector) return null;

	const toolbarRow = modelSelector.closest('.flex.w-full.items-center');
	if (!toolbarRow || (chatInput && toolbarRow.contains(chatInput))) return null;

	return {
		insertAfter: toolbarRow,
		styles: { paddingLeft: '6px', paddingRight: '', paddingBottom: '' },
	};
}

// The title line is a single element that gets re-anchored as the layout changes, and
// in-page navigation (incognito <-> normal chat) can hand it from one anchor to another
// without a reload. Every titleArea anchor therefore spreads this reset and states the
// muted-text class explicitly, so nothing the previous anchor set can survive the move.
const TITLE_AREA_STYLE_RESET = {
	flexBasis: '',
	width: '',
	maxWidth: '',
	alignSelf: '',
	marginTop: '',
	marginLeft: '',
	paddingLeft: '',
	paddingRight: '',
	paddingBottom: '',
	position: '',
	top: '',
	zIndex: '',
	minWidth: '',
	overflow: '',
	whiteSpace: '',
	textOverflow: '',
};

// One line, clipped with an ellipsis. Our line must never wrap in a header: they are fixed-height
// rows that centre their content, so every extra line grows the title group and centring pushes the
// chat title up past the top edge of the window.
const TITLE_AREA_SINGLE_LINE = {
	minWidth: '0',
	overflow: 'hidden',
	whiteSpace: 'nowrap',
	textOverflow: 'ellipsis',
};

// Mobile headers are position:absolute with a fixed height, so forcing our line onto a
// second line inside them renders it outside the header, on top of the message list (and
// pushes the page's own buttons out with it). The layout already reserves the header's
// height as margin-top on the sibling scroll container, so take a strip of that instead:
// sit between the two and carry the reservation on our own margin. When our line is empty
// its height is 0, so the scroller ends up exactly where the original margin put it.
function getMobileTitleAreaAnchor(headerRow) {
	const container = headerRow?.parentElement;
	const scroller = container?.querySelector(':scope > .overflow-y-auto.overflow-x-hidden');
	if (!scroller) return null;

	const headerHeight = Math.round(headerRow.getBoundingClientRect().height);
	if (!headerHeight) return null;

	// An older build forced a wrap here, which is what pushed the header's own controls out.
	headerRow.classList.remove('flex-wrap');
	scroller.style.marginTop = '0px';

	return {
		parent: container,
		referenceNode: scroller,
		styles: {
			...TITLE_AREA_STYLE_RESET,
			// Line up with the title's glyphs: the header's own padding, plus the 6px the
			// title button insets its text by.
			paddingLeft: `${(parseFloat(getComputedStyle(headerRow).paddingLeft) || 0) + 6}px`,
			// The margin keeps the reservation intact (and stays correct when the line is
			// empty); `top` does the tucking, so the scroller never creeps under the header.
			marginTop: `${headerHeight}px`,
			position: 'relative',
			top: '-8px',
			zIndex: '11', // above the header's gradient overlay
		},
		classes: { toggle: { 'text-text-500': true, 'bg-bg-100': false, 'bg-surface-1': false, '!px-2': false } },
	};
}

// Hand the header-height reservation back to the scroll container. Needed when the view
// stops being mobile (resize past the breakpoint, tablet rotation) - otherwise the offset
// we moved onto our own element stays gone and the messages slide under the header.
function clearMobileTitleAreaOffset(headerRow) {
	const scroller = headerRow?.parentElement?.querySelector(':scope > .overflow-y-auto.overflow-x-hidden');
	if (scroller?.style.marginTop) scroller.style.marginTop = '';
}

// How far the title's first glyph sits from the start of the title row.
//
// The title is a button that pokes out to the left with a negative offset and pads its text back
// in, so its text does NOT start where the row does. Our line is a plain sibling with no such
// padding, and used to hard-code 6px to match. claude.ai has since restyled that button - it now
// sits 10px out with 10px of padding, i.e. an inset of 0 - so the constant became a 6px rightward
// offset against the title. Measure it instead, and the alignment survives the next restyle.
function getTitleTextInset(titleLine) {
	const btn = titleLine?.querySelector('button');
	if (!btn) return 0;
	const wrapper = [...titleLine.children].find(child => child.contains(btn));
	if (!wrapper) return 0;

	const wrapperLeft = wrapper.getBoundingClientRect().left;
	const btnRect = btn.getBoundingClientRect();
	// Nothing is laid out yet (hidden tab, first paint) - 0 is the safe guess, and the anchor is
	// recomputed on later passes anyway.
	if (!btnRect.width) return 0;

	const padding = parseFloat(getComputedStyle(btn).paddingLeft) || 0;
	return Math.max(0, Math.round(btnRect.left + padding - wrapperLeft));
}

// The strip: the normal-flow slot directly under claude.ai's header (after
// .dframe-below-header-banner), which has the whole column's width. Null on a layout without that
// slot. Used on desktop when the line doesn't fit in the header, and always on phones.
function getTitleStripAnchor(titleLine) {
	const header = titleLine.closest('.dframe-header');
	const banner = header?.parentElement?.querySelector(':scope > .dframe-below-header-banner');
	if (!banner) return null;

	// Line up with the title's glyphs, measured against the strip's own left edge.
	const btn = titleLine.querySelector('button');
	const btnRect = btn?.getBoundingClientRect();
	const stripLeft = banner.parentElement.getBoundingClientRect().left;
	const inset = btnRect?.width
		? Math.max(0, Math.round(btnRect.left + (parseFloat(getComputedStyle(btn).paddingLeft) || 0) - stripLeft))
		: parseFloat(getComputedStyle(header).paddingLeft) || 0;

	// The strip is above everything in the header (see alignSelf below), so it must end before
	// anything the header hangs down into this band - Claude QoL's phone buttons do, at the right
	// edge. Shrinking to the text isn't enough on its own: a long line (German, with the cache timer)
	// fills the column. Found by geometry rather than by class name: a header descendant that
	// reaches below the header, sits right of where our text starts, and is narrower than the column
	// (which rules out the header's full-width gradient backdrop).
	const column = banner.parentElement.getBoundingClientRect();
	const bandTop = header.getBoundingClientRect().bottom;
	const BAND_HEIGHT = 32;
	let freeRight = column.right;
	for (const el of header.querySelectorAll('*')) {
		const r = el.getBoundingClientRect();
		if (!r.width || r.bottom <= bandTop + 1 || r.top >= bandTop + BAND_HEIGHT) continue;
		if (r.left <= stripLeft + inset || r.width >= column.width * 0.6) continue;
		freeRight = Math.min(freeRight, r.left);
	}
	const maxWidth = freeRight < column.right ? `${Math.max(0, Math.floor(freeRight - stripLeft - 8))}px` : '100%';

	return {
		isStrip: true,
		insertAfter: banner,
		styles: {
			...TITLE_AREA_STYLE_RESET,
			...TITLE_AREA_SINGLE_LINE,
			paddingLeft: `${inset}px`,
			paddingRight: getComputedStyle(header).paddingRight,
			paddingBottom: '4px',
			// Above the header's gradient backdrop, which reaches down over this slot, and opaque
			// so the messages scrolling up beneath don't show through the text.
			position: 'relative',
			zIndex: '11',
			// Only as wide as the text. The header is a stacking context (z-10), so being above its
			// backdrop means being above everything in it - including whatever hangs from it into this
			// band, like Claude QoL's phone buttons at the right edge. A full-width strip covered them.
			alignSelf: 'flex-start',
			maxWidth,
		},
		classes: { toggle: { 'text-text-500': true, 'bg-surface-1': true, 'bg-bg-100': false, '!px-2': false } },
	};
}

// Mobile titleArea. Phones now get the same .dframe-header layout as desktop, which has none of the
// structure getMobileTitleAreaAnchor looks for, so it found nothing and the line silently never
// mounted. There is no room in a phone's header anyway, so go straight to the strip; the legacy
// anchor stays as the fallback for the older layout.
function getPhoneTitleAreaAnchor(titleLine, headerRow) {
	const strip = getTitleStripAnchor(titleLine);
	if (strip) {
		clearMobileTitleAreaOffset(headerRow);
		return strip;
	}
	return getMobileTitleAreaAnchor(headerRow);
}

// Desktop titleArea: our own full-width line under the title, inside claude.ai's header.
//
// That header shares its row with the page's actions and with other extensions' buttons (Claude
// QoL puts up to seven there), and the title group is the only thing in it allowed to shrink, so a
// narrow window leaves it very little width. The header is also fixed-height, so the line can't just
// wrap there (see TITLE_AREA_SINGLE_LINE). When it doesn't fit, `strip` is where it goes instead
// (see getTitleStripAnchor). LengthUI decides between the two (see mountTitleArea). `strip` is null
// on a layout without that slot, and the line then stays in the header and truncates.
function getDesktopTitleAreaAnchor(titleLine, headerRow) {
	clearMobileTitleAreaOffset(headerRow);
	titleLine.classList.add('flex-wrap');

	const strip = getTitleStripAnchor(titleLine);

	return {
		parent: titleLine,
		referenceNode: null,
		styles: {
			...TITLE_AREA_STYLE_RESET,
			...TITLE_AREA_SINGLE_LINE,
			flexBasis: '100%',
			// The claim already states how wide the line wants to be (see LengthUI's claim). A
			// wrapping flex row's preferred width is the SUM of its items' widths, so if the line
			// counted as well the title group would claim the line's width twice and swallow the free
			// space other header occupants need to see. The basis still stretches it at layout.
			width: '0',
			paddingLeft: `${getTitleTextInset(titleLine)}px`,
		},
		classes: { toggle: { 'text-text-500': true, 'bg-surface-1': false } },
		strip,
	};
}

function getTitleAreaAnchor() {
	const chatTitle = document.querySelector(SELECTORS.CHAT_MENU);
	if (!chatTitle) return null;

	const titleLine = chatTitle.closest('.flex-1') || chatTitle.parentElement;
	if (!titleLine) return null;

	const headerRow = titleLine.parentElement;

	if (isMobileLayout()) {
		return getPhoneTitleAreaAnchor(titleLine, headerRow);
	}
	return getDesktopTitleAreaAnchor(titleLine, headerRow);
}

const pageLayouts = {
	// Desktop client layouts (checked first — desktop has dframe-sidebar, not nav.flex)
	desktopChat: {
		match() { return !!document.querySelector('aside.dframe-sidebar') && !isCodePage() && !!getCurrentConversationId(); },
		anchors: {
			sidebar: getSidebarDesktopAnchor,
			chatArea: getChatAreaRegularAnchor,
			titleArea() {
				const chatTitle = document.querySelector(SELECTORS.CHAT_MENU);
				if (!chatTitle) return null;

				const titleLine = chatTitle.closest('.font-base-bold') || chatTitle.parentElement;
				if (!titleLine) return null;

				const headerRow = titleLine.parentElement;

				if (isMobileLayout()) {
					return getPhoneTitleAreaAnchor(titleLine, headerRow);
				}
				return getDesktopTitleAreaAnchor(titleLine, headerRow);
			},
		},
	},
	desktopCoworkHome: {
		match() { return !!document.querySelector('aside.dframe-sidebar') && window.location.pathname === '/task/new'; },
		anchors: {
			sidebar: getSidebarDesktopAnchor,
			chatArea() {
				const chatInput = document.querySelector('[data-testid="chat-input"]');
				if (!chatInput) return null;

				const inputContainer = chatInput.closest('.flex.flex-col.gap-3');
				if (!inputContainer) return null;

				const toolbarRow = inputContainer.querySelector('.flex.w-full.items-center');
				if (!toolbarRow) return null;

				return {
					insertAfter: toolbarRow,
					styles: { paddingLeft: '6px', paddingRight: '', paddingBottom: '' },
				};
			},
		},
	},
	desktopHome: {
		match() { return !!document.querySelector('aside.dframe-sidebar') && !isCodePage() && !getCurrentConversationId(); },
		anchors: {
			sidebar: getSidebarDesktopAnchor,
			chatArea: getChatAreaRegularAnchor,
		},
	},
	// Web layouts
	chat: {
		match() { return !isCodePage() && !isIncognito() && !!getCurrentConversationId(); },
		anchors: {
			sidebar: getSidebarRegularAnchor,
			chatArea: getChatAreaRegularAnchor,
			titleArea: getTitleAreaAnchor,
		},
	},
	code: {
		match() { return isCodePage(); },
		anchors: {
			sidebar() {
				const sidebarNav = document.querySelector('nav.flex');

				if (sidebarNav) {
					const scrollArea = sidebarNav.querySelector('.flex-grow.overflow-y-auto');
					if (!scrollArea) return null;
					return {
						parent: scrollArea.parentElement,
						referenceNode: scrollArea,
						classes: { add: ['px-2'] },
					};
				}

				// Standalone code sidebar (no nav element)
				const codeLink = document.querySelector('a[href="/code"]');
				if (!codeLink) return null;

				const sidebarRoot = codeLink.closest('.flex.flex-col.h-full.bg-bg-100');
				if (!sidebarRoot) return null;

				const scrollArea = sidebarRoot.querySelector('.overflow-y-auto.overflow-x-hidden');
				if (!scrollArea) return null;

				const outerWrapper = scrollArea.parentElement.parentElement;
				return {
					parent: outerWrapper,
					referenceNode: outerWrapper.firstElementChild,
					classes: { add: ['px-2'] },
				};
			},
			chatArea() {
				const modelSelector = document.querySelector(SELECTORS.MODEL_SELECTOR);
				if (!modelSelector) return null;

				const toolbar = modelSelector.closest('.flex.items-center.p-2');
				if (!toolbar) return null;

				return {
					insertAfter: toolbar,
					styles: { paddingLeft: '8px', paddingRight: '8px', paddingBottom: '4px' },
				};
			},
		},
	},
	incognitoConversation: {
		// Incognito conversations have no convID in the URL and a special sessionStorage key for it instead, but otherwise behave like regular chats.
		match() { return isIncognito(); },
		anchors: {
			sidebar: getSidebarRegularAnchor,
			chatArea: getChatAreaRegularAnchor,
			titleArea() {
				// The label used to live under .z-header, which no longer exists - it now sits
				// in a fixed title bar. Matched structurally rather than by its text: the layout
				// is already gated on isIncognito(), so testing for "Incognito chat"
				// bought nothing and broke in every locale but English.
				const label = document.querySelector('.fixed.draggable > .text-sm.select-none');
				if (!label) return null;

				return {
					insertAfter: label,
					styles: {
						...TITLE_AREA_STYLE_RESET,
						// That bar is a fixed-height, nowrap flex row with room to spare, so sit
						// inline beside the label instead of forcing a line it can't accommodate.
						// min-width/overflow keep a long conversation from blowing the bar out.
						minWidth: '0',
						overflow: 'hidden',
						whiteSpace: 'nowrap',
					},
					// Drop the muted class so the text inherits the bar's own colour - it themes
					// independently of the page body.
					classes: { toggle: { 'text-text-500': false, 'bg-bg-100': false, 'bg-surface-1': false } },
				};
			},
		},
	},
	home: {
		match() { return !isCodePage() && !getCurrentConversationId(); },
		anchors: {
			sidebar: getSidebarRegularAnchor,
			chatArea: getChatAreaRegularAnchor,
		},
	},
};

const LayoutManager = {
	detectLayout() {
		for (const [name, layout] of Object.entries(pageLayouts)) {
			if (layout.match()) return { name, ...layout };
		}
		return null;
	},
	getAnchor(anchorName) {
		const layout = this.detectLayout();
		const anchorFn = layout?.anchors?.[anchorName];
		if (!anchorFn) return null;
		return anchorFn();
	},
};

function mountToAnchor(element, anchor) {
	let needsInsert;
	if (anchor.insertAfter) {
		needsInsert = anchor.insertAfter.nextElementSibling !== element;
	} else if (anchor.referenceNode) {
		needsInsert = element.nextElementSibling !== anchor.referenceNode
			|| element.parentElement !== anchor.parent;
	} else {
		// A null referenceNode means "last child", so check for that and not merely for parentage.
		// Renaming a conversation re-renders the header and React puts the title back BEFORE our
		// line, which leaves us still a child of the right parent but now the first one - the stats
		// render above the title until a reload. Comparing parents alone can't see that.
		needsInsert = element.parentElement !== anchor.parent || element.nextElementSibling !== null;
	}

	if (needsInsert) {
		if (anchor.insertAfter) {
			anchor.insertAfter.after(element);
		} else {
			anchor.parent.insertBefore(element, anchor.referenceNode || null);
		}
	}

	if (anchor.styles) Object.assign(element.style, anchor.styles);
	if (anchor.classes?.add) element.classList.add(...anchor.classes.add);
	if (anchor.classes?.remove) element.classList.remove(...anchor.classes.remove);
	if (anchor.classes?.toggle) {
		for (const [cls, force] of Object.entries(anchor.classes.toggle)) {
			element.classList.toggle(cls, force);
		}
	}
	return true;
}

// Main initialization
async function initExtension() {
	if (window.claudeTrackerInstance) {
		Log('Instance already running, stopping');
		return;
	}
	window.claudeTrackerInstance = true;

	// Report Brave status before any ClaudeAPI-backed call so the
	// background knows to proxy claude.ai fetches through this tab's container.
	await reportBraveStatus();

	// Clean up any leftover UI elements from a previous instance (e.g. extension toggled off/on)
	document.querySelectorAll('[class^="ut-"], [class*=" ut-"]').forEach(el => el.remove());
	const oldStyles = document.getElementById('ut-styles');
	if (oldStyles) oldStyles.remove();

	await injectStyles();

	// Settle the UI language (the one-time override migration) BEFORE assigning CONFIG. UI scripts
	// gate their construction on CONFIG, so every static string (sidebar header, tooltips) is built
	// in the right language.
	const cfg = await sendBackgroundMessage({ type: 'getConfig' });
	await applyLocale();
	CONFIG = cfg;
	await Log("Config received...");

	// Incognito conversations never have the standard sidebar structure.
    // Skip the 6-second wait to avoid a spurious warning and wasted polling.
    if (isIncognito()) {
        await Log('Incognito mode: skipping sidebar anchor wait');
        sendBackgroundMessage({ type: 'requestData' });
        sendBackgroundMessage({ type: 'initOrg' });
        await Log('Initialization complete. Ready to track tokens.');
        return;
    }

	// Wait for page to be ready (sidebar anchor available = logged in and DOM loaded)
	const LOGIN_CHECK_DELAY = 10000;
	while (true) {
		let sidebarAnchor = null;
		const maxWait = 6000;
		const interval = 100;
		let elapsed = 0;
		while (elapsed < maxWait) {
			sidebarAnchor = LayoutManager.getAnchor('sidebar');
			if (sidebarAnchor) break;
			await sleep(interval);
			elapsed += interval;
		}

		if (sidebarAnchor) {
			if (sidebarAnchor.parent.getAttribute('data-script-loaded')) {
				await Log('Script already running, stopping duplicate');
				return;
			}
			sidebarAnchor.parent.setAttribute('data-script-loaded', true);
			break;
		}

		const initialLoginScreen = document.querySelector(SELECTORS.INIT_LOGIN_SCREEN);
		const verificationLoginScreen = document.querySelector(SELECTORS.VERIF_LOGIN_SCREEN);
		if (!initialLoginScreen && !verificationLoginScreen) {
			await Log("warn", 'No sidebar anchor found and no login screen detected, proceeding anyway');
			break;
		}
		await Log('Login screen detected, waiting before retry...');
		await sleep(LOGIN_CHECK_DELAY);
	}

	// Request initial data
	sendBackgroundMessage({ type: 'requestData' });
	sendBackgroundMessage({ type: 'initOrg' });

	await Log('Initialization complete. Ready to track tokens.');
}

// Self-initialize
(async () => {
	try {
		await initExtension();
	} catch (error) {
		await Log("error", 'Failed to initialize Chat Token Counter:', error);
	}
})();