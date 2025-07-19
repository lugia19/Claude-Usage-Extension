'use strict';

// Draggable functionality for cards
function makeDraggable(element, dragHandle = null) {
	let isDragging = false;
	let currentX;
	let currentY;
	let initialX;
	let initialY;
	let pointerId = null; // Track which pointer is dragging

	// If no specific drag handle is provided, the entire element is draggable
	const dragElement = dragHandle || element;

	function handleDragStart(e) {
		// Only start dragging if we're not already dragging
		if (isDragging) return;
		
		isDragging = true;
		pointerId = e.pointerId;
		
		// Capture the pointer to this element
		dragElement.setPointerCapture(e.pointerId);
		
		initialX = e.clientX - element.offsetLeft;
		initialY = e.clientY - element.offsetTop;
		
		dragElement.style.cursor = 'grabbing';
		
		// Prevent text selection during drag
		e.preventDefault();
	}

	function handleDragMove(e) {
		if (!isDragging || e.pointerId !== pointerId) return;
		e.preventDefault();

		currentX = e.clientX - initialX;
		currentY = e.clientY - initialY;

		// Ensure the element stays within the viewport
		const maxX = window.innerWidth - element.offsetWidth;
		const maxY = window.innerHeight - element.offsetHeight;
		currentX = Math.min(Math.max(0, currentX), maxX);
		currentY = Math.min(Math.max(0, currentY), maxY);

		element.style.left = `${currentX}px`;
		element.style.top = `${currentY}px`;
		element.style.right = 'auto';
		element.style.bottom = 'auto';
	}

	function handleDragEnd(e) {
		if (e.pointerId !== pointerId) return;
		
		isDragging = false;
		pointerId = null;
		dragElement.style.cursor = dragHandle ? 'move' : 'grab';
		
		// Release the pointer capture
		dragElement.releasePointerCapture(e.pointerId);
	}

	// Pointer events (covers mouse, touch, and pen)
	dragElement.addEventListener('pointerdown', handleDragStart);
	dragElement.addEventListener('pointermove', handleDragMove);
	dragElement.addEventListener('pointerup', handleDragEnd);
	dragElement.addEventListener('pointercancel', handleDragEnd);

	// Set initial cursor style
	dragElement.style.cursor = dragHandle ? 'move' : 'grab';
	
	// Prevent touch scrolling when dragging
	dragElement.style.touchAction = 'none';

	// Return a cleanup function
	return () => {
		dragElement.removeEventListener('pointerdown', handleDragStart);
		dragElement.removeEventListener('pointermove', handleDragMove);
		dragElement.removeEventListener('pointerup', handleDragEnd);
		dragElement.removeEventListener('pointercancel', handleDragEnd);
	};
}

// Base floating card class
class FloatingCard {
	constructor() {
		this.defaultPosition = { top: '20px', right: '20px' }
		this.element = document.createElement('div');
		this.element.className = 'bg-bg-100 border border-border-400 text-text-000 ut-card';
	}

	addCloseButton() {
		const closeButton = document.createElement('button');
		closeButton.className = 'ut-button ut-close text-base';
		closeButton.style.color = BLUE_HIGHLIGHT;
		closeButton.style.background = 'none';
		closeButton.textContent = '×';
		closeButton.addEventListener('click', () => this.remove());
		this.element.appendChild(closeButton);
	}

	show(position) {
		// If position is provided, use it instead of default
		if (position) {
			// Clear any previous position styles
			['top', 'right', 'bottom', 'left'].forEach(prop => {
				this.element.style[prop] = null;
			});
			// Apply new position
			Object.entries(position).forEach(([key, value]) => {
				this.element.style[key] = typeof value === 'number' ? `${value}px` : value;
			});
		} else {
			// Apply default position
			Object.entries(this.defaultPosition).forEach(([key, value]) => {
				this.element.style[key] = value;
			});
		}
		document.body.appendChild(this.element);
	}

	makeCardDraggable(dragHandle = null) {
		this.cleanup = makeDraggable(this.element, dragHandle);
	}

	remove() {
		if (this.cleanup) {
			this.cleanup();
		}
		this.element.remove();
	}
}

// Version/donation notification card
class VersionNotificationCard extends FloatingCard {
	constructor(donationInfo) {
		super();
		this.donationInfo = donationInfo;
		this.element.classList.add('ut-text-center');
		this.element.style.maxWidth = '250px';
		this.build();
	}

	build() {
		const dragHandle = document.createElement('div');
		dragHandle.className = 'border-b border-border-400 ut-header';
		dragHandle.textContent = 'Usage Tracker';

		const message = document.createElement('div');
		message.className = 'ut-mb-2';
		message.textContent = this.donationInfo.versionMessage;

		let patchContainer = null;
		if (this.donationInfo.patchHighlights?.length > 0) {
			patchContainer = document.createElement('div');
			patchContainer.className = 'bg-bg-000 ut-content-box ut-text-left ut-mb-2';
			patchContainer.style.maxHeight = '150px';

			if (!this.donationInfo.patchHighlights[0].includes("donation")) {
				const patchTitle = document.createElement('div');
				patchTitle.textContent = "What's New:";
				patchTitle.style.fontWeight = 'bold';
				patchTitle.className = 'ut-mb-1';
				patchContainer.appendChild(patchTitle);
			}

			const patchList = document.createElement('ul');
			patchList.style.paddingLeft = '12px';
			patchList.style.margin = '0';
			patchList.style.listStyleType = 'disc';

			this.donationInfo.patchHighlights.forEach(highlight => {
				const item = document.createElement('li');
				item.textContent = highlight;
				item.style.marginBottom = '3px';
				item.style.paddingLeft = '3px';
				patchList.appendChild(item);
			});

			patchContainer.appendChild(patchList);
		}

		const patchNotesLink = document.createElement('a');
		patchNotesLink.href = 'https://github.com/lugia19/Claude-Usage-Extension/releases';
		patchNotesLink.target = '_blank';
		patchNotesLink.className = 'ut-link ut-block ut-mb-2';
		patchNotesLink.style.color = BLUE_HIGHLIGHT;
		patchNotesLink.textContent = 'View full release notes';

		const kofiButton = document.createElement('a');
		kofiButton.href = 'https://ko-fi.com/R6R14IUBY';
		kofiButton.target = '_blank';
		kofiButton.className = 'ut-block ut-text-center';
		kofiButton.style.marginTop = '10px';

		const kofiImg = document.createElement('img');
		kofiImg.src = browser.runtime.getURL('kofi-button.png');
		kofiImg.height = 36;
		kofiImg.style.border = '0';
		kofiImg.alt = 'Buy Me a Coffee at ko-fi.com';
		kofiButton.appendChild(kofiImg);

		// Assemble
		this.element.appendChild(dragHandle);
		this.element.appendChild(message);
		if (patchContainer) this.element.appendChild(patchContainer);
		this.element.appendChild(patchNotesLink);
		this.element.appendChild(kofiButton);
		this.addCloseButton();
		this.makeCardDraggable(dragHandle);
	}
}

// Settings card
class SettingsCard extends FloatingCard {
	static currentInstance = null;

	constructor() {
		super();
		this.element.classList.add('settings-panel'); // Add the class for easier querying
		this.element.style.maxWidth = '350px';
	}

	async build() {
		const dragHandle = document.createElement('div');
		dragHandle.className = 'border-b border-border-400 ut-header text-sm';
		dragHandle.textContent = 'Settings';
		this.element.appendChild(dragHandle);

		const label = document.createElement('label');
		label.className = 'ut-label text-sm';
		label.textContent = 'API Key (more accurate):';

		const input = document.createElement('input');
		input.type = 'password';
		input.className = 'bg-bg-000 border border-border-400 text-text-000 ut-input ut-w-full text-sm';
		let apiKey = await sendBackgroundMessage({ type: 'getAPIKey' })
		if (apiKey) input.value = apiKey

		const saveButton = document.createElement('button');
		saveButton.textContent = 'Save';
		saveButton.className = 'ut-button text-sm';
		saveButton.style.background = BLUE_HIGHLIGHT;
		saveButton.style.color = 'white';

		// Modifier section
		const modifierContainer = document.createElement('div');
		modifierContainer.className = 'ut-row ut-mb-3';

		const modifierLabel = document.createElement('label');
		modifierLabel.textContent = 'Cap Modifier:';
		modifierLabel.className = 'text-text-000 text-sm';

		const modifierInput = document.createElement('input');
		modifierInput.type = 'text';
		modifierInput.className = 'bg-bg-000 border border-border-400 text-text-000 ut-input ut-mb-0 text-sm';
		modifierInput.style.width = '60px';

		const result = await sendBackgroundMessage({ type: 'getCapModifier' });
		modifierInput.value = `${((result || 1) * 100)}%`;

		modifierContainer.appendChild(modifierLabel);
		modifierContainer.appendChild(modifierInput);

		// Button container
		const buttonContainer = document.createElement('div');
		buttonContainer.className = 'ut-row';

		const debugButton = document.createElement('button');
		debugButton.textContent = 'Debug Logs';
		debugButton.className = 'bg-bg-300 border border-border-400 text-text-400 ut-button text-sm';

		const resetButton = document.createElement('button');
		resetButton.textContent = 'Reset Quota';
		resetButton.className = 'ut-button text-sm';
		resetButton.style.background = RED_WARNING;
		resetButton.style.color = 'white';

		// Event listeners
		debugButton.addEventListener('click', async () => {
			const result = await sendBackgroundMessage({
				type: 'openDebugPage'
			});

			if (result === 'fallback') {
				window.location.href = browser.runtime.getURL('debug.html');
			} else {
				this.remove();
			}
		});

		resetButton.addEventListener('click', async () => {
			// Show confirmation dialog
			const confirmation = confirm(
				'Are you sure you want to reset usage data for this organization?\n\n' +
				'This will reset ALL models\' usage counters to zero and sync this reset across all your devices. ' +
				'This action cannot be undone.'
			);

			if (confirmation) {
				try {
					// Show loading state
					const originalText = resetButton.textContent;
					resetButton.textContent = 'Resetting...';
					resetButton.disabled = true;

					// Send reset message to background (sendBackgroundMessage already handles orgId)
					const result = await sendBackgroundMessage({
						type: 'resetOrgData'
					});

					if (result) {
						// Show success message
						resetButton.textContent = 'Reset Complete!';
						resetButton.style.background = SUCCESS_GREEN;

						// Reset button after delay
						setTimeout(() => {
							resetButton.textContent = originalText;
							resetButton.style.background = RED_WARNING;
							resetButton.disabled = false;
						}, 2000);
					} else {
						throw new Error('Reset failed');
					}
				} catch (error) {
					// Show error
					resetButton.textContent = 'Reset Failed';
					await Log("error", 'Reset failed:', error);

					// Reset button after delay
					setTimeout(() => {
						resetButton.textContent = originalText;
						resetButton.disabled = false;
					}, 2000);
				}
			}
		});

		saveButton.addEventListener('click', async () => {
			const modifierValue = modifierInput.value.replace('%', '');
			let modifier = 1;
			if (!isNaN(modifierValue)) {
				modifier = parseFloat(modifierValue) / 100;
			}

			await sendBackgroundMessage({ type: 'setCapModifier', modifier });
			let result = await sendBackgroundMessage({ type: 'setAPIKey', newKey: input.value });

			if (!result) {
				const errorMsg = document.createElement('div');
				errorMsg.className = 'text-sm';
				errorMsg.style.color = RED_WARNING;
				errorMsg.textContent = input.value.startsWith('sk-ant')
					? 'Inactive API key. Have you ever loaded credits to the account?'
					: 'Invalid API key. Format looks wrong, it should start with sk-ant.';
				input.after(errorMsg);
				setTimeout(() => errorMsg.remove(), 3000);
				return;
			}
			location.reload();
		});

		// Assemble
		this.element.appendChild(label);
		this.element.appendChild(input);
		this.element.appendChild(modifierContainer);
		buttonContainer.appendChild(saveButton);
		buttonContainer.appendChild(debugButton);
		buttonContainer.appendChild(resetButton);
		this.element.appendChild(buttonContainer);

		this.addCloseButton();
		this.makeCardDraggable(dragHandle);
	}

	show(position) {
		if (SettingsCard.currentInstance) {
			SettingsCard.currentInstance.remove();
		}

		if (position) {
			// Get the card's width - we need to temporarily add it to the DOM to measure
			this.element.style.visibility = 'hidden';
			document.body.appendChild(this.element);
			const cardWidth = this.element.offsetWidth;
			this.element.remove();
			this.element.style.visibility = 'visible';

			// Check if card would overflow the right edge
			if (position.left + cardWidth > window.innerWidth) {
				// Adjust to align with left edge of screen with small margin
				position.left = 8;
			}
		}

		super.show(position);
		SettingsCard.currentInstance = this;
	}

	remove() {
		super.remove();
		if (SettingsCard.currentInstance === this) {
			SettingsCard.currentInstance = null;
		}
	}
}