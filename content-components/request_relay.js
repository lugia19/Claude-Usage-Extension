'use strict';

// Lets injections/request-hook.js (MAIN world) reach the background through common/ext/bridge.js.
// Loaded at document_start so requests the page makes while it loads aren't lost. Only these two
// message types may be forwarded: page scripts can post bridge messages too.
ClaudeExtBridge.serve('tracker', { background: ['interceptedRequest', 'interceptedResponse'] });
