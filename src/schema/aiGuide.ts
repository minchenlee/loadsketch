// The format guide for AI models (roadmap-next M5, Q13, Q14; M12 skill; M15 split), in English and
// made from the component catalog, so it cannot fall behind it. `npm run ai-guide` (scripts/ai-guide.ts)
// writes: the full guide (aiGuide(), public/llms-full.txt; the "copy a prompt for an AI" button puts
// the same text in the prompt), its short index (llmsIndex(), public/llms.txt), and the Agent Skill
// (skillMd() and referenceMd(), in skills/loadsketch/, public/skills/loadsketch/ and its zip).
// tests/ai-guide.test.ts fails when a file and the catalog differ.
import { EN } from '../i18n/en.ts';
import { REPO } from '../repo.ts';
import { DESIGN_SCHEMA, DesignSchema, formatJson, type Design } from './design.ts';
import { CATEGORY_LABEL, CLIENT_EDGE_LATENCY_MS, EDGE_PARAMS, INTER_REGION_MS, KINDS, type KindSpec, type ParamSpec } from './kinds.ts';

/** English for a Chinese message id (the guide is English only, whatever the page language). */
const en = (msg: string): string => EN[msg] || msg;

/** What the edges out of a component do, by how it routes. */
const ROUTING: Record<KindSpec['routing'], string> = {
  one: 'Forwards each request to one of its outgoing edges (by weight; a load balancer picks an instance behind them).',
  plan: 'Calls its downstreams itself, in order: on a read, a cache and a store together mean cache-aside (cache first, the store only on a miss); on a write, the store first, then the cache is invalidated; other downstreams are called after.',
  leaf: 'Ends the request: no outgoing edges.',
  queue: 'Answers at once and keeps the message; every worker connected after it shares the messages.',
};

/** A cache plans its calls too, but only to stores: read-through / write-through. */
const CACHE_ROUTING = 'Only to stores (database, sharded_db, object_storage), as read-through / write-through: on a miss it reads the store itself and fills the cache; on a write it writes the store first. Without such an edge, a cache calls nothing: a caller that also has a store handles the misses (cache-aside).';

function range(p: ParamSpec): string {
  switch (p.type) {
    case 'int':
      return `integer ${p.min}–${p.max}${p.unit ? ` ${p.unit}` : ''}, default ${p.default}`;
    case 'number':
      return `number ${p.min}–${p.max}${p.unit ? ` ${p.unit}` : ''}, default ${p.default}`;
    case 'ratio':
      return `ratio 0–1, default ${p.default}`;
    case 'dist':
      return `ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to ${p.max}, default {"mean": ${p.default.mean}, "cv": ${p.default.cv}}`;
    case 'enum':
      return `one of ${p.options.map((o) => `"${o.value}" (${en(o.label)})`).join(', ')}; default "${p.default}"`;
  }
}

function params(list: Record<string, ParamSpec>): string[] {
  return Object.entries(list).map(([name, p]) => {
    const when = p.when ? ` Only with ${p.when.param} = ${[p.when.value].flat().map((v) => `"${v}"`).join(' or ')}.` : '';
    return `- \`${name}\` — ${en(p.label)}: ${range(p)}. ${en(p.help)}${when}`;
  });
}

/** A short design the guide shows in full; tests/ai-guide.test.ts checks that it is valid. */
export const GUIDE_EXAMPLE: Design = {
  schema: DESIGN_SCHEMA,
  name: 'Web app with a cache',
  description: 'Users call a load balancer; three API servers read through a cache (cache-aside) and write to the database.',
  nodes: [
    { id: 'users', kind: 'client', pos: [0, 200] },
    { id: 'lb', kind: 'load_balancer', label: 'Load balancer', pos: [300, 200], params: { policy: 'least_conn' } },
    { id: 'api', kind: 'service', label: 'API', pos: [600, 200], params: { instances: 3, concurrency: 8, serviceMs: { mean: 6, cv: 1 } } },
    { id: 'cache', kind: 'cache', label: 'Redis', pos: [900, 80], params: { hitRatio: 0.85 } },
    { id: 'db', kind: 'database', label: 'Postgres', pos: [900, 320], params: { connections: 50 } },
  ],
  edges: [
    { from: 'users', to: 'lb' },
    { from: 'lb', to: 'api' },
    { from: 'api', to: 'cache', timeoutMs: 50 },
    { from: 'api', to: 'db', timeoutMs: 500, retries: 1 },
  ],
} as Design;

/** Written by `loadsketch import`; the app keeps it, and a model must not drop it. */
const SOURCE = 'written by the Terraform import (`loadsketch import`): where the component or edge and its values came from. Keep it exactly as it is on everything you keep, also when you change a value (the app marks changed values itself); do not write one on a new component or edge.';

const shape = DesignSchema.shape as Record<string, { description?: string }>;

/** The site; the guide, the skill and the reference are served from it. */
export const SITE = 'https://loadsketch.mclee.dev';
/** Where the skill's files are on the site (public/skills/loadsketch/). */
export const SKILL_PATH = '/skills/loadsketch';
/** The repository: the example designs and the README (src/repo.ts). */
export { REPO };

/** How to answer, the design, a node, an edge and how requests flow: the rules both the guide and the skill hold. */
function rules(): string[] {
  const kinds = Object.values(KINDS);
  return [
    '## How to answer',
    '',
    '- Give back the whole design as one JSON object, in one ```json code block. No comments, no trailing commas.',
    '- Change only what you were asked to change. Keep the ids of the components you keep: the app compares the two designs by id and shows the user every change before it replaces the canvas.',
    '- New ids: letters, digits, `_` and `-`, starting with a letter or digit, at most 48 characters, no spaces.',
    '- Give each new component a position `pos` [x, y] in pixels. Traffic goes left to right: put a component about 300 px right of its caller, and spread components that share a caller about 120–240 px apart vertically.',
    '- A design made by the Terraform import has `source` fields on its components and edges. Copy each `source` unchanged onto every component and edge you keep, also when you change one of its values: the app marks the changed values itself. Leave it out on a new one.',
    '- Leave out a parameter to use its default. Times are in milliseconds unless the unit says otherwise.',
    '- The traffic (requests per second, read share, faults) is the scenario, not the design: set it in the app.',
    '- The user pastes the answer with File → "Paste design JSON". If something is wrong, the app says what and where.',
    '',
    '## The design',
    '',
    `- \`schema\` (required) — always "${DESIGN_SCHEMA}".`,
    '- `name` (required) — 1–120 characters.',
    '- `description` — what the design is, up to 8000 characters.',
    `- \`nodes\` (required) — the components, up to 300.`,
    '- `edges` (required) — the calls, up to 2000.',
    `- \`apis\` — ${shape.apis?.description ?? ''} Each API: \`name\` (an id), \`op\` ("read" or "write"), \`share\` (a weight, default 1), \`label\`.`,
    `- \`interRegionMs\` — ${shape.interRegionMs?.description ?? ''}`,
    '- `notes` — sticky notes on the canvas. Each note: `id`, `text`, `pos` ([x, y]), `width` (pixels, optional).',
    '',
    'No other fields are allowed, at any level.',
    '',
    '## A node (component)',
    '',
    '- `id` (required) — unique among the nodes.',
    `- \`kind\` (required) — one of ${kinds.map((k) => `"${k.kind}"`).join(', ')}.`,
    '- `pos` (required) — [x, y] on the canvas, in pixels.',
    '- `label` — the name shown on the canvas, up to 60 characters.',
    '- `region` — the region (data center) it runs in, an id like "us-east". A call between two regions adds `interRegionMs`.',
    '- `replicaRegion` — database and sharded_db only: the region of the read replicas when it differs.',
    '- `params` — the settings of its kind (below). Parameters go inside `params`, never next to `id` and `kind`.',
    `- \`source\` — ${SOURCE}`,
    '',
    '## An edge (call)',
    '',
    'An edge is a call from `from` to `to` (node ids). The caller waits for the answer: a slow callee keeps the caller busy. Optional `id`; optional `apis` (a list of API names: only requests to those APIs take this edge).',
    '',
    `- \`source\` — ${SOURCE}`,
    '',
    `The first edge from a client is the internet: its \`latencyMs\` defaults to ${CLIENT_EDGE_LATENCY_MS} ms. Other edges default to 0.5 ms (one data center); between regions add ${INTER_REGION_MS} ms by default.`,
    '',
    'Edge parameters, written on the edge itself (not in `params`):',
    '',
    ...params(EDGE_PARAMS),
    '',
    '## How requests flow',
    '',
    '- Every request starts at a `client` node and is a read or a write (or a call to one of the `apis`).',
    '- A component with instances (a "station") gives each instance `concurrency` slots. A request takes a free slot or waits in the queue; above `queueLimit` it is rejected. A request keeps its slot while it waits for its downstream calls.',
    '- A `service`, `custom`, `worker` or `function` connected to both a `cache` and a store (`database`, `sharded_db`, `object_storage`) reads cache-aside: the cache first, the store only on a miss; a write goes to the store, then invalidates the cache.',
    '- An edge from a `cache` straight to a store makes it read-through / write-through: on a miss the cache reads the store itself; on a write it writes the store first.',
    '- A `queue` answers its caller at once; `worker` nodes connected after it process the messages and may call stores.',
    '- Use the edge parameter `on` ("read" or "write") to send only reads or only writes along an edge, or `apis` when the design has APIs.',
    '',
  ];
}

/** One section per kind: what it does, its edges, its parameters. `level` is the heading. */
function componentSections(level: string): string[] {
  return Object.values(KINDS).flatMap((k) => {
    const p = params(k.params);
    return [
      `${level} \`${k.kind}\` — ${k.labelEn}`,
      '',
      `${en(k.summary)}`,
      '',
      `Category: ${en(CATEGORY_LABEL[k.category])}. Outgoing edges: ${k.kind === 'cache' ? CACHE_ROUTING : ROUTING[k.routing]}`,
      '',
      ...(p.length ? ['Parameters (in `params`):', '', ...p] : ['No parameters.']),
      '',
    ];
  });
}

/** The full guide (public/llms-full.txt; the prompt for an AI holds it): everything on one page. */
export function aiGuide(): string {
  return [
    '# loadsketch design format',
    '',
    `loadsketch (${SITE}) is a simulator for system designs: components (nodes), the calls between them (edges), and the traffic sent through them. This page tells an AI model how to read and write a design. It is made from the component catalog of the app, so it matches the app.`,
    '',
    ...rules(),
    '## Components',
    '',
    ...componentSections('###'),
    '## Example',
    '',
    'A complete, valid design:',
    '',
    '```json',
    formatJson(GUIDE_EXAMPLE),
    '```',
    '',
  ].join('\n');
}

export const SKILL_NAME = 'loadsketch';
export const SKILL_DESCRIPTION =
  `Edit or create a system design for loadsketch (https://loadsketch.mclee.dev), a simulator for system designs. Use when the user wants to change, build or fix a loadsketch design (a JSON file whose schema is ${DESIGN_SCHEMA}), or asks for an architecture they will paste into loadsketch.`;

/** The small design SKILL.md shows; tests/ai-guide.test.ts checks that it is valid. */
export const SKILL_EXAMPLE: Design = {
  schema: DESIGN_SCHEMA,
  name: 'API with a database',
  nodes: [
    { id: 'users', kind: 'client', pos: [0, 200] },
    { id: 'api', kind: 'service', label: 'API', pos: [300, 200], params: { instances: 1, concurrency: 16, serviceMs: { mean: 8, cv: 1 } } },
    { id: 'db', kind: 'database', label: 'Postgres', pos: [600, 200] },
  ],
  edges: [
    { from: 'users', to: 'api' },
    { from: 'api', to: 'db', timeoutMs: 500 },
  ],
} as Design;

/**
 * The Agent Skill (M12, split in M15): the steps, the rules, the fields, one line per kind and a
 * small example. The parameters of each kind are in reference.md, one section per kind.
 */
export function skillMd(): string {
  const ref = `${SITE}${SKILL_PATH}/reference.md`;
  return [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${JSON.stringify(SKILL_DESCRIPTION)}`,
    '---',
    '',
    '# loadsketch',
    '',
    'loadsketch simulates a system design: components, the calls between them, and the traffic sent through them. The user works on the canvas of the web app; you work on the design JSON.',
    '',
    '## Steps',
    '',
    '1. Get the design JSON. If the user has not given it, ask for it: in loadsketch, File → "Paste design JSON" → "Copy only the design JSON", or File → "Save as JSON". A path to a saved `.json` file works too. To start from nothing, write a new design.',
    `2. Before you set or add a component of a kind, read that kind's section in reference.md in this folder: the section whose heading names the kind (for example the one for \`cache\`). It lists the parameters, their limits and defaults. If reference.md is not there, read ${ref}.`,
    '3. Change the design as the user asks, following the rules below. Change only what was asked. Keep the ids and the `source` fields of everything you keep.',
    '4. Check your answer: every field is allowed, every edge points to existing node ids, and every parameter is inside the limits in reference.md.',
    '5. Give back the whole design as one ```json code block (or write it to the file the user named). Say in a few lines what you changed and why.',
    '6. Tell the user to paste it back: in loadsketch, File → "Paste design JSON", paste, look at the list of changes, and click "Replace the canvas". If the app says something is wrong, fix what it names and give the whole design again.',
    '',
    ...rules(),
    '## Components',
    '',
    `The kinds, with what each does. Their parameters (inside \`params\`) are in reference.md, one section per kind (also at ${ref}).`,
    '',
    ...Object.values(KINDS).map((k) => `- \`${k.kind}\` — ${k.labelEn}: ${en(k.summary)}`),
    '',
    '## Example',
    '',
    'A small, valid design:',
    '',
    '```json',
    formatJson(SKILL_EXAMPLE),
    '```',
    '',
  ].join('\n');
}

/** reference.md next to SKILL.md: every kind's parameters, one `## ` section per kind. */
export function referenceMd(): string {
  return [
    '# loadsketch components',
    '',
    'One section per kind of component: what it does, where its outgoing edges go, and its parameters. Parameters go inside `params` of a node; leave one out to use its default. Times are in milliseconds unless the unit says otherwise. The rest of the format is in SKILL.md.',
    '',
    ...componentSections('##'),
  ].join('\n');
}

/** The files public/llms.txt points to, by their path on the site. */
export const LLMS_LINKS = {
  full: '/llms-full.txt',
  skill: `${SKILL_PATH}/SKILL.md`,
  reference: `${SKILL_PATH}/reference.md`,
  zip: '/skills/loadsketch.zip',
};

/** public/llms.txt: a short index (llmstxt.org): a title, a summary and links. */
export function llmsIndex(): string {
  return [
    '# loadsketch',
    '',
    `> loadsketch (${SITE}) is a simulator for system designs: components (nodes), the calls between them (edges), and the traffic sent through them. A design is one JSON file (schema "${DESIGN_SCHEMA}"); the user pastes a design an AI model wrote with File → "Paste design JSON", and the app shows every change before it replaces the canvas.`,
    '',
    'The format pages below are made from the component catalog of the app, so they match it. To write a design, read the full guide; an AI agent can use the skill instead.',
    '',
    '## Format',
    '',
    `- [Full format guide](${SITE}${LLMS_LINKS.full}): every field, every component and its parameters, and an example, on one page`,
    `- [Agent Skill](${SITE}${LLMS_LINKS.skill}): the steps, the rules, the fields and one line per component, for an AI agent`,
    `- [Component reference](${SITE}${LLMS_LINKS.reference}): the parameters of each component, one section each`,
    `- [Skill as a zip](${SITE}${LLMS_LINKS.zip}): SKILL.md and reference.md in a loadsketch folder, to unpack into ~/.claude/skills/`,
    '',
    '## Examples',
    '',
    `- [Example designs](${REPO}/tree/main/examples/designs): complete designs, one JSON file each`,
    '',
    '## Optional',
    '',
    `- [README](${REPO}/blob/main/README.md): what the app does, the CLI, and how to run it`,
    '',
  ].join('\n');
}

/** The text the "copy a prompt for an AI" button puts on the clipboard: the guide, the design, the request. */
export function aiPrompt(design: Design, guideUrl: string): string {
  return [
    'You are editing a system design for loadsketch, a system design simulator.',
    `The format is below (also at ${guideUrl}). Answer with the whole changed design as one JSON code block.`,
    '',
    aiGuide(),
    '## The current design',
    '',
    '```json',
    formatJson(design),
    '```',
    '',
    '## What to change',
    '',
    '(Write what you want here.)',
    '',
  ].join('\n');
}
