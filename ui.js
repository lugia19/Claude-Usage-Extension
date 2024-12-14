// ==UserScript==
// @name         Claude Usage Tracker
// @namespace    lugia19.com
// @match        https://claude.ai/*
// @version      1.9.0
// @author       lugia19
// @license      GPLv3
// @description  Helps you track your claude.ai usage caps.
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @require      https://unpkg.com/gpt-tokenizer/dist/o200k_base.js
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
	'use strict';

	const DEBUG_MODE = false
	function debugLog(...args) {
		if (DEBUG_MODE) {
			console.log(...args);
		}
	}

	if (window.claudeTrackerInstance) {
		debugLog('Instance already running, stopping');
		return;
	}
	window.claudeTrackerInstance = true;

	const tokenizer = GPTTokenizer_o200k_base;
	let config;

	//#region Storage Interface
	class TokenStorageInterface {
		async setUserId(userId) {
			debugLog("Sending user ID...", userId);
			return await browser.runtime.sendMessage({
				type: 'setUserId',
				userId
			});
		}

		async getFileTokens(conversationId, filename, fileType) {
			if (DEBUG_MODE) return undefined;	// Disable cache in debug mode
			return await browser.runtime.sendMessage({
				type: 'getFileTokens',
				conversationId,
				filename,
				fileType
			});
		}

		async saveFileTokens(conversationId, filename, tokens, fileType) {
			return await browser.runtime.sendMessage({
				type: 'saveFileTokens',
				conversationId,
				filename,
				tokens,
				fileType
			});
		}

		async getCheckboxStates() {
			return await browser.runtime.sendMessage({ type: 'getCheckboxStates' });
		}

		async setCheckboxState(key, checked) {
			return await browser.runtime.sendMessage({
				type: 'setCheckboxState',
				key,
				checked
			});
		}

		async getCollapsedState() {
			return await browser.runtime.sendMessage({ type: 'getCollapsedState' });
		}

		async setCollapsedState(isCollapsed) {
			return await browser.runtime.sendMessage({
				type: 'setCollapsedState',
				isCollapsed
			});
		}

		async calculateMessagesLeft(model, conversationLength) {
			return await browser.runtime.sendMessage({
				type: 'calculateMessagesLeft',
				model,
				conversationLength
			});
		}

		async getModelData(model) {
			return await browser.runtime.sendMessage({
				type: 'getModelData',
				model
			});
		}

		async getFormattedTimeRemaining(model) {
			return await browser.runtime.sendMessage({
				type: 'getFormattedTimeRemaining',
				model
			});
		}

		async getExtraCost() {
			return await browser.runtime.sendMessage({ type: 'getExtraCost' });
		}

		async addTokensToModel(model, newTokens) {
			return await browser.runtime.sendMessage({
				type: 'addTokensToModel',
				model,
				newTokens
			});
		}
	}
	let storageInterface;
	//#endregion

	//State variables
	let currentlyDisplayedModel = 'default';
	let modelSections = {};
	let currentConversationId = null;
	let currentMessageCount = 0;
	let lastCheckboxState = {};
	let isProcessingUIEvent = false;

	//#region Utils
	async function getUserId() {
		const userMenuButton = document.querySelector(config.SELECTORS.USER_MENU_BUTTON);
		if (!userMenuButton) {
			console.error("Could not find user menu button");
			return null;
		}

		const emailDiv = userMenuButton.querySelector('.min-w-0.flex-1.truncate');
		if (!emailDiv) {
			console.error("Could not find email element");
			return null;
		}

		const email = emailDiv.textContent.trim();
		const msgBuffer = new TextEncoder().encode(email);
		const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getCurrentModel() {
		const modelSelector = document.querySelector(config.SELECTORS.MODEL_PICKER);
		if (!modelSelector) return 'default';

		let fullModelName = modelSelector.querySelector('.whitespace-nowrap')?.textContent?.trim() || 'default';

		if (!fullModelName || fullModelName === 'default') return 'default';

		fullModelName = fullModelName.toLowerCase();
		const modelTypes = Object.keys(config.MODEL_TOKEN_CAPS).filter(key => key !== 'default');

		for (const modelType of modelTypes) {
			if (fullModelName.includes(modelType.toLowerCase())) {
				return modelType;
			}
		}

		return 'default';
	}

	function calculateTokens(text) {
		return Math.ceil(tokenizer.countTokens(text) * 1.15);
		//return Math.ceil(text.length / 4);
	}

	function isMobileView() {
		// First check if we're on a chat page
		if (!window.location.pathname.startsWith('/chat/')) {
			return false;
		}

		// Check if height > width (portrait orientation)
		return window.innerHeight > window.innerWidth;
	}

	async function findElement(parentElement, querySelector, maxWaitTime = 300) {
		let elapsed = 0;

		while (elapsed <= maxWaitTime) {
			debugLog(elapsed + "ms elapsed, finding element:", querySelector);
			debugLog("Finding element:", querySelector);
			const element = parentElement.querySelector(querySelector);
			if (element) {
				return element;
			}
			await sleep(100);
			elapsed += 100;
		}

		return undefined;
	}
	//#endregion

	//#region File Processing
	async function ensureSidebarLoaded() {
		const sidebar = document.querySelector(config.SELECTORS.SIDEBAR_CONTENT);

		//Ensure we're not inside a modal
		const backButton = document.querySelector(config.SELECTORS.BACK_BUTTON);
		if (backButton) {
			debugLog("Found back button, clicking it");
			backButton.click();
			await sleep(200);
		}

		// If sidebar exists and has been processed before, we're done
		if (sidebar && sidebar.getAttribute('data-files-processed')) {
			debugLog("Sidebar was processed! Skipping opening it.")
			return true;
		}

		// If we get here, we need to open/reload the sidebar
		const sidebarButton = document.querySelector(config.SELECTORS.SIDEBAR_BUTTON);
		if (!sidebarButton) {
			debugLog('Could not find sidebar button');
			return false;
		}

		sidebarButton.click();


		// Wait for sidebar to become visible and mark it as processed
		let attempts = 0;
		while (attempts < 5) {
			let sidebar = document.querySelector(config.SELECTORS.SIDEBAR_CONTENT);
			if (sidebar) {
				const style = window.getComputedStyle(sidebar);
				const matrixMatch = style.transform.match(/matrix\(([\d.-]+,\s*){5}[\d.-]+\)/);
				const isHidden = matrixMatch && style.transform.includes('428');

				if (!isHidden && style.opacity !== '0') {
					debugLog("Sidebar is visible, wait 1 sec.")
					sidebar.setAttribute('data-files-processed', 'true');
					await sleep(1000);

					//Ensure we have actually updated data.
					sidebar = document.querySelector(config.SELECTORS.SIDEBAR_CONTENT);

					// Close the sidebar since we only needed it to load the content
					const closeButton = document.querySelector('button[data-testid="close-file-preview"]');
					if (closeButton) {
						closeButton.click();
					}

					return true;
				}
			}
			await sleep(100);
			attempts++;
		}
		debugLog('Sidebar did not show/load properly');
		return false;
	}

	async function closeSidebar() {
		debugLog("Closing sidebar...")
		const sidebar = document.querySelector(config.SELECTORS.SIDEBAR_CONTENT);
		if (sidebar) {
			const style = window.getComputedStyle(sidebar);
			// If sidebar is visible (not transformed away)
			const matrixMatch = style.transform.match(/matrix\(([\d.-]+,\s*){5}[\d.-]+\)/);
			const isHidden = matrixMatch && style.transform.includes('428');
			if (!isHidden && style.opacity !== '0') {
				const closeButton = document.querySelector(config.SELECTORS.SIDEBAR_BUTTON);
				if (closeButton) { // Check if button is visible
					debugLog("Closing...")
					closeButton.click();
				}
			}
		}
	}

	async function handleProjectFile(button) {
		try {
			const fileContainer = button.closest('div[data-testid]');
			if (!fileContainer) {
				debugLog('Could not find project file container');
				return 0;
			}

			const filename = fileContainer.getAttribute('data-testid');
			debugLog('Processing project file:', filename);

			const stored = await storageInterface.getFileTokens(getConversationId(), filename, "project");
			if (stored !== undefined) {
				debugLog(`Using cached tokens for project file: ${filename}`);
				return stored;
			}

			debugLog(`Calculating tokens for project file: ${filename}`);
			button.click();

			// Wait for modal with correct filename
			// TODO: Handle CSV file here
			let attempts = 0;
			let modal = null;
			let modalTitle = null;

			while (attempts < 5) {
				modal = document.querySelector(config.SELECTORS.MODAL);
				if (modal) {
					modalTitle = modal.querySelector('h2');
					if (modalTitle && modalTitle.textContent === filename) {
						debugLog(`Found modal with title ${filename}`)
						break;
					}
				}
				await new Promise(resolve => setTimeout(resolve, 200));
				attempts++;
			}

			if (!modal || !modalTitle || modalTitle.textContent !== filename) {
				debugLog('Could not find modal with matching filename');
				return 0;
			}



			const content = modal.querySelector(config.SELECTORS.MODAL_CONTENT);
			if (!content) {
				debugLog('Could not find modal content');
				return 0;
			}

			const text = content.textContent || '';
			debugLog(`First 100 chars of content: "${text.substring(0, 100)}"`);
			const tokens = calculateTokens(content.textContent || '');
			debugLog(`Project file ${filename} tokens:`, tokens);

			if (tokens > 0) {
				await storageInterface.saveFileTokens(getConversationId(), filename, tokens, "project");
			}



			const closeButton = modal.querySelector(config.SELECTORS.MODAL_CLOSE);
			if (closeButton) {
				closeButton.click();
			}

			debugLog("Eeeping.")
			await sleep(200);

			return tokens;
		} catch (error) {
			console.error('Error processing project file:', error);
			return 0;
		}
	}

	async function getProjectTokens() {
		const projectContainer = document.querySelector(config.SELECTORS.PROJECT_FILES_CONTAINER);
		const projectFileButtons = projectContainer?.querySelectorAll(config.SELECTORS.PROJECT_FILES) || [];
		debugLog('Found project files in sidebar:', projectFileButtons);

		let totalTokens = 0;
		for (const button of projectFileButtons) {
			const fileContainer = button.closest('div[data-testid]');
			if (!fileContainer) {
				debugLog('Could not find project file container');
				return 0;
			}

			const filename = fileContainer.getAttribute('data-testid');
			debugLog('Processing project file:', filename);
			const tokens = await handleTextFile(button, false, filename)
			totalTokens += tokens;
		}

		return totalTokens;
	}

	async function handleTextFile(button, skipClick = false, overrideFilename = null) {
		let filename;
		if (overrideFilename) {
			filename = overrideFilename;
		} else {
			filename = button.querySelector('.break-words')?.textContent;
		}

		if (!filename) {
			debugLog('Could not find filename for text file');
			return 0;
		}

		const stored = await storageInterface.getFileTokens(getConversationId(), filename, "content");
		if (stored !== undefined) {
			debugLog(`Using cached tokens for text file: ${filename}`);
			return stored;
		}

		if (!skipClick) {
			debugLog("Clicking...")
			button.click();
		}

		const content = await findElement(document, config.SELECTORS.FILE_CONTENT, 800)
		if (!content) {
			debugLog('Could not find file content');
			return 0;
		}

		const tokens = calculateTokens(content.textContent || '');
		debugLog(`Text file ${filename} tokens:`, tokens);

		if (tokens > 0) {
			await storageInterface.saveFileTokens(getConversationId(), filename, tokens, "content");
		}

		const closeButton = document.querySelector(config.SELECTORS.MODAL_CLOSE);
		if (closeButton) {
			closeButton.click();
			await sleep(200);
		}

		return tokens;
	}

	async function handleImageFile(button) {
		const filename = button.querySelector('.break-words')?.textContent;
		if (!filename) {
			debugLog('Could not find filename for image');
			return 0;
		}

		const stored = await storageInterface.getFileTokens(getConversationId(), filename, "content");
		if (stored !== undefined) {
			debugLog(`Using cached tokens for image: ${filename}`);
			return stored;
		}

		button.click();
		await sleep(200);

		const modalImage = document.querySelector('[role="dialog"] img[alt^="Preview of"]');
		if (!modalImage) {
			debugLog('Could not find image in modal');
			return 0;
		}

		const width = parseInt(modalImage.getAttribute('width'));
		const height = parseInt(modalImage.getAttribute('height'));

		if (!width || !height) {
			debugLog('Could not get image dimensions');
			return 0;
		}

		const tokens = Math.min(1600, Math.ceil((width * height) / 750));
		debugLog(`Image ${filename} (${width}x${height}) tokens:`, tokens);

		if (tokens > 0) {
			await storageInterface.saveFileTokens(getConversationId(), filename, tokens, "content");
		}

		const closeButton = document.querySelector('[data-testid="close-file-preview"]');
		if (closeButton) {
			closeButton.click();
			await sleep(200);
		}

		return tokens;
	}

	async function handlePDFFile(button) {
		const filename = button.querySelector('.break-words')?.textContent;
		if (!filename) {
			debugLog('Could not find filename for PDF');
			return 0;
		}

		const stored = await storageInterface.getFileTokens(getConversationId(), filename, "content");
		if (stored !== undefined) {
			debugLog(`Using cached tokens for PDF: ${filename}`);
			return stored;
		}

		button.click();
		await sleep(200);

		const dialog = document.querySelector('[role="dialog"]');
		if (!dialog) {
			debugLog('Could not find dialog - processing as text file.');
			return handleTextFile(button, true, filename);
		}

		const pageText = document.querySelector('[role="dialog"] .text-text-300 p')?.textContent;
		if (!pageText) {
			debugLog('Could not find page count text');
			return 0;
		}

		const pageCount = parseInt(pageText);
		if (isNaN(pageCount)) {
			debugLog('Could not parse page count from:', pageText);
			return 0;
		}

		const tokens = pageCount * 2250;
		debugLog(`PDF ${filename} (${pageCount} pages) tokens:`, tokens);

		if (tokens > 0) {
			await storageInterface.saveFileTokens(getConversationId(), filename, tokens, "content");
		}

		const closeButton = document.querySelector(`[role="dialog"] ${config.SELECTORS.MODAL_CLOSE}`);
		if (closeButton) {
			closeButton.click();
			await sleep(200);
		}

		return tokens;
	}

	async function handleCSVFile(button) {
		const filename = button.querySelector('.break-words')?.textContent;
		if (!filename) {
			debugLog('Could not find filename for CSV');
			return 0;
		}

		const stored = await storageInterface.getFileTokens(getConversationId(), filename, "content");
		if (stored !== undefined) {
			debugLog(`Using cached tokens for CSV: ${filename}`);
			return stored;
		}

		button.click();
		await sleep(200);

		const dialog = document.querySelector('[role="dialog"]');
		if (!dialog) {
			debugLog('Could not find dialog - processing as text file.');
			return handleTextFile(button, true, filename);
		} else {
			debugLog("Found dialog for CSV file - this means it is only going to be visible to the analysis tool. No cost.");
			await storageInterface.saveFileTokens(getConversationId(), filename, 0, "content");
			const closeButton = document.querySelector(`[role="dialog"] ${config.SELECTORS.MODAL_CLOSE}`);
			if (closeButton) {
				closeButton.click();
				await sleep(200);
			}
			return 0;
		}
	}

	async function getContentTokens() {
		let totalTokens = 0;

		const sidebar = document.querySelector(config.SELECTORS.SIDEBAR_CONTENT);
		if (!sidebar) {
			debugLog('Could not find sidebar');
			return 0;
		}

		// Find project files container if it exists
		const projectContainer = sidebar.querySelector(config.SELECTORS.PROJECT_FILES_CONTAINER);

		// Find all uls in the sidebar that aren't inside the project container
		const uls = Array.from(sidebar.querySelectorAll('ul')).filter(ul => {
			if (!projectContainer) return true;
			return !projectContainer.contains(ul);
		});

		// Find the files ul - it should be the one following the "Content" heading
		const contentUl = uls.find(ul => {
			const prevHeader = ul.previousElementSibling;
			return prevHeader?.tagName === 'H3' && prevHeader.textContent === 'Content';
		});

		if (!contentUl) {
			debugLog('Could not find content file list');
			return 0;
		}

		for (const li of contentUl.querySelectorAll('li')) {
			const button = li.querySelector('button');
			if (!button) continue;

			const isImage = !!button.querySelector('img');
			const isPDF = !!button.querySelector(config.SELECTORS.PDF_ICON);
			const isCSV = !!button.querySelector(config.SELECTORS.CSV_ICON);


			let tokens = 0;
			try {
				if (isImage) {
					debugLog('Processing image file...');
					tokens = await handleImageFile(button);
				} else if (isPDF) {
					debugLog('Processing PDF file...');
					tokens = await handlePDFFile(button);
				} else if (isCSV) {
					debugLog('Processing CSV file...');
					tokens = await handleCSVFile(button);
				} else {
					debugLog('Processing text file...');
					tokens = await handleTextFile(button);
				}
			} catch (error) {
				console.error('Error counting tokens for file:', error);
			}
			totalTokens += tokens;
		}

		return totalTokens;
	}

	async function handleArtifact(button, artifactName, versionCount) {
		debugLog("Handling artifact", artifactName);

		// Check cache first
		const stored = await storageInterface.getFileTokens(
			getConversationId(),
			`${artifactName}_v${versionCount}`,
			'artifact'
		);
		if (stored !== undefined) {
			debugLog(`Using cached tokens for artifact: ${artifactName} (${versionCount} versions)`);
			return stored;
		}

		// Open the artifact
		button.click();
		await sleep(200);

		const modalContainer = document.querySelector(config.SELECTORS.SIDEBAR_CONTENT);
		if (!modalContainer) {
			debugLog('Could not find modal container');
			return 0;
		}
		debugLog("Ensuring code mode...")
		// Ensure we're in code view if toggle exists
		const toggle = modalContainer.querySelector('[role="group"]');
		if (toggle) {
			const codeButton = toggle.querySelector('[data-testid="undefined-code"]');
			if (codeButton && codeButton.getAttribute('data-state') === 'off') {
				codeButton.click();
				await sleep(100);
			}
		}

		debugLog("Going left...")
		// First navigate all the way left
		while (true) {
			const versionButton = modalContainer.querySelector(config.SELECTORS.ARTIFACT_VERSION_SELECT);
			if (!versionButton) break;

			const leftArrow = versionButton.previousElementSibling;
			if (!leftArrow || leftArrow.hasAttribute('disabled')) break;

			leftArrow.click();
			await sleep(200);
		}


		let totalTokens = 0;
		let currentVersion = 1;
		debugLog("Going right...")
		// Now go through all versions from left to right
		while (true) {
			// Count tokens for current version
			const codeBlock = modalContainer.querySelector('.code-block__code code');
			if (codeBlock) {
				const versionTokens = calculateTokens(codeBlock.textContent || '');
				totalTokens += versionTokens;
				debugLog(`${artifactName} - Version ${currentVersion}/${versionCount}: ${versionTokens} tokens`);
				currentVersion++;
			}

			// Try to go right
			const versionButton = modalContainer.querySelector(config.SELECTORS.ARTIFACT_VERSION_SELECT);
			if (!versionButton) break;

			const rightArrow = versionButton.nextElementSibling;
			if (!rightArrow || rightArrow.hasAttribute('disabled')) break;

			rightArrow.click();
			await sleep(100);
		}

		debugLog(`${artifactName} - Total tokens across all versions: ${totalTokens}`);

		if (totalTokens > 0) {
			await storageInterface.saveFileTokens(
				getConversationId(),
				`${artifactName}_v${versionCount}`,
				totalTokens,
				'artifact'
			);
		}

		// Close the artifact view
		const backButton = modalContainer.querySelector(config.SELECTORS.BACK_BUTTON);
		if (backButton) {
			backButton.click();
			await sleep(200);
		}

		return totalTokens;
	}

	async function getArtifactTokens() {
		let totalTokens = 0;
		const processedNames = new Set();

		while (true) {
			const sidebar = document.querySelector(config.SELECTORS.SIDEBAR_CONTENT);
			if (!sidebar) {
				debugLog('Could not find sidebar');
				break;
			}

			// Find artifacts list again (since it may have been recreated)
			const artifactsUl = Array.from(sidebar.querySelectorAll('ul')).find(ul => {
				const prevHeader = ul.previousElementSibling;
				return prevHeader?.tagName === 'H3' && prevHeader.textContent === 'Artifacts';
			});

			if (!artifactsUl) {
				debugLog('Could not find artifacts list');
				break;
			}

			// Find an unprocessed artifact
			let foundNew = false;
			for (const li of artifactsUl.querySelectorAll('li')) {
				const button = li.querySelector('button');
				if (!button) continue;

				const name = button.querySelector('.break-words')?.textContent;
				if (!name || processedNames.has(name)) continue;
				debugLog('Processing artifact:', name);

				const description = button.querySelector('.text-text-400')?.textContent;
				const versionMatch = description?.match(/(\d+) versions?$/);
				const versionCount = versionMatch ? parseInt(versionMatch[1]) : 1;
				debugLog("Version count:", versionCount);

				// Found a new artifact to process
				processedNames.add(name);
				foundNew = true;
				let newTokens = await handleArtifact(button, name, versionCount);
				debugLog("Artifact tokens:", newTokens);
				totalTokens += newTokens
				break;
			}

			// If we didn't find any new artifacts, we're done
			if (!foundNew) break;
		}

		return totalTokens;
	}
	//#endregion

	//#region UI elements
	function createModelSection(modelName, isActive) {
		const container = document.createElement('div');
		container.style.cssText = `
			margin-bottom: 12px;
			border-bottom: 1px solid #3B3B3B;
			padding-bottom: 8px;
			opacity: ${isActive ? '1' : '0.7'};
			transition: opacity 0.2s;
			${isMobileView() && !isActive ? 'display: none;' : ''}
		`;

		container.style.cssText += `
        	position: relative;
    	`;

		const header = document.createElement('div');
		header.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            color: white;
            font-size: 12px;
        `;

		const arrow = document.createElement('div');
		arrow.innerHTML = '▼';
		arrow.style.cssText = `
            cursor: pointer;
            transition: transform 0.2s;
            font-size: 10px;
        `;

		const title = document.createElement('div');
		title.textContent = modelName;
		title.style.cssText = `flex-grow: 1;`;

		const activeIndicator = document.createElement('div');
		activeIndicator.style.cssText = `
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #3b82f6;
            opacity: ${isActive ? '1' : '0'};
            transition: opacity 0.2s;
        `;

		header.appendChild(arrow);
		header.appendChild(title);
		header.appendChild(activeIndicator);

		const content = document.createElement('div');

		// Remove currentCountDisplay, only keep resetTimeDisplay and progress bar
		const resetTimeDisplay = document.createElement('div');
		resetTimeDisplay.style.cssText = `
			color: #888;
			font-size: 11px;
			margin-bottom: 8px;
		`;
		resetTimeDisplay.textContent = 'Reset in: Not set.';


		const progressContainer = document.createElement('div');
		progressContainer.style.cssText = `
            background: #3B3B3B;
            height: 6px;
            border-radius: 3px;
            overflow: hidden;
        `;

		const progressBar = document.createElement('div');
		progressBar.style.cssText = `
            width: 0%;
            height: 100%;
            background: #3b82f6;
            transition: width 0.3s ease, background-color 0.3s ease;
        `;

		const tooltip = document.createElement('div');
		tooltip.style.cssText = `
			position: absolute;
			bottom: 100%;
			left: 50%;
			transform: translateX(-50%);
			background: rgba(0, 0, 0, 0.9);
			color: white;
			padding: 4px 8px;
			border-radius: 4px;
			font-size: 12px;
			opacity: 0;
			transition: opacity 0.2s;
			pointer-events: none;
			margin-bottom: 4px;
			white-space: nowrap;
			z-index: 10000;
		`;

		// Add hover events to the section container
		container.addEventListener('mouseenter', () => {
			tooltip.style.opacity = '1';
		});
		container.addEventListener('mouseleave', () => {
			tooltip.style.opacity = '0';
		});

		progressContainer.appendChild(progressBar);

		const messageCounter = document.createElement('div');
		messageCounter.style.cssText = `
			color: #888;
			font-size: 11px;
			margin-top: 4px;
		`;
		messageCounter.textContent = 'Messages: 0';
		content.appendChild(messageCounter);  // Add the counter

		content.appendChild(resetTimeDisplay);
		content.appendChild(progressContainer);
		content.appendChild(tooltip);

		container.appendChild(header);
		container.appendChild(content);

		// Add collapsed state tracking
		let isCollapsed = !isActive; // Start collapsed if not active
		content.style.display = isCollapsed ? 'none' : 'block';
		arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';

		// Toggle section collapse/expand
		arrow.addEventListener('click', (e) => {
			e.stopPropagation();
			isCollapsed = !isCollapsed;
			content.style.display = isCollapsed ? 'none' : 'block';
			arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';
		});

		function setActive(active) {
			activeIndicator.style.opacity = active ? '1' : '0';
			container.style.opacity = active ? '1' : '0.7';

			if (isMobileView()) {
				// In mobile, completely hide inactive sections
				container.style.display = active ? 'block' : 'none';
			} else {
				// In desktop, just collapse inactive sections
				container.style.display = 'block';
				if (active) {
					isCollapsed = false;
					content.style.display = 'block';
					arrow.style.transform = '';
				} else {
					isCollapsed = true;
					content.style.display = 'none';
					arrow.style.transform = 'rotate(-90deg)';
				}
			}
		}

		return {
			container,
			progressBar,
			resetTimeDisplay,
			tooltip,
			messageCounter,
			setActive
		};
	}

	function createSettingsButton() {
		const button = document.createElement('div');
		button.innerHTML = `
			<svg viewBox="0 0 24 24" width="20" height="20" style="cursor: pointer;">
				<path fill="currentColor" d="M12,15.5A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Zm0-5A1.5,1.5,0,1,0,13.5,12,1.5,1.5,0,0,0,12,10.5Zm7.11,4.13a7.92,7.92,0,0,0,.14-1.64s0-.08,0-.12l1.87-.93a.34.34,0,0,0,.14-.45l-1.36-2.36a.34.34,0,0,0-.44-.14l-1.94,1a7.49,7.49,0,0,0-1.42-.82l-.22-2.16a.34.34,0,0,0-.34-.3H12.36a.34.34,0,0,0-.34.3l-.22,2.16a7.49,7.49,0,0,0-1.42.82l-1.94-1a.34.34,0,0,0-.44.14L6.64,11.89a.34.34,0,0,0,.14.45l1.87.93c0,.04,0,.08,0,.12a7.92,7.92,0,0,0,.14,1.64l-1.87.93a.34.34,0,0,0-.14.45l1.36,2.36a.34.34,0,0,0,.44.14l1.94-1a7.49,7.49,0,0,0,1.42.82l.22,2.16a.34.34,0,0,0,.34.3h2.72a.34.34,0,0,0,.34-.3l.22-2.16a7.49,7.49,0,0,0,1.42-.82l1.94,1a.34.34,0,0,0,.44-.14l1.36-2.36a.34.34,0,0,0-.14-.45Z"/>
			</svg>
		`;
		button.style.cssText = `
			margin-left: auto;
			display: flex;
			align-items: center;
			color: #3b82f6;
		`;
		return button;
	}

	async function createSettingsPopup() {
		const popup = document.createElement('div');
		popup.style.cssText = `
			position: absolute;
			bottom: 100%;
			right: 0;
			background: #2D2D2D;
			border: 1px solid #3B3B3B;
			border-radius: 8px;
			padding: 12px;
			margin-bottom: 8px;
			z-index: 10000;
			max-height: 300px;
			overflow-y: auto;
			width: 250px;
		`;

		const checkboxContainer = document.createElement('div');
		checkboxContainer.style.cssText = `
			display: flex;
			flex-direction: column;
			gap: 8px;
		`;

		const states = await storageInterface.getCheckboxStates();

		Object.entries(config.FEATURE_CHECKBOXES).forEach(([key, option]) => {
			const wrapper = document.createElement('div');
			wrapper.style.cssText = `
				display: flex;
				align-items: center;
				gap: 8px;
			`;

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = states[key] || false;
			checkbox.addEventListener('change', async (e) => {
				await storageInterface.setCheckboxState(key, e.target.checked);
				await updateProgressBar(await countTokens(), true);  // Update UI to reflect new costs
			});

			const label = document.createElement('label');
			label.style.cssText = `
				color: white;
				font-size: 12px;
				flex-grow: 1;
			`;
			label.textContent = `${option.text} (+${option.cost})`;

			wrapper.appendChild(checkbox);
			wrapper.appendChild(label);
			checkboxContainer.appendChild(wrapper);
		});

		popup.appendChild(checkboxContainer);
		return popup;
	}


	async function createUI() {
		const currentModel = getCurrentModel();
		const container = document.createElement('div');
		container.style.cssText = `
			position: fixed;
			bottom: 20px;
			right: 20px;
			background: #2D2D2D;
			border: 1px solid #3B3B3B;
			border-radius: 8px;
			z-index: 9999;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
			user-select: none;
		`;

		// Header (always visible)
		const header = document.createElement('div');
		header.style.cssText = `
			display: flex;
			align-items: center;
			padding: 8px 10px;
			color: white;
			font-size: 12px;
			gap: 8px;
			cursor: move;
		`;

		const arrow = document.createElement('div');
		arrow.innerHTML = '▼';
		arrow.style.cssText = `
			cursor: pointer;
			transition: transform 0.2s;
		`;

		const settingsButton = createSettingsButton();
		let settingsPopup = null;

		settingsButton.addEventListener('click', async (e) => {
			e.stopPropagation();

			if (settingsPopup) {
				settingsPopup.remove();
				settingsPopup = null;
				return;
			}

			settingsPopup = await createSettingsPopup();
			header.appendChild(settingsPopup);
		});

		header.appendChild(arrow);
		header.appendChild(document.createTextNode('Usage Tracker'));
		header.appendChild(settingsButton);

		// Counters
		const currentConversationDisplay = document.createElement('div');
		currentConversationDisplay.style.cssText = `
			color: white;
			font-size: 12px;
			padding: 0 10px;
			margin-bottom: 8px;
			border-bottom: 1px solid #3B3B3B;
			padding-bottom: 8px;
		`;

		const estimateDisplay = document.createElement('div');
		estimateDisplay.id = 'messages-left-estimate';
		estimateDisplay.style.cssText = `
			color: white;
			font-size: 12px;
		`;
		estimateDisplay.textContent = 'Est. messages left: Loading...';

		const lengthDisplay = document.createElement('div');
		lengthDisplay.id = 'conversation-token-count';
		lengthDisplay.style.cssText = `
			color: #888;
			font-size: 11px;
			margin-top: 4px;
		`;
		lengthDisplay.textContent = 'Current cost: 0 tokens';

		currentConversationDisplay.appendChild(estimateDisplay);
		currentConversationDisplay.appendChild(lengthDisplay);

		// Content container (collapsible)
		const content = document.createElement('div');
		content.style.cssText = `
			padding: 0 10px 10px 10px;
			width: 250px;
		`;

		// Create sections for each model
		config.MODELS.forEach(model => {
			const isActive = model === currentModel;
			const section = createModelSection(model, isActive);
			modelSections[model] = section;
			content.appendChild(section.container);
		});

		container.appendChild(header);
		container.appendChild(currentConversationDisplay);
		container.appendChild(content);
		document.body.appendChild(container);

		// Get stored collapse state
		let isCollapsed = await storageInterface.getCollapsedState();
		content.style.display = isCollapsed ? 'none' : 'block';
		arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';

		// Toggle collapse/expand
		arrow.addEventListener('click', async (e) => {
			e.stopPropagation();
			isCollapsed = !isCollapsed;
			content.style.display = isCollapsed ? 'none' : 'block';
			arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';

			// Also hide lengthDisplay on mobile
			if (isMobileView()) {
				lengthDisplay.style.display = isCollapsed ? 'none' : 'block';
			}

			// Store the new state
			await storageInterface.setCollapsedState(isCollapsed);
		});

		if (isMobileView() && isCollapsed) {
			lengthDisplay.style.display = 'none';
		}

		// Dragging functionality
		let isDragging = false;
		let currentX;
		let currentY;
		let initialX;
		let initialY;

		function handleDragStart(e) {
			if (e.target === arrow) return;

			isDragging = true;
			if (e.type === "mousedown") {
				initialX = e.clientX - container.offsetLeft;
				initialY = e.clientY - container.offsetTop;
			} else if (e.type === "touchstart") {
				initialX = e.touches[0].clientX - container.offsetLeft;
				initialY = e.touches[0].clientY - container.offsetTop;
			}
			header.style.cursor = 'grabbing';
		}

		function handleDragMove(e) {
			if (!isDragging) return;
			e.preventDefault();

			if (e.type === "mousemove") {
				currentX = e.clientX - initialX;
				currentY = e.clientY - initialY;
			} else if (e.type === "touchmove") {
				currentX = e.touches[0].clientX - initialX;
				currentY = e.touches[0].clientY - initialY;
			}

			const maxX = window.innerWidth - container.offsetWidth;
			const maxY = window.innerHeight - container.offsetHeight;
			currentX = Math.min(Math.max(0, currentX), maxX);
			currentY = Math.min(Math.max(0, currentY), maxY);

			container.style.left = `${currentX}px`;
			container.style.top = `${currentY}px`;
			container.style.right = 'auto';
			container.style.bottom = 'auto';
		}

		function handleDragEnd() {
			isDragging = false;
			header.style.cursor = 'move';
		}

		// Mouse events
		header.addEventListener('mousedown', handleDragStart);
		document.addEventListener('mousemove', handleDragMove);
		document.addEventListener('mouseup', handleDragEnd);

		// Touch events
		header.addEventListener('touchstart', handleDragStart, { passive: false });
		document.addEventListener('touchmove', handleDragMove, { passive: false });
		document.addEventListener('touchend', handleDragEnd);
		document.addEventListener('touchcancel', handleDragEnd);
	}

	async function updateProgressBar(conversationLength, updateLength = true, shouldCollapse = false) {
		// Update each model section
		debugLog("Updating progress bar...", conversationLength)

		const lengthDisplay = document.getElementById('conversation-token-count');
		if (lengthDisplay && updateLength) {
			lengthDisplay.textContent = `Current cost: ${conversationLength.toLocaleString()} tokens`;
		}

		// Update messages left estimate
		const estimateDisplay = document.getElementById('messages-left-estimate');
		if (estimateDisplay && updateLength) {
			const estimate = await storageInterface.calculateMessagesLeft(currentlyDisplayedModel, conversationLength);
			estimateDisplay.textContent = `Est. messages left: ${estimate}`;
		}

		// Update each model section
		config.MODELS.forEach(async modelName => {
			const section = modelSections[modelName];
			if (!section) return;

			const isActiveModel = modelName === currentlyDisplayedModel;
			if (shouldCollapse || isMobileView()) {  // Only call setActive when we actually want to collapse OR if we're on mobile.
				section.setActive(isActiveModel);
			}

			const stored = await storageInterface.getModelData(modelName);

			if (stored) {
				const modelTotal = stored.total;
				const messageCount = stored.messageCount || 0;
				const maxTokens = config.MODEL_TOKEN_CAPS[modelName] || config.MODEL_TOKEN_CAPS.default;
				const percentage = (modelTotal / maxTokens) * 100;

				section.progressBar.style.width = `${Math.min(percentage, 100)}%`;
				section.progressBar.style.background = modelTotal >= maxTokens * config.WARNING_THRESHOLD ? '#ef4444' : '#3b82f6';
				section.tooltip.textContent = `${modelTotal.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${percentage.toFixed(1)}%)`;
				section.messageCounter.textContent = `Messages: ${messageCount}`;

				section.resetTimeDisplay.textContent = await storageInterface.getFormattedTimeRemaining(modelName);
			} else {
				section.progressBar.style.width = '0%';
				section.tooltip.textContent = `0 / ${config.MODEL_TOKEN_CAPS[modelName].toLocaleString()} tokens (0.0%)`;
				section.messageCounter.textContent = `Messages: 0`;
				section.resetTimeDisplay.textContent = 'Reset in: Not set';
			}
		});
	}
	//#endregion

	//#region Token Count
	async function getOutputMessage(maxWaitSeconds = 60) {
		debugLog("Waiting for AI response...");
		const startTime = Date.now();
		let consecutiveSuccesses = 0;

		// Wait for complete set of messages
		while (Date.now() - startTime < maxWaitSeconds * 1000) {
			const messages = document.querySelectorAll(config.SELECTORS.AI_MESSAGE);
			const userMessages = document.querySelectorAll(config.SELECTORS.USER_MESSAGE);

			if (messages.length >= userMessages.length) {
				// Check if all messages have explicitly finished streaming
				let allFinished = true;
				messages.forEach(msg => {
					const parent = msg.closest('[data-is-streaming]');
					if (!parent || parent.getAttribute('data-is-streaming') !== 'false') {
						allFinished = false;
					}
				});

				if (allFinished) {
					consecutiveSuccesses++;
					debugLog(`All messages marked complete, success ${consecutiveSuccesses}/3`);
					if (consecutiveSuccesses >= 3) {
						debugLog("Three consecutive successes, returning last response");
						return messages[messages.length - 1];
					}
				} else {
					if (consecutiveSuccesses > 0) {
						debugLog(`Reset success counter from ${consecutiveSuccesses} to 0`);
					}
					consecutiveSuccesses = 0;
				}
			}
			await sleep(100);
		}

		debugLog("No complete response received within timeout");
		return null;
	}

	async function countTokens() {
		const userMessages = document.querySelectorAll(config.SELECTORS.USER_MESSAGE);
		const aiMessages = document.querySelectorAll(config.SELECTORS.AI_MESSAGE);
		if (!aiMessages || !userMessages || userMessages.length === 0) {
			return null;
		}

		debugLog('Found user messages:', userMessages);
		debugLog('Found AI messages:', aiMessages);

		let currentCount = 0;
		let AI_output = null;

		// Count user messages
		userMessages.forEach((msg, index) => {
			const text = msg.textContent || '';
			const tokens = calculateTokens(text);
			debugLog(`User message ${index}, length ${tokens}:`, msg);
			//debugLog(`Text: "${text}"`);
			currentCount += tokens;
		});

		// Check if we have a complete set of AI messages
		if (aiMessages.length !== 0) {
			const lastMessage = aiMessages[aiMessages.length - 1];
			const lastParent = lastMessage.closest('[data-is-streaming]');

			if (aiMessages.length >= userMessages.length &&
				lastParent && lastParent.getAttribute('data-is-streaming') === 'false') {
				debugLog("Found complete set of messages, last AI message is complete");
				AI_output = lastMessage;
			}
		}



		// Count all AI messages except the final output (if already present)
		let analysisToolUsed = false;
		aiMessages.forEach((msg, index) => {
			// Skip if this is the final output we're saving for later
			if (msg === AI_output) {
				debugLog(`Skipping AI message ${index} - will process later as final output`);
				return;
			}

			const parent = msg.closest('[data-is-streaming]');
			if (parent && parent.getAttribute('data-is-streaming') === 'false') {
				const text = msg.textContent || '';
				const tokens = calculateTokens(text); // No multiplication for intermediate responses
				debugLog(`AI message ${index}, length ${tokens}:`, msg);
				currentCount += tokens;

				const button = msg.querySelector('button.flex.justify-start.items-center.pt-2');
				if (button && button.textContent.trim() === 'View analysis') {
					debugLog('Found the "View analysis" button in AI message', index);
					analysisToolUsed = true;
				}
			} else {
				debugLog(`Skipping AI message ${index} - still streaming`);
			}
		});

		if (analysisToolUsed && !await storageInterface.getCheckboxStates().analysis_enabled) {
			debugLog("Analysis tool used but checkbox disabled, adding analysis cost");
			currentCount += config.FEATURE_CHECKBOXES.analysis_enabled.cost
		}

		// Handle files from sidebar
		if (await ensureSidebarLoaded()) {
			try {
				currentCount += await getContentTokens();
				currentCount += await getProjectTokens();
			} catch (error) {
				console.error('Error processing files:', error);
			} finally {
				closeSidebar();	//We don't want the sidebar to stay open while the AI output is loading.
			}

		} else {
			debugLog("Could not load sidebar, skipping files");
		}


		if (!AI_output) {
			debugLog("No complete AI output found, waiting...");
			AI_output = await getOutputMessage();
		}

		// Process the AI output if we have it (with multiplication)
		if (AI_output) {
			const text = AI_output.textContent || '';
			const tokens = calculateTokens(text) * config.OUTPUT_TOKEN_MULTIPLIER;
			debugLog("Processing final AI output:");
			debugLog(`Text: "${text}"`);
			debugLog(`Tokens (weighted by ${config.OUTPUT_TOKEN_MULTIPLIER}x): ${tokens}`);
			currentCount += tokens;
		}

		debugLog("Now that we've waited for the AI output, we can process artifacts.")

		if (await ensureSidebarLoaded()) {
			try {
				const artifactsTokenCount = await getArtifactTokens();
				currentCount += artifactsTokenCount;

				// If we found artifacts but the checkbox isn't enabled, add the cost
				if (artifactsTokenCount > 0) {
					if (!await storageInterface.getCheckboxStates().artifacts_enabled) {
						debugLog("Found artifacts in use but checkbox disabled, adding artifacts cost");
						currentCount += config.FEATURE_CHECKBOXES.artifacts_enabled.cost;
					}
				}
			} catch (error) {
				console.error('Error processing files:', error);
			}
		}

		currentCount += config.BASE_SYSTEM_PROMPT_LENGTH;
		currentCount += await storageInterface.getExtraCost();

		// Ensure sidebar is closed...
		debugLog("Closing sidebar after processing all files...")
		await sleep(100);
		closeSidebar();

		return currentCount;
	}
	//#endregion

	//#region Event Handlers
	function pollUIUpdates() {
		setInterval(async () => {
			let userId = await getUserId();
			if (userId) {
				await storageInterface.setUserId(userId);
			}
			if (isProcessingUIEvent) {
				debugLog('Event processing in progress, skipping UI poll update');
				return;
			}
			const newModel = getCurrentModel();
			const currentTime = new Date();
			let needsUpdate = false;

			// Check checkbox states
			const currentCheckboxState = await storageInterface.getCheckboxStates();
			if (JSON.stringify(currentCheckboxState) !== JSON.stringify(lastCheckboxState)) {
				debugLog('Checkbox states changed, updating...');
				lastCheckboxState = { ...currentCheckboxState };
				needsUpdate = true;
			}

			// Check conversation state
			const conversationId = getConversationId();
			if (conversationId == null) {
				debugLog("No conversation active, updating progressbar...")
				await updateProgressBar(config.BASE_SYSTEM_PROMPT_LENGTH + await storageInterface.getExtraCost(), true, newModel !== currentlyDisplayedModel);
			}
			const messages = document.querySelectorAll(`${config.SELECTORS.USER_MESSAGE}, ${config.SELECTORS.AI_MESSAGE}`);

			if ((conversationId !== currentConversationId && conversationId !== null) || messages.length !== currentMessageCount) {
				debugLog('Conversation changed, recounting tokens');
				currentConversationId = conversationId;
				currentMessageCount = messages.length;
				needsUpdate = true;
			}

			// Check for model change
			if (newModel !== currentlyDisplayedModel) {
				debugLog(`Model changed from ${currentlyDisplayedModel} to ${newModel}`);
				currentlyDisplayedModel = newModel;
				// Update all sections - will collapse inactive ones
				config.MODELS.forEach(modelName => {
					const section = modelSections[modelName];
					if (section) {
						section.setActive(modelName === currentlyDisplayedModel);
					}
				});
				needsUpdate = true;
			}

			// Check each model's reset time, update countdown, and check for total changes
			for (const model of config.MODELS) {
				const stored = await storageInterface.getModelData(model);
				const section = modelSections[model];
				if (stored) {
					section.resetTimeDisplay.textContent = await storageInterface.getFormattedTimeRemaining(model);
					const displayedTotal = parseInt(section.tooltip.textContent
						.split('/')[0]
						.replace(/[,\.]/g, '')
						.trim());
					if (stored.total !== displayedTotal) {
						debugLog(`Detected change in total for ${model}: ${displayedTotal} -> ${stored.total}`);
						needsUpdate = true;
					}
				} else {
					section.resetTimeDisplay.textContent = 'Reset in: Not set';
					if (!section.tooltip.textContent.startsWith('0')) {
						needsUpdate = true;
					}
				}
			}

			// Update UI if needed
			if (needsUpdate) {
				debugLog("Updating bar from poll event...")
				let newTokenCount = await countTokens();
				if (!newTokenCount)
					return
				await updateProgressBar(newTokenCount, true, newModel !== currentlyDisplayedModel);
			}
		}, config.UI_UPDATE_INTERVAL_MS);
	}


	async function updateTokenTotal() {
		isProcessingUIEvent = true;
		try {
			const delay = getConversationId() ? config.CONVO_DELAY_MS : config.UNITIALIZED_CONVO_DELAY_MS;
			debugLog(`Waiting ${delay}ms before counting tokens`);
			await sleep(delay);

			const currentModel = getCurrentModel();
			const newCount = await countTokens();
			if (!newCount) return;

			let tries = 0;
			while (currentModel === "default" && tries < 10) {
				await sleep(200);
				currentModel = getCurrentModel();
				tries++;
			}

			if (currentModel !== "default") {
				const { totalTokenCount, messageCount } = await await storageInterface.addTokensToModel(currentModel, newCount);
				debugLog(`Current conversation tokens: ${newCount}`);
				debugLog(`Total accumulated tokens: ${totalTokenCount}`);
				debugLog(`Messages used: ${messageCount}`);
				debugLog(`Added to model: ${currentModel}!`);
			} else {
				debugLog("Timed out waiting for model to change from 'default'");
			}

			await updateProgressBar(newCount, false);
		} finally {
			isProcessingUIEvent = false;
		}
	}

	function setupEvents() {
		debugLog("Setting up tracking...")
		document.addEventListener('click', async (e) => {
			const regenerateButton = e.target.closest(`button:has(path[d="${config.SELECTORS.REGENERATE_BUTTON_PATH}"])`);
			const saveButton = e.target.closest(config.SELECTORS.SAVE_BUTTON);
			const sendButton = e.target.closest('button[aria-label="Send Message"]');

			if (saveButton) {
				const renameChatDialog = saveButton.closest('div[role="dialog"]')?.querySelector('h2');
				if (renameChatDialog?.textContent === 'Rename chat') {
					debugLog('Save button clicked in rename dialog, ignoring');
					return;
				}
			}

			if (regenerateButton || saveButton || sendButton) {
				debugLog('Clicked:', e.target);
				debugLog('Event details:', e);
				await updateTokenTotal();
				return;
			}
		});

		document.addEventListener('keydown', async (e) => {
			const mainInput = e.target.closest(config.SELECTORS.MAIN_INPUT);
			const editArea = e.target.closest(config.SELECTORS.EDIT_TEXTAREA);

			// For edit areas, only proceed if it's within a user message
			if (editArea) {
				const renameChatDialog = editArea.closest('div[role="dialog"]')?.querySelector('h2');
				if (renameChatDialog?.textContent === 'Rename chat') {
					debugLog('Enter pressed in rename dialog, ignoring');
					return;
				}
			}

			if ((mainInput || editArea) && e.key === 'Enter' && !e.shiftKey) {
				debugLog('Enter pressed in:', e.target);
				debugLog('Event details:', e);
				await updateTokenTotal();
				return;
			}
		});
	}
	//#endregion
	async function initialize() {
		const MAX_RETRIES = 15;
		const RETRY_DELAY = 200;
		// Load and assign configuration to global variables
		debugLog("Calling browser message...")
		config = await browser.runtime.sendMessage({ type: 'getConfig' });
		debugLog(config)
		config.MODELS = Object.keys(config.MODEL_TOKEN_CAPS).filter(key => key !== 'default');

		// Check for duplicate running with retry logic
		let userMenuButton = null;
		let attempts = 0;

		while (!userMenuButton && attempts < MAX_RETRIES) {
			userMenuButton = document.querySelector(config.SELECTORS.USER_MENU_BUTTON);

			if (!userMenuButton) {
				debugLog(`User menu button not found, attempt ${attempts + 1}/${MAX_RETRIES}`);
				await sleep(RETRY_DELAY);
				attempts++;
			}
		}

		if (!userMenuButton) {
			console.error('User menu button not found after all attempts');
			return;
		}

		if (userMenuButton.getAttribute('data-script-loaded')) {
			debugLog('Script already running, stopping duplicate');
			return;
		}
		userMenuButton.setAttribute('data-script-loaded', true);
		debugLog('We\'re unique, initializing Chat Token Counter...');

		storageInterface = new TokenStorageInterface();
		let userId = await getUserId();
		if (userId) {
			await storageInterface.setUserId(userId);
		}
		// Initialize everything else
		currentlyDisplayedModel = getCurrentModel();
		lastCheckboxState = await storageInterface.getCheckboxStates();

		setupEvents();
		await createUI();
		await updateProgressBar(0);
		pollUIUpdates();
		debugLog('Initialization complete. Ready to track tokens.');
	}

	(async () => {
		try {
			await initialize();
		} catch (error) {
			console.error('Failed to initialize Chat Token Counter:', error);
		}
	})();
})();
