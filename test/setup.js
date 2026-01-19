// Test setup - must run BEFORE any React/testing-library imports
// This file is loaded via --import flag before tests run

import { JSDOM } from "jsdom";

const dom = new JSDOM(
	'<!DOCTYPE html><html><body><div id="root"></div></body></html>',
	{
		url: "http://localhost",
		pretendToBeVisual: true,
	},
);

// Helper to define globals (handles read-only properties)
function defineGlobal(name, value) {
	Object.defineProperty(globalThis, name, {
		value,
		writable: true,
		configurable: true,
	});
}

// Set up all DOM globals before React loads
defineGlobal("window", dom.window);
defineGlobal("document", dom.window.document);
defineGlobal("navigator", dom.window.navigator);
defineGlobal("HTMLElement", dom.window.HTMLElement);
defineGlobal("Element", dom.window.Element);
defineGlobal("DocumentFragment", dom.window.DocumentFragment);
defineGlobal("Node", dom.window.Node);
defineGlobal("Text", dom.window.Text);
defineGlobal("Event", dom.window.Event);
defineGlobal("KeyboardEvent", dom.window.KeyboardEvent);
defineGlobal("MouseEvent", dom.window.MouseEvent);
defineGlobal("InputEvent", dom.window.InputEvent);
defineGlobal("FocusEvent", dom.window.FocusEvent);
defineGlobal("CustomEvent", dom.window.CustomEvent);
defineGlobal("HTMLInputElement", dom.window.HTMLInputElement);
defineGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
defineGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
defineGlobal("HTMLFormElement", dom.window.HTMLFormElement);
defineGlobal("HTMLDivElement", dom.window.HTMLDivElement);
defineGlobal("HTMLSpanElement", dom.window.HTMLSpanElement);
defineGlobal("MutationObserver", dom.window.MutationObserver);
defineGlobal("getComputedStyle", dom.window.getComputedStyle);
defineGlobal("requestAnimationFrame", (cb) => setTimeout(cb, 0));
defineGlobal("cancelAnimationFrame", (id) => clearTimeout(id));

// Mock ResizeObserver
defineGlobal(
	"ResizeObserver",
	class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
);

// Mock IntersectionObserver
defineGlobal(
	"IntersectionObserver",
	class IntersectionObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
);

// Mock matchMedia
defineGlobal("matchMedia", (query) => ({
	matches: false,
	media: query,
	onchange: null,
	addListener: () => {},
	removeListener: () => {},
	addEventListener: () => {},
	removeEventListener: () => {},
	dispatchEvent: () => false,
}));

// Mock scrollTo
defineGlobal("scrollTo", () => {});
dom.window.scrollTo = () => {};

// Mock URL methods if needed
if (!globalThis.URL.createObjectURL) {
	globalThis.URL.createObjectURL = () => "blob:mock";
}
if (!globalThis.URL.revokeObjectURL) {
	globalThis.URL.revokeObjectURL = () => {};
}

// Mock fetch to prevent actual API calls
const originalFetch = globalThis.fetch;
defineGlobal("fetch", async (url, options) => {
	// Return empty successful responses for API calls
	if (typeof url === "string" && url.startsWith("/api")) {
		return new Response(JSON.stringify({}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}
	// Fall back to original fetch for other URLs
	return originalFetch(url, options);
});

console.log("[test/setup.js] DOM globals initialized");
