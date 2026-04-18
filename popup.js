document.getElementById('debug').addEventListener('click', () => {
	browser.tabs.create({ url: browser.runtime.getURL('debug.html') });
	window.close();
});

document.getElementById('donate').addEventListener('click', () => {
	browser.tabs.create({ url: 'https://ko-fi.com/lugia19' });
	window.close();
});
