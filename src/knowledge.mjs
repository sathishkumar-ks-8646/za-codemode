/**
 * The OKF knowledge base, as a tool the model can consult.
 *
 * Signatures tell a model *what it can call*. They do not tell it that
 * criteria strings use a particular SQL-like grammar, that CONFIG must be
 * stringified, or that a bulk export is three calls and a poll. Those are the
 * things generated code gets wrong, and they live in the OKF documentation —
 * so this module puts them one tool call away.
 *
 * Built by tools/build-knowledge.mjs from v2.0/okf; never hand-edited.
 */
import { readFileSync } from 'node:fs';

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'from',
  'with', 'and', 'or', 'how', 'do', 'does', 'i', 'my', 'is', 'are', 'what', 'can']);

const tokenize = (text) => text.toLowerCase().split(/[^a-z0-9]+/)
  .filter((t) => t.length > 2 && !STOPWORDS.has(t));

/** Operation-name fragments that imply a workflow worth reading first. */
const OPERATION_HINTS = [
  [/exportjob|createexportjob|downloadexported/i, 'export-data-asynchronously'],
  [/importjob|createimportjob|importdata/i, 'import-large-dataset'],
  [/share|permission/i, 'share-view-with-row-filter'],
  [/embed/i, 'embed-view-multi-tenant'],
  [/emailschedule|schedule/i, 'schedule-email-report'],
  [/user|role|group/i, 'manage-users-and-roles'],
  [/automl|analysis/i, 'train-and-run-automl-model'],
];

/** Argument names that imply a reference worth reading first. */
const ARGUMENT_HINTS = [
  [/criteria/i, 'filter-criteria-syntax'],
  [/\bCONFIG\b/, 'request-conventions'],
];

export class Knowledge {
  #docs;
  #errors;
  #source;
  #builtAt;

  constructor(path) {
    const bundle = JSON.parse(readFileSync(path, 'utf8'));
    this.#docs = bundle.docs;
    this.#errors = bundle.errors;
    this.#source = bundle.source ?? {};
    this.#builtAt = bundle.builtAt ?? null;
  }

  get size() { return this.#docs.length; }
  get errorCount() { return Object.keys(this.#errors).length; }

  /**
   * Where this documentation came from and how old it is.
   *
   * The source of truth is github.com/zoho/analytics-okf, so the bundle is a
   * copy of a published snapshot. Age is measured from when that snapshot was
   * generated, not when we compiled it: rebuilding an old bundle today does
   * not make it current.
   */
  get provenance() {
    const generatedAt = this.#source.okfGeneratedAt ?? null;
    const ageDays = generatedAt
      ? Math.floor((Date.now() - Date.parse(generatedAt)) / 86_400_000)
      : null;
    return {
      repository: this.#source.repository ?? null,
      origin: this.#source.origin ?? null,
      apiVersion: this.#source.apiVersion ?? null,
      okfVersion: this.#source.okfVersion ?? null,
      okfGeneratedAt: generatedAt,
      bundleBuiltAt: this.#builtAt,
      ageDays,
      stale: ageDays !== null && ageDays > 90,
    };
  }

  /** Every topic, for the "no match" response and the tool description. */
  list() {
    return this.#docs.map(({ id, kind, title, description }) =>
      ({ id, kind, title, description }));
  }

  byId(id) {
    return this.#docs.find((d) => d.id === id)
      ?? this.#docs.find((d) => d.id === id.replace(/\s+/g, '-').toLowerCase());
  }

  /** A single error code, or undefined. */
  error(code) { return this.#errors[String(code)]; }

  /** Rank topics for a free-text question. Title and id weigh most. */
  find(query, limit = 3) {
    const terms = tokenize(query);
    if (!terms.length) return [];

    const scored = this.#docs.map((doc) => {
      const idTokens = new Set(doc.id.split('-'));
      const titleTokens = new Set(tokenize(doc.title));
      const descTokens = new Set(tokenize(doc.description));
      const bodyText = doc.body.toLowerCase();

      let score = 0;
      for (const term of terms) {
        if (idTokens.has(term)) score += 8;
        else if (titleTokens.has(term)) score += 6;
        else if (descTokens.has(term)) score += 3;
        else if (bodyText.includes(term)) score += 1;
      }
      // A playbook is usually the better answer to "how do I ..."
      if (doc.kind === 'workflow') score *= 1.15;
      return { doc, score };
    }).filter((s) => s.score > 0);

    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.doc);
  }

  /**
   * Topics worth reading before writing code for these operations.
   *
   * Appended to search results so the model is nudged towards the playbook
   * without having to know it exists.
   */
  hintsFor(operations) {
    const hints = new Set();

    for (const op of operations) {
      for (const [pattern, id] of OPERATION_HINTS) {
        if (pattern.test(op.name)) hints.add(id);
      }
      const args = Object.keys(op.inputs?.properties ?? {}).join(' ');
      for (const [pattern, id] of ARGUMENT_HINTS) {
        if (pattern.test(args)) hints.add(id);
      }
    }

    return [...hints]
      .map((id) => this.byId(id))
      .filter(Boolean)
      .map(({ id, kind, title }) => ({ id, kind, title }));
  }

  /** Error codes mentioned in a failure message, with their explanations. */
  explainCodes(message) {
    const found = [];
    for (const match of String(message).matchAll(/\b(\d{4})\b/g)) {
      const entry = this.#errors[match[1]];
      if (entry && !found.some((f) => f.code === match[1])) {
        found.push({ code: match[1], ...entry });
      }
    }
    return found;
  }
}
