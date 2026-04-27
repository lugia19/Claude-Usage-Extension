document.getElementById('debug').addEventListener('click', () => {
	browser.tabs.create({ url: browser.runtime.getURL('debug.html') });
	window.close();
});
