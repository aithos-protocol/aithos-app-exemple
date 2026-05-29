// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

/**
 * Vendor schema example for the /data demo: `aithos.x.demo.notes.v1`.
 *
 * Two representations are exported, BOTH required to participate in the
 * Aithos data sub-protocol end-to-end:
 *
 *   1. {@link notesV1Lite} — an `AithosSchemaLite` used by the SDK
 *      *locally* to split a record into its indexable metadata (sent
 *      in clear to the PDS so the server can filter/sort) and its
 *      encrypted payload (AEAD'd client-side under a per-collection
 *      CMK before transport).
 *
 *   2. {@link notesV1JsonSchema} — a JSON Schema 2020-12 document
 *      published *server-side* via `client.registerSchema(...)`. Once
 *      published, the PDS enforces the shape on every record write
 *      (additionalProperties: false, required fields, types). This
 *      closes the security gap A2a left open before alpha.39: a buggy
 *      or malicious client can no longer stuff arbitrary fields into
 *      the indexable metadata of a vendor record.
 *
 * The naming convention `aithos.x.<vendor>.<name>.v<N>` is mandatory
 * for app-defined schemas — without the `.x.` segment the PDS rejects
 * `registerSchema` (core schemas like `aithos.contacts.v1` are bundled
 * with the SDK, not published per subject).
 *
 * Bumping the version segment (`v1` → `v2`) is the supported path to
 * evolve the shape; a different document for the same `aithos:schema`
 * id is rejected with `-32082 AITHOS_DATA_SCHEMA_IMMUTABLE`.
 */

import type { AithosSchemaLite } from "@aithos/sdk";

/* -------------------------------------------------------------------------- */
/*  Schema id                                                                 */
/* -------------------------------------------------------------------------- */

export const NOTES_SCHEMA_ID = "aithos.x.demo.notes.v1" as const;

/* -------------------------------------------------------------------------- */
/*  AithosSchemaLite — consumed by `createDataClient({ schemas: [...] })`     */
/* -------------------------------------------------------------------------- */

/**
 * Field split for the SDK's client-side encryption pipeline.
 *
 *   - **indexable**: shipped in clear to the PDS, eligible for filter /
 *     sort on `list({filter:…})`. Choose only fields the server
 *     *needs* to see (titles, statuses, tags…).
 *   - **encrypted**: AEAD'd under a per-collection CMK before
 *     transport, decrypted in this browser on `get` / `list`. The PDS
 *     never sees plaintext.
 *   - **auto**: populated by the SDK on every write (ISO-8601 UTC).
 *   - **defaults**: applied at insert when the caller omits the field.
 */
export const notesV1Lite: AithosSchemaLite = {
  schema: NOTES_SCHEMA_ID,
  indexable: new Set([
    "title",
    "tags",
    "status",
    "pinned",
    "created_at",
    "modified_at",
  ]),
  encrypted: new Set(["content", "private_notes"]),
  auto: new Set(["created_at", "modified_at"]),
  defaults: {
    status: "draft",
    pinned: false,
  },
};

/* -------------------------------------------------------------------------- */
/*  JSON Schema 2020-12 — registered server-side via registerSchema()         */
/* -------------------------------------------------------------------------- */

/**
 * Statuses the form's `<select>` exposes — also enforced by the JSON
 * Schema enum below, so any future client (mobile, CLI…) that tries to
 * write an unknown status will be rejected at the PDS.
 */
export const NOTE_STATUSES = ["draft", "published", "archived"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/**
 * Full JSON Schema 2020-12 document. The `aithos:schema` and
 * `aithos:version` top-level fields are required by the PDS.
 * `aithos:indexable: true` on a property mirrors `notesV1Lite.indexable`
 * for spec compliance / clarity — the actual server-side enforcement
 * comes from the schema's `properties` shape and `additionalProperties:
 * false`.
 *
 * Shape is intentionally minimal — adding fields requires a new
 * version (immutability per spec §3.5). Keep this in sync with
 * {@link notesV1Lite} above when extending.
 */
export const notesV1JsonSchema = {
  "aithos:schema": NOTES_SCHEMA_ID,
  "aithos:version": "1.0.0",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      "aithos:indexable": true,
    },
    tags: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 64 },
      maxItems: 32,
      uniqueItems: true,
      "aithos:indexable": true,
    },
    status: {
      type: "string",
      enum: NOTE_STATUSES,
      "aithos:indexable": true,
    },
    pinned: {
      type: "boolean",
      "aithos:indexable": true,
    },
    content: {
      type: "string",
      maxLength: 100_000,
      description: "Markdown body. AEAD'd client-side under the CMK.",
    },
    private_notes: {
      type: "string",
      maxLength: 10_000,
      description: "Private side-notes never indexed.",
    },
    created_at: {
      type: "string",
      format: "date-time",
      "aithos:indexable": true,
      "aithos:auto": true,
    },
    modified_at: {
      type: "string",
      format: "date-time",
      "aithos:indexable": true,
      "aithos:auto": true,
    },
  },
} as const;
