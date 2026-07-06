import type { Node } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import { extractIncludeImports } from './cpp.js';

/** C: the cpp query minus C++-only node types (which would fail to compile). */
const C_QUERY = `
  (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
  (function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def.function
  (declaration declarator: (function_declarator declarator: (identifier) @name)) @def.function
  (declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def.function
  (struct_specifier name: (type_identifier) @name body: (_)) @def.struct
  (union_specifier name: (type_identifier) @name body: (_)) @def.struct
  (enum_specifier name: (type_identifier) @name body: (_)) @def.enum
  (enumerator name: (identifier) @name) @def.enum_member
  (field_declaration declarator: (field_identifier) @name) @def.field
  (field_declaration declarator: (pointer_declarator declarator: (field_identifier) @name)) @def.field
  (type_definition declarator: (type_identifier) @name) @def.type_alias
  (preproc_def name: (identifier) @name) @def.macro
  (preproc_function_def name: (identifier) @name) @def.macro
  (translation_unit (declaration declarator: (init_declarator declarator: (identifier) @name)) @def.variable)
`;

const C_OCCURRENCES = `
  (call_expression function: (identifier) @call)
  (call_expression function: (field_expression field: (field_identifier) @call))
  (assignment_expression left: (identifier) @write)
  (assignment_expression left: (field_expression field: (field_identifier) @write))
  (identifier) @ref
  (field_identifier) @ref
  (type_identifier) @ref
`;

/** `static` file-scope definitions are private to the translation unit. */
function isExported(defNode: Node): boolean {
  return !defNode.namedChildren.some(
    (c) => c?.type === 'storage_class_specifier' && c.text === 'static',
  );
}

export const cExtractor: LanguageExtractor = {
  id: 'c',
  symbolQuery: C_QUERY,
  occurrenceQuery: C_OCCURRENCES,
  extractImports: extractIncludeImports,
  isExported,
};
