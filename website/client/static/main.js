/**
 * Page entry point. Starting the session lives here, so importing the app
 * module has no side effects and a test can load it without a live session
 * running behind the assertions.
 */

import { init } from './app.js';

// A module script is deferred, so the document may already be parsed by now.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
