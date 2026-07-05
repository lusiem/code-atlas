import * as ts from 'web-tree-sitter';

console.log('exports:', Object.keys(ts).join(', '));
const { Parser, Language, Query } = ts;
await Parser.init();
const lang = await Language.load('grammars/tree-sitter-typescript.wasm');
console.log('language loaded, abi:', lang.abiVersion ?? lang.version);
const parser = new Parser();
parser.setLanguage(lang);
const tree = parser.parse('export function greet(name: string): string { return `hi ${name}`; }');
console.log('root:', tree.rootNode.type, 'children:', tree.rootNode.namedChildCount);
const q = new Query(lang, '(function_declaration name: (identifier) @fn)');
const captures = q.captures(tree.rootNode);
console.log(
  'captures:',
  captures.map((c) => `${c.name}=${c.node.text}`),
);
