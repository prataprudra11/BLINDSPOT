// element-mapper.js - Local Anonymous ID Mapping Layer (Manifest V3)
// Maintains an in-memory mapping from anonymous IDs (el_001, el_002, ...) to actual DOM node references.
// CRITICAL PRIVACY INVARIANT: This map stays strictly local to the content script's isolated memory
// and must NEVER be serialized or transmitted across the network.

(function (global) {
  let elementMap = new Map();
  let selectorMap = new Map();
  let counter = 0;

  /**
   * Resets the element map, selector cache, and counter.
   * MUST be invoked at the start of every perception cycle (new DOM scan)
   * to eliminate stale DOM references when pages change dynamically.
   */
  function resetMap() {
    elementMap.clear();
    selectorMap.clear();
    counter = 0;
  }

  /**
   * Registers a scanned DOM node and assigns the next sequential anonymous ID.
   * @param {Element} node - Actual DOM node reference
   * @param {string} [selector] - Stable CSS selector (retained locally only)
   * @returns {string} - Anonymous ID (e.g., 'el_001', 'el_002')
   */
  function registerElement(node, selector) {
    counter++;
    const id = `el_${String(counter).padStart(3, "0")}`;
    elementMap.set(id, node);
    if (selector) {
      selectorMap.set(id, selector);
    }
    return id;
  }

  /**
   * Resolves an anonymous ID back to its live DOM node reference.
   * Required for the action-execution loop to dispatch clicks, input, etc.
   * @param {string} id - Anonymous ID (e.g., 'el_001')
   * @returns {Element|null} - The DOM element or null if not found
   */
  function getElement(id) {
    if (typeof id !== "string") return null;
    return elementMap.get(id) || null;
  }

  /**
   * Resolves an anonymous ID to its local CSS selector (strictly for local debugging/fallback).
   * @param {string} id - Anonymous ID (e.g., 'el_001')
   * @returns {string|null}
   */
  function getLocalSelector(id) {
    if (typeof id !== "string") return null;
    return selectorMap.get(id) || null;
  }

  /**
   * Returns the total count of currently mapped elements in the active perception cycle.
   * @returns {number}
   */
  function getMapSize() {
    return elementMap.size;
  }

  const ElementMapper = {
    resetMap,
    registerElement,
    getElement,
    getLocalSelector,
    getMapSize
  };

  // Support CommonJS (Node tests), Browser window, and global contexts
  if (typeof module !== "undefined" && module.exports) {
    module.exports = ElementMapper;
  }
  if (typeof window !== "undefined") {
    window.ElementMapper = ElementMapper;
  }
  if (typeof global !== "undefined") {
    global.ElementMapper = ElementMapper;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
