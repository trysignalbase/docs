#!/usr/bin/env node
/**
 * Build the aggregate `api-reference/openapi.json` from the per-page specs.
 *
 * The per-page specs (one folder per tab) are the canonical, human-edited
 * source of truth — they are what Mintlify renders. This script merges them
 * into a single downloadable spec so a vendor consuming the canonical
 * `openapi.json` sees the full public surface, not just one endpoint.
 *
 * Schemas — and the shared `responses` / `parameters` some specs define — are
 * namespaced per spec (e.g. `Funding_Meta`, `Webhook_BadRequest`) because
 * several specs define same-named components (`Meta`, `Source`, `Pagination`,
 * `ErrorResponse`, `BadRequest`) with different shapes. Paths are already
 * unique across specs.
 *
 * Run from the docs/ directory:  node scripts/build-openapi.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(docsDir, "api-reference");

// folder -> schema namespace prefix
const SPECS = {
  "funding-signals": "Funding",
  "acquisition-signals": "Acquisition",
  "job-change-signals": "JobChange",
  "hiring-signals": "Hiring",
  investors: "Investors",
  companies: "Companies",
  people: "People",
  "csv-enrichment": "Csv",
  webhooks: "Webhook",
  monitors: "Monitor",
};

const merged = {
  openapi: "3.1.0",
  info: {
    title: "Signalbase API",
    description:
      "Complete Signalbase V2 API: signal endpoints (funding, acquisitions, job changes, hiring, investors), companies, people, CSV enrichment, webhooks, and monitoring. Generated from the per-page specs under api-reference/*/openapi.json (run scripts/build-openapi.mjs).",
    version: "2.4.0",
  },
  servers: [{ url: "https://www.trysignalbase.com/api/v2" }],
  security: [{ bearerAuth: [] }],
  paths: {},
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API key",
        description:
          "Use your `ff_live_…` API key as a Bearer token in the Authorization header.",
      },
    },
    schemas: {},
    responses: {},
    parameters: {},
  },
};

// Component sections that get namespaced and merged.
const SECTIONS = ["schemas", "responses", "parameters"];

for (const [folder, prefix] of Object.entries(SPECS)) {
  const specPath = join(apiDir, folder, "openapi.json");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));

  // Namespace this spec's components, then rewrite every $ref to them by
  // replacing the fully-quoted ref token (the trailing quote prevents partial
  // name collisions, e.g. `Investor` vs `InvestorsResponse`).
  const slice = { paths: spec.paths ?? {} };
  for (const section of SECTIONS) {
    slice[section] = spec.components?.[section] ?? {};
  }
  let rewritten = JSON.stringify(slice);
  for (const section of SECTIONS) {
    for (const name of Object.keys(slice[section])) {
      rewritten = rewritten
        .split(`"#/components/${section}/${name}"`)
        .join(`"#/components/${section}/${prefix}_${name}"`);
    }
  }
  const { paths, ...components } = JSON.parse(rewritten);

  for (const [p, def] of Object.entries(paths)) {
    if (merged.paths[p]) {
      throw new Error(`Duplicate path ${p} (from ${folder})`);
    }
    merged.paths[p] = def;
  }
  for (const section of SECTIONS) {
    for (const [name, def] of Object.entries(components[section])) {
      merged.components[section][`${prefix}_${name}`] = def;
    }
  }
}

// A merged spec with a $ref that resolves nowhere is worse than no spec.
const dangling = [
  ...new Set(
    [...JSON.stringify(merged).matchAll(/"#\/components\/(\w+)\/(\w+)"/g)]
      .filter(([, section, name]) => !merged.components[section]?.[name])
      .map(([token]) => token),
  ),
];
if (dangling.length > 0) {
  throw new Error(`Dangling $ref(s) in merged spec: ${dangling.join(", ")}`);
}

const out = join(apiDir, "openapi.json");
writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
const pathCount = Object.keys(merged.paths).length;
const schemaCount = Object.keys(merged.components.schemas).length;
console.log(
  `Wrote ${out} — ${pathCount} paths, ${schemaCount} schemas from ${
    Object.keys(SPECS).length
  } specs.`,
);
