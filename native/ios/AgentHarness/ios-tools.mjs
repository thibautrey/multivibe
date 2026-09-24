// MIT Hermes contracts are generated from the pinned Python sources, not copied
// by hand. Handlers below adapt them to native iOS capabilities. Python server
// handlers are intentionally not executed in JavaScriptCore.
import contracts from './hermes-contracts.json';
import { createEditTool } from '@earendil-works/pi-agent-core';
const clone = value => JSON.parse(JSON.stringify(value));
function contract(name, description, properties, required) {
  const tool = clone(contracts[name]);
  tool.description = description;
  tool.parameters = { type: 'object', properties, required, additionalProperties: false };
  return tool;
}
const questions = clone(contracts.clarify.parameters.properties.questions);
delete questions.description;
questions.items.additionalProperties = false;
questions.items.properties.question = { type: 'string', minLength: 1, maxLength: 500 };
questions.items.properties.choices.items = { type: 'string', minLength: 1, maxLength: 200 };
const clarify = contract('clarify', 'Ask independent questions when essential information is missing. Ends this turn; the user replies in chat. Choices are displayed as text, not buttons. Never invent an answer.', { questions }, ['questions']);
const session = contract('session_search', 'Search this account’s local conversation history by literal text. Past assistant statements are unverified, not current evidence.', {
  query: { ...contracts.session_search.parameters.properties.query, description: 'Literal search text.', minLength: 1, maxLength: 200 }
}, ['query']);
const extract = contract('web_extract', 'Read 1–3 public HTTPS text/HTML/JSON pages, with sources and native Internet permission. No PDF, browser JavaScript or login. For more of a page use fetch_website with offset.', {
  urls: { ...contracts.web_extract.parameters.properties.urls, description: 'Public HTTPS URLs.', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 2048 } }
}, ['urls']);
const edit = createEditTool();
export const iosToolSchemas = [clarify, session, extract, {
  name: 'edit_document', description: 'Edit an imported local document by exact unique text replacements, only when requested. path is the document UUID from list_documents. Ambiguous or overlapping edits fail without changing the document.',
  parameters: { type: 'object', properties: {
    path: { type: 'string', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
    edits: { ...edit.parameters.properties.edits, description: 'Exact replacements against the original document.', minItems: 1, maxItems: 10 }
  }, required: ['path', 'edits'], additionalProperties: false }
}];
const ok = value => ({ ok: true, value });
export async function executeIOSTool(name, args, native, signal) {
  if (name === 'clarify') {
    const content = args.questions.map(q => q.question.trim() + (q.choices?.length ? '\n' + q.choices.map((c, i) => `${i + 1}. ${c}`).join('\n') : '')).join('\n\n');
    return native('clarify', { content });
  }
  if (name === 'session_search') return native('local_workspace', { action: 'search_conversations', query: args.query });
  if (name === 'web_extract') {
    const pages = [];
    let isError = false;
    for (const url of args.urls) {
      const page = await native('fetch_website', { url });
      if (page.terminal) return page;
      pages.push(page.content); isError ||= page.isError === true;
    }
    return { content: pages.join('\n\n'), isError };
  }
  if (name === 'edit_document') {
    // Virtual environment: UUIDs only, no device filesystem, shell or network.
    // Pi performs the actual matching, overlap checks, newline/BOM handling,
    // serialization and diff creation without any changes to its implementation.
    let original;
    const path = value => {
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Use the document UUID from list_documents.');
      return ok(value.toUpperCase());
    };
    const checked = async (operation, input) => {
      if (signal.aborted) throw new Error('Cancelled');
      const result = await native(operation, input);
      if (result.isError) throw new Error(result.content);
      return result.content;
    };
    const env = {
      absolutePath: async value => path(value), canonicalPath: async value => path(value),
      fileInfo: async () => ok({ kind: 'file' }),
      readTextFile: async id => { original = await checked('document_snapshot', { documentID: id }); return ok(original); },
      writeFile: async (id, content) => {
        await checked('document_replace', { documentID: id, content, expected: original }); return ok(undefined);
      }
    };
    const result = await edit.execute('ios-edit', args, undefined, { env }, undefined, { abortSignal: signal });
    return { content: result.content.map(p => p.text ?? '').join('\n'), isError: false };
  }
  throw new Error('Unknown iOS tool');
}
