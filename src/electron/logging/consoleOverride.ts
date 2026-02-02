/**
 * Console Override Script for UI Resources
 *
 * This script is injected into UI Resource HTML to capture console.* calls.
 * Forwards logs to parent window via postMessage using JSON-RPC format.
 *
 * The script:
 * 1. Preserves original console behavior (logs still appear in DevTools)
 * 2. Forwards all console calls to the Host via postMessage
 * 3. Uses the MCP Apps protocol message format for consistency
 */

/**
 * Script to be injected into UI Resource HTML.
 * Captures console.log/warn/error/debug and forwards to parent via postMessage.
 *
 * Message format follows JSON-RPC notification style:
 * {
 *   jsonrpc: "2.0",
 *   method: "ui/log",
 *   params: { level, message, timestamp }
 * }
 */
export const CONSOLE_OVERRIDE_SCRIPT = `
<script data-creature-console-override>
(function() {
  // Debug: Log when script is parsed
  console.log('[ConsoleOverride] Script parsed, readyState:', document.readyState);

  // Wait for DOMContentLoaded to avoid interfering with app initialization.
  // The override is installed after the page's initial scripts have run.
  if (document.readyState === 'loading') {
    console.log('[ConsoleOverride] Waiting for DOMContentLoaded');
    document.addEventListener('DOMContentLoaded', installOverride);
  } else {
    // DOM already loaded, install immediately
    console.log('[ConsoleOverride] DOM already loaded, installing immediately');
    installOverride();
  }

  function installOverride() {
    console.log('[ConsoleOverride] Installing console overrides');
    // Store original console methods
    // Note: console.debug is intentionally NOT overridden - debug logs are for DevTools only
    var original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };

    // Map console methods to log levels
    var levelMap = {
      log: 'info',
      info: 'info',
      warn: 'warning',
      error: 'error'
    };

    /**
     * Serialize a value for logging, handling special cases.
     * Standard JSON.stringify fails for Error and Event objects because
     * their properties are non-enumerable or on the prototype chain.
     */
    function serializeArg(arg) {
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      if (typeof arg !== 'object') return String(arg);

      // Handle Error objects - extract non-enumerable properties
      if (arg instanceof Error) {
        var errorName = arg.name || 'Error';
        var errorMessage = arg.message || '(no message)';
        var stack = arg.stack;
        if (stack) {
          return errorName + ': ' + errorMessage + '\\n' + stack;
        }
        return errorName + ': ' + errorMessage;
      }

      // Handle Event objects - most properties are getters on prototype
      if (typeof Event !== 'undefined' && arg instanceof Event) {
        var eventInfo = '[Event: ' + arg.type + ']';
        if (arg.target) {
          var targetName = arg.target.constructor ? arg.target.constructor.name : 'unknown';
          eventInfo += ' target=' + targetName;
        }
        return eventInfo;
      }

      // Regular objects - try JSON.stringify
      try {
        return JSON.stringify(arg);
      } catch (e) {
        return String(arg);
      }
    }

    /**
     * Forward a log call to the parent window.
     * Preserves original console behavior.
     */
    function forward(method, args) {
      // Call original console method first
      original[method].apply(console, args);

      // Forward to parent via postMessage
      try {
        if (window.parent && window.parent !== window) {
          var message = Array.prototype.map.call(args, serializeArg).join(' ');

          window.parent.postMessage({
            jsonrpc: '2.0',
            method: 'ui/log',
            params: {
              level: levelMap[method],
              message: message,
              timestamp: new Date().toISOString()
            }
          }, '*');
        }
      } catch (e) {
        // Ignore postMessage errors (e.g., cross-origin restrictions)
      }
    }

    // Override console methods (debug is NOT overridden - stays in DevTools only)
    console.log = function() { forward('log', arguments); };
    console.info = function() { forward('info', arguments); };
    console.warn = function() { forward('warn', arguments); };
    console.error = function() { forward('error', arguments); };
    
    // Use original.log since console.log is now overridden
    original.log('[ConsoleOverride] Installation complete');
  }
})();
</script>
`;

