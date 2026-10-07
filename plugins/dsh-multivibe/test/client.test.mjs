import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client.jsx', import.meta.url), 'utf8')
const status = (extra = {}) => ({ revision: 'r1', connected: false, connection: null, pending: false, providers: [{ settingsNs: 'models-runtime', displayName: 'Models' }], ...extra })
const connected = (extra = {}) => status({ connected: true, connection: { providerId: 'multivibe', baseURL: 'https://gateway.example/v1', protocol: 'openai-responses', modelCount: 1, connectedAt: 1700000000000 }, ...extra })
const response = (data, ok = true) => ({ ok, json: async () => data })
const flush = () => new Promise(resolve => setImmediate(resolve))

// Pure handler/lifecycle tests. This tiny hook harness is NOT a React DOM renderer.
function boot({ hostname = '127.0.0.1', language = 'en', fetch = async () => response(status()), locale = true, timers } = {}) {
  const cells = [], effects = [], cleanups = [], styles = [], locales = [], disposers = []
  let cursor = 0, loaded, registration, Component, tree, panelProps, password = null, passwordRef = null, removed = false
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }),
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }] },
    useRef(initial) { const index = cursor++; if (!(index in cells)) cells[index] = { current: initial }; return cells[index] },
    useCallback(callback) { const index = cursor++; if (!(index in cells)) cells[index] = callback; return cells[index] },
    useEffect(effect) { const index = cursor++; if (!(index in cells)) { cells[index] = true; effects.push(effect) } },
  }
  const context = vm.createContext({
    window: { location: { hostname }, __ModuleLoader__: { load: value => { loaded = value } } },
    document: { documentElement: { lang: language }, createElement: () => ({ dataset: {}, remove() { this.removed = true } }), head: { appendChild: style => styles.push(style) } },
    navigator: { language }, URL, AbortController, fetch,
    setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout,
    console: { log() { throw new Error('Unexpected client logging') }, error() { throw new Error('Unexpected client logging') } },
  })
  vm.runInContext(source, context, { filename: 'client.jsx' })
  const plugin = loaded.factory(name => { assert.equal(name, 'react'); return React })
  plugin.apply({
    effect(factory) { const dispose = factory(); if (dispose) disposers.push(dispose) },
    slots: {
      inject(name, factory) { assert.equal(name, 'settings.plugins.tab'); const dispose = factory(); if (dispose) disposers.push(dispose) },
      register(options, component) { registration = options; Component = component; return () => { removed = true } },
    },
    ...(locale ? { locale: {
      register(namespace, dictionaries) { locales.push({ namespace, dictionaries }); return () => { locales[0].removed = true } },
      bind: () => key => locales[0]?.dictionaries[language]?.[key] || key,
    } } : {}),
  })
  const injected = registration.inject()
  const visit = (node, predicate, output = []) => {
    if (!node || typeof node !== 'object') return output
    if (predicate(node)) output.push(node)
    for (const child of node.children || []) visit(child, predicate, output)
    return output
  }
  const nodes = predicate => visit(tree, predicate)
  const render = () => {
    cursor = 0; tree = Component(panelProps)
    const field = nodes(node => node.type === 'input' && node.props.name === 'apiKey')[0]
    if (field) {
      if (!password) password = { value: '' }
      if (passwordRef !== field.props.ref) { passwordRef?.(null); passwordRef = field.props.ref; passwordRef(password) }
    } else { passwordRef?.(null); passwordRef = null }
    return tree
  }
  const mount = async (request = injected.callApi) => {
    panelProps = { t: key => key, callApi: request }; render()
    for (const effect of effects.splice(0)) cleanups.push(effect())
    await flush(); render()
  }
  const input = name => nodes(node => ['input', 'select'].includes(node.type) && node.props.name === name)[0]
  const button = label => nodes(node => node.type === 'button' && node.children.includes(label))[0]
  const change = (name, value) => {
    const field = input(name); assert.ok(field, `Missing field: ${name}`)
    if (name === 'apiKey') password.value = value
    field.props.onChange({ target: { value } }); render()
  }
  const submit = () => nodes(node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  const text = () => {
    const values = []
    const collect = node => { if (typeof node === 'string' || typeof node === 'number') values.push(String(node)); else if (node && typeof node === 'object') for (const child of node.children || []) collect(child) }
    collect(tree); return values.join(' ')
  }
  const unmount = () => { for (const cleanup of cleanups.splice(0)) cleanup?.(); passwordRef?.(null); passwordRef = null }
  return { loaded, plugin, registration, injected, styles, locales, mount, render, nodes, input, button, change, submit, text, unmount,
    get password() { return password }, get removed() { return removed }, dispose() { unmount(); for (const dispose of disposers.reverse()) dispose() } }
}
const checkboxes = harness => harness.nodes(node => node.type === 'input' && node.props.type === 'checkbox')
async function discover(harness, key = 'mv_test_private') { harness.change('apiKey', key); harness.button('discover').props.onClick(); await flush(); harness.render() }
function select(harness, index = 0) { checkboxes(harness)[index].props.onChange({ target: { checked: true } }); harness.render() }
const plain = value => JSON.parse(JSON.stringify(value))

test('SDK loader, slot, FR/EN dictionaries, optional locale and scoped cleanup', () => {
  const harness = boot({ language: 'fr' })
  assert.equal(harness.loaded.id, 'dsh-multivibe')
  assert.deepEqual(Array.from(harness.plugin.inject), ['slots', 'locale'])
  assert.equal(harness.registration.id, 'multivibe'); assert.equal(harness.registration.name, 'settings.plugins.tab')
  assert.equal(harness.registration.label(), 'MultiVibe')
  assert.ok(harness.locales[0].dictionaries.fr.connect); assert.ok(harness.locales[0].dictionaries.en.connect)
  harness.dispose()
  assert.equal(harness.styles[0].removed, true); assert.equal(harness.locales[0].removed, true); assert.equal(harness.removed, true)
  const optional = boot({ locale: false, language: 'fr' })
  assert.equal(optional.injected.t('discover'), 'Découvrir les modèles'); optional.dispose()
})

test('authenticated same-origin no-store API rejects redirects and puts keys only in POST bodies', async () => {
  const calls = [], harness = boot({ fetch: async (url, options) => { calls.push({ url, options }); return response({ models: [] }) } })
  await harness.injected.callApi('catalog'); await harness.injected.callApi('discover', { apiKey: 'private-key' })
  assert.equal(calls[0].url, '/api/multivibe/catalog'); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.body, undefined)
  const { url, options } = calls[1]
  assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error')
  assert.ok(options.signal instanceof AbortSignal); assert.equal(JSON.parse(options.body).apiKey, 'private-key'); assert.ok(!url.includes('private-key'))
  harness.dispose()
})

test('errors never expose server messages, internal exceptions or arbitrary API paths', async () => {
  const harness = boot({ fetch: async () => response({ error: { code: 'INTERNAL', message: 'secret=mv_private_stack' } }, false) })
  await assert.rejects(harness.injected.callApi('status'), error => error.code === 'UNAVAILABLE' && !error.message.includes('mv_private'))
  await assert.rejects(harness.injected.callApi('../admin'), error => error.code === 'UNAVAILABLE'); harness.dispose()
})

test('non-loopback pages and lookalike hosts cannot POST, genuine loopback can', async () => {
  for (const hostname of ['gateway.example', 'localhost.evil', '127.0.0.1.evil', '', '127.999.0.1']) {
    let count = 0
    const harness = boot({ hostname, fetch: async () => { count++; return response(status()) } })
    await harness.injected.callApi('status')
    for (const endpoint of ['discover', 'connect', 'disconnect', 'recover']) await assert.rejects(harness.injected.callApi(endpoint, {}), error => error.code === 'READ_ONLY')
    assert.equal(count, 1); harness.dispose()
  }
  for (const hostname of ['localhost', '127.0.0.1', '127.2.3.4', '[::1]']) { const harness = boot({ hostname }); await harness.injected.callApi('recover', { revision: 'r1' }); harness.dispose() }
})

test('AbortSignal and timeout abort fetch and dispose timers', async () => {
  let trigger, cleared = 0, requestSignal
  const harness = boot({ timers: { setTimeout: callback => { trigger = callback; return 1 }, clearTimeout: () => { cleared++ } },
    fetch: async (_url, options) => new Promise((_resolve, reject) => { requestSignal = options.signal; options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) }) })
  const timed = harness.injected.callApi('status'); trigger()
  await assert.rejects(timed, error => error.code === 'TIMEOUT'); assert.equal(requestSignal.aborted, true)
  const controller = new AbortController(), cancelled = harness.injected.callApi('status', undefined, controller.signal)
  controller.abort(); await assert.rejects(cancelled, error => error.code === 'CANCELLED'); assert.equal(cleared, 2); harness.dispose()
})

test('discover retains key, missing capacities stay blank, validation and immediate double-submit guard work', async () => {
  const calls = []; let finish
  const harness = boot()
  await harness.mount(async (endpoint, body, signal) => {
    calls.push({ endpoint, body, signal })
    if (endpoint === 'status') return status()
    if (endpoint === 'discover') return { baseURL: 'http://127.0.0.1:1455/v1', models: [{ id: 'model-1', name: 'Model 1' }] }
    if (endpoint === 'connect') return new Promise(resolve => { finish = resolve })
    throw new Error('Unexpected endpoint')
  })
  await discover(harness); assert.equal(harness.password.value, 'mv_test_private'); select(harness)
  assert.equal(harness.input('contextWindow:model-1').props.value, ''); assert.equal(harness.input('maxTokens:model-1').props.value, '')
  harness.submit(); harness.render(); assert.ok(harness.text().includes('CAPACITY')); assert.equal(calls.filter(call => call.endpoint === 'connect').length, 0)
  harness.change('contextWindow:model-1', '8192'); harness.change('maxTokens:model-1', '9000'); harness.submit(); harness.render(); assert.ok(harness.text().includes('CAPACITY'))
  harness.change('maxTokens:model-1', '2048')
  const submit = harness.nodes(node => node.type === 'form')[0].props.onSubmit
  submit({ preventDefault() {} }); submit({ preventDefault() {} }); assert.equal(calls.filter(call => call.endpoint === 'connect').length, 1)
  const payload = calls.at(-1).body
  assert.equal(payload.revision, 'r1'); assert.equal(payload.settingsNs, 'models-runtime'); assert.equal(payload.providerId, 'multivibe'); assert.equal(payload.protocol, 'openai-completions')
  assert.deepEqual(plain(payload.capacities), { 'model-1': { contextWindow: 8192, maxTokens: 2048 } })
  finish(connected({ revision: 'r2' })); await flush(); harness.render()
  assert.equal(harness.password.value, ''); assert.equal(harness.nodes(node => node.type === 'form').length, 0); assert.ok(harness.text().includes('saved')); harness.dispose()
})

test('conflicts refresh revision without discarding key, provider, selection or capacities', async () => {
  let reads = 0; const attempts = [], harness = boot()
  await harness.mount(async (endpoint, body) => {
    if (endpoint === 'status') return status({ revision: ++reads === 1 ? 'r1' : 'r2' })
    if (endpoint === 'discover') return { models: [{ id: 'm', contextWindow: 100, maxTokens: 20 }] }
    if (endpoint === 'connect') { attempts.push(body); throw { code: 'CONFLICT', message: 'secret' } }
  })
  await discover(harness); select(harness); harness.change('providerId', 'my-multivibe'); harness.submit(); await flush(); harness.render()
  assert.ok(harness.text().includes('CONFLICT')); assert.equal(harness.password.value, 'mv_test_private'); assert.equal(harness.input('providerId').props.value, 'my-multivibe')
  assert.equal(harness.input('contextWindow:m').props.value, 100); assert.equal(checkboxes(harness)[0].props.checked, true)
  harness.submit(); await flush(); harness.render(); assert.equal(attempts[1].revision, 'r2'); harness.dispose()
})

test('pending recovery and disconnection are explicit and carry only the current revision', async () => {
  const calls = [], harness = boot()
  await harness.mount(async (endpoint, body) => {
    calls.push({ endpoint, body })
    if (endpoint === 'status') return status({ pending: true })
    if (endpoint === 'recover') return connected({ revision: 'r2' })
    if (endpoint === 'disconnect') return status({ revision: 'r3' })
  })
  assert.ok(harness.text().includes('pending')); assert.equal(harness.nodes(node => node.type === 'fieldset')[0].props.disabled, true)
  harness.button('recover').props.onClick(); await flush(); harness.render(); assert.deepEqual(plain(calls.at(-1).body), { revision: 'r1' })
  assert.equal(harness.nodes(node => node.type === 'form').length, 0)
  const dashboard = harness.nodes(node => node.type === 'a')[0]
  assert.equal(dashboard.props.href, 'https://gateway.example/'); assert.equal(dashboard.props.target, '_blank'); assert.equal(dashboard.props.rel, 'noopener noreferrer')
  harness.button('disconnect').props.onClick(); harness.render(); assert.equal(calls.filter(call => call.endpoint === 'disconnect').length, 0)
  harness.button('confirmDisconnect').props.onClick(); await flush(); harness.render(); assert.deepEqual(plain(calls.at(-1).body), { revision: 'r2', removeCredential: false }); assert.ok(harness.text().includes('removed')); harness.dispose()
})

test('unmount aborts tracked work, erases the DOM key and ignores late completion', async () => {
  let finish, signal; const harness = boot()
  await harness.mount(async (endpoint, _body, requestSignal) => {
    if (endpoint === 'status') return status()
    if (endpoint === 'discover') { signal = requestSignal; return new Promise(resolve => { finish = resolve }) }
  })
  harness.change('apiKey', 'private-unmount-key'); harness.button('discover').props.onClick(); harness.unmount()
  assert.equal(signal.aborted, true); assert.equal(harness.password.value, '')
  finish({ models: [{ id: 'late-model' }] }); await flush(); harness.render(); assert.ok(!harness.text().includes('late-model')); harness.dispose()
})

test('failed conflict status refresh does not crash or permit stale mutations', async () => {
  let reads = 0; const harness = boot()
  await harness.mount(async endpoint => {
    if (endpoint === 'status') { if (++reads > 1) throw { code: 'UNAVAILABLE' }; return status() }
    if (endpoint === 'discover') return { models: [{ id: 'm', contextWindow: 10, maxTokens: 2 }] }
    if (endpoint === 'connect') throw { code: 'CONFLICT' }
  })
  await discover(harness); select(harness); harness.submit(); await flush()
  assert.doesNotThrow(() => harness.render()); assert.ok(harness.text().includes('stale')); assert.equal(harness.nodes(node => node.type === 'form').length, 0); harness.dispose()
})

test('unsafe dashboard links and credential-bearing discovery URLs are rejected', async () => {
  const existing = boot()
  await existing.mount(async () => connected({ connection: { providerId: 'multivibe', baseURL: 'javascript:alert(1)' } }))
  assert.equal(existing.nodes(node => node.type === 'a').length, 0); existing.dispose()
  let discoveries = 0; const draft = boot()
  await draft.mount(async endpoint => { if (endpoint === 'status') return status(); discoveries++; return { models: [] } })
  draft.change('baseURL', 'https://user:secret@gateway.example/v1'); await discover(draft)
  assert.equal(discoveries, 0); assert.ok(draft.text().includes('ENDPOINT')); draft.dispose()
})

test('pagination renders 50 models per page, preserves selection and caps it at 256', async () => {
  const harness = boot()
  await harness.mount(async endpoint => endpoint === 'status' ? status() : { models: Array.from({ length: 257 }, (_, index) => ({ id: `m${index}`, contextWindow: 100, maxTokens: 20 })) })
  await discover(harness); assert.equal(checkboxes(harness).length, 50)
  for (let page = 0; page < 6; page++) {
    const length = checkboxes(harness).length
    for (let index = 0; index < length; index++) if (!checkboxes(harness)[index].props.disabled) select(harness, index)
    if (page < 5) { harness.button('next').props.onClick(); harness.render() }
  }
  assert.ok(harness.text().includes('256/256')); assert.ok(harness.text().includes('selectionLimit')); assert.equal(checkboxes(harness).at(-1).props.checked, false); assert.equal(checkboxes(harness).at(-1).props.disabled, true)
  harness.button('previous').props.onClick(); harness.render(); assert.equal(checkboxes(harness)[0].props.checked, true); harness.dispose()
})

test('credential deletion must be explicitly selected in the disconnect confirmation', async () => {
  const harness = boot(); let submitted;
  await harness.mount(async (endpoint, body) => { if (endpoint === 'status') return connected(); submitted = body; return status(); });
  harness.button('disconnect').props.onClick(); harness.render();
  assert.equal(harness.input('removeCredential').props.checked, false);
  harness.input('removeCredential').props.onChange({ target: { checked: true } }); harness.render();
  harness.button('confirmDisconnect').props.onClick(); await flush();
  assert.equal(submitted.removeCredential, true);
  harness.dispose();
});

test('saved but inactive connections remain detachable and never show a reconnect form', async () => {
  const harness = boot();
  await harness.mount(async () => connected({ connected: false, connection: { providerId: 'multivibe', baseURL: 'https://gateway.example/v1', protocol: 'openai-completions', modelCount: 1, modified: true } }));
  assert.equal(harness.nodes(node => node.type === 'form').length, 0);
  assert.ok(harness.text().includes('retained'));
  assert.ok(harness.button('disconnect'));
  harness.dispose();
});

test('multiple provider namespaces require an explicit choice', async () => {
  const harness = boot(); let connects = 0
  await harness.mount(async endpoint => {
    if (endpoint === 'status') return status({ providers: [{ settingsNs: 'a' }, { settingsNs: 'b' }] })
    if (endpoint === 'discover') return { models: [{ id: 'm', contextWindow: 100, maxTokens: 20 }] }
    if (endpoint === 'connect') { connects++; return connected() }
  })
  assert.equal(harness.input('settingsNs').props.value, '')
  await discover(harness); select(harness); harness.submit(); harness.render()
  assert.equal(connects, 0); assert.ok(harness.text().includes('NAMESPACE'))
  harness.change('settingsNs', 'b'); harness.submit(); await flush(); harness.render(); assert.equal(connects, 1); harness.dispose()
})
