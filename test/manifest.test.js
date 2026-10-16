// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The store indexer validates the manifest, but nothing there knows which
// handlers the code registers — these tests keep both in sync, and catch the
// store rules that are easiest to miss.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  DIRECTIONS,
  HUB_STATUSES,
  MOVE_ALL_ORDERS,
  SCENE_ACTION_HANDLERS,
  SCENE_ACTIONS,
  SCENE_TRIGGERS,
} from '../src/capabilities/scenes.js';
import { CONNECTOR_WIDGET } from '../src/capabilities/widget.js';
import { UDP_PORT } from '../src/connector/protocol.js';
import { LANGUAGES } from '../src/i18n.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('../gladys-assistant-integration.json'));
const pkg = JSON.parse(await read('../package.json'));
const appSource = await read('../src/app.js');

const keysOf = (list) => (list ?? []).map((entry) => entry.key).sort();
const optionsOf = (field) => field.options.map((option) => option.value).sort();

test('the version is the same everywhere, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/prohand/gladys-dooyaconnector:${pkg.version}`);
});

test('every manifest action is registered', () => {
  for (const action of manifest.actions) {
    assert.match(appSource, new RegExp(`onAction\\('${action.key}'`), `action "${action.key}"`);
  }
});

test('the scene actions of the manifest are the ones the code handles', () => {
  assert.deepEqual(keysOf(manifest.scene_actions), Object.values(SCENE_ACTIONS).sort());
  assert.deepEqual(Object.keys(SCENE_ACTION_HANDLERS).sort(), Object.values(SCENE_ACTIONS).sort());
  assert.match(appSource, /onSceneAction\(key/);
});

test('the scene triggers the code fires are the ones the manifest declares', () => {
  assert.deepEqual(keysOf(manifest.scene_triggers), Object.values(SCENE_TRIGGERS).sort());
  const trigger = (key) => manifest.scene_triggers.find((entry) => entry.key === key);
  const field = (key, name) => trigger(key).fields.find((entry) => entry.key === name);
  assert.deepEqual(
    optionsOf(field(SCENE_TRIGGERS.MOVED_OUTSIDE_GLADYS, 'direction')),
    Object.values(DIRECTIONS).sort(),
  );
  assert.deepEqual(
    optionsOf(field(SCENE_TRIGGERS.HUB_CONNECTION_CHANGED, 'status')),
    Object.values(HUB_STATUSES).sort(),
  );
  const order = manifest.scene_actions
    .find((entry) => entry.key === SCENE_ACTIONS.MOVE_ALL)
    .fields.find((entry) => entry.key === 'order');
  assert.deepEqual(optionsOf(order), Object.keys(MOVE_ALL_ORDERS).sort());
});

test('the widget is declared and handled', () => {
  assert.deepEqual(keysOf(manifest.widgets), [CONNECTOR_WIDGET]);
  assert.match(appSource, /onWidgetGet\(CONNECTOR_WIDGET/);
  assert.match(appSource, /onWidgetAction\(CONNECTOR_WIDGET/);
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      assert.ok(!(field.key in DEFAULT_CONFIG), `section "${field.key}" stores no value`);
      continue;
    }
    assert.ok(field.key in DEFAULT_CONFIG, `config key "${field.key}" unknown to the code`);
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, `default of "${field.key}"`);
    }
  }
});

test('the key is a secret field', () => {
  const key = manifest.config_schema.find((field) => field.key === 'key');
  assert.equal(key.type, 'secret');
});

// The field types the store schema accepts.
const FIELD_TYPES = ['string', 'number', 'boolean', 'select', 'multi_select', 'secret', 'section'];

test('every field uses a type the store accepts', () => {
  const fields = [
    ...manifest.config_schema,
    ...manifest.actions.flatMap((action) => action.fields ?? []),
    ...manifest.scene_triggers.flatMap((trigger) => trigger.fields ?? []),
    ...manifest.scene_actions.flatMap((action) => action.fields ?? []),
    ...manifest.widgets.flatMap((widget) => widget.settings ?? []),
  ];
  for (const field of fields) {
    assert.ok(FIELD_TYPES.includes(field.type), `field "${field.key}": type "${field.type}"`);
    assert.match(field.key, /^[a-z0-9_]+$/, `field key "${field.key}" must be snake_case`);
    if (field.placeholder !== undefined) {
      assert.equal(typeof field.placeholder, 'object', `"${field.key}": placeholder object`);
      assert.ok(['string', 'number', 'secret'].includes(field.type));
    }
    if (field.min !== undefined || field.max !== undefined) {
      assert.equal(field.type, 'number', `field "${field.key}": min/max are number-only`);
    }
    if (field.source !== undefined) {
      assert.equal(field.source, 'devices');
      assert.equal(field.options, undefined, `"${field.key}": source and options together`);
    }
  }
});

const CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
];

test('the categories stay inside the vocabulary the store indexes', () => {
  const { categories } = manifest;
  assert.ok(categories.length >= 1 && categories.length <= 3);
  for (const category of categories) {
    assert.ok(CATEGORIES.includes(category), `unknown category "${category}"`);
  }
});

test('the Gladys floor covers the widgets and scene declarations (5.1)', () => {
  const [major, minor] = manifest.gladys_version.replace(/^>=/, '').split('.').map(Number);
  assert.ok(major > 5 || (major === 5 && minor >= 1), `got ${manifest.gladys_version}`);
});

test('local only, and the discovery broadcast goes to the hub port', () => {
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.network_discovery, [
    { type: 'udp-active-broadcast', ports: [UDP_PORT] },
  ]);
});

/** Every multi-language object of the manifest, with where it sits. */
function multiLanguageTexts(node, path = 'manifest') {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => multiLanguageTexts(child, `${path}[${index}]`));
  }
  if (node === null || typeof node !== 'object') {
    return [];
  }
  const keys = Object.keys(node);
  if (keys.includes('en') && keys.every((key) => /^[a-z]{2}$/.test(key))) {
    return [{ path, text: node }];
  }
  return keys.flatMap((key) => multiLanguageTexts(node[key], `${path}.${key}`));
}

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = multiLanguageTexts(manifest);
  assert.ok(texts.length > 50, `only ${texts.length} texts found`);
  for (const { path, text } of texts) {
    assert.deepEqual(Object.keys(text).sort(), [...LANGUAGES].sort(), `${path}: languages`);
    for (const language of LANGUAGES) {
      assert.ok(text[language].trim().length > 0, `${path}.${language} is empty`);
    }
  }
});

test('the per-language length limits of the store hold', () => {
  const within = (text, min, max, where) => {
    for (const language of LANGUAGES) {
      const { length } = text[language];
      assert.ok(length >= min && length <= max, `${where}.${language}: ${length} characters`);
    }
  };
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  within(manifest.description, 10, 100, 'description');
  for (const widget of manifest.widgets) {
    within(widget.label, 3, 30, `widget ${widget.key} label`);
    within(widget.description, 1, 100, `widget ${widget.key} description`);
  }
  for (const section of manifest.config_schema.filter((field) => field.type === 'section')) {
    within(section.description, 1, 1000, `section ${section.key}`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('the user documentation exists in every language', async () => {
  for (const language of LANGUAGES) {
    const text = await read(`../docs/${language}.md`);
    assert.ok(text.length > 1000, `docs/${language}.md is too short`);
    for (const key of [...Object.values(SCENE_TRIGGERS), ...Object.values(SCENE_ACTIONS)]) {
      assert.ok(text.includes(key), `docs/${language}.md does not name ${key}`);
    }
  }
});
