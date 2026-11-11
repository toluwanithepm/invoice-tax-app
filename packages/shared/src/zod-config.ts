import { z } from 'zod';

/**
 * Plain-language defaults for zod's built-in messages (NFR-15). Schema-specific messages
 * still win; this only replaces zod's technical fallbacks such as
 * "Invalid input: expected string, received undefined".
 */
z.config({
  customError: (issue) => {
    if (issue.code === 'invalid_type') {
      if (issue.input === undefined || issue.input === null) return 'This field is required.';
      if (issue.expected === 'number') return 'Enter a number.';
      return 'This value is not in the right format.';
    }
    if (issue.code === 'invalid_value') return 'Choose one of the listed options.';
    if (issue.code === 'too_big' && issue.origin === 'array') return `Use at most ${String(issue.maximum)} items.`;
    if (issue.code === 'too_big' && issue.origin === 'string') return `Use at most ${String(issue.maximum)} characters.`;
    return undefined; // keep zod's default for anything else
  },
});
