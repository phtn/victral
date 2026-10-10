import * as Schema from 'effect/Schema';
import { textArgument } from './tool-argument-schema.js';

// File contents and replacements remain literal UTF-8 text: do not trim, coerce,
// or reject whitespace/NUL. Only the search text must have at least one character.
export const WriteFileSchema = Schema.Struct({ path: textArgument('path'), content: textArgument('content') });
const OldText = textArgument('old_text').check(Schema.isMinLength(1, { message: 'old_text must not be empty.' }))
  .annotate({ identifier: 'old_text must not be empty.' });
export const EditFileSchema = Schema.Struct({ path: textArgument('path'), old_text: OldText, new_text: textArgument('new_text') });
// Patch grammar/hunks remain in the pure parser. That parser runs before any
// filesystem access; path/content preflight and rollback stay in the patch engine.
export const ApplyPatchSchema = Schema.Struct({ patch: textArgument('patch') });
