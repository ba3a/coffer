import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Version of the format of the report file. */
export const REPORT_VERSION = 1;

/** Name of the folder, beside the configuration file, that holds the report. */
export const REPORT_DIR_NAME = '.coffer';

/** Name of the report file inside {@link REPORT_DIR_NAME}. */
export const REPORT_FILE_NAME = 'report.json';

/**
 * One finding of a build.
 *
 * @typedef {object} ReportIssue
 * @property {string} message What is wrong, without the location.
 * @property {string} [site] Id of the site the finding belongs to.
 * @property {string} [file] Path of the source file, relative to the configuration file, with forward slashes.
 * @property {number} [line] 1-based line in `file`.
 * @property {number} [column] 1-based column in `file`; only given together with `line`.
 */

/**
 * A page that publishes exact locations: images whose published file carries
 * the exact position, and GPX tracks (a GPX file is published unchanged, so it
 * always carries exact positions).
 *
 * @typedef {object} ExactLocation
 * @property {string} site Id of the site.
 * @property {string} file Path of the post (or other page source), relative to the configuration file, with forward slashes.
 * @property {number} images Number of its distinct images whose published file carries the exact position; 0 for a page that only publishes tracks.
 * @property {number} [tracks] Number of GPX files it publishes; absent when there are none.
 */

/**
 * What a build reports: `errors` fail the build, `warnings` are worth fixing,
 * `exactLocations` lists the posts that publish exact locations, and `info` is
 * for the record.
 *
 * @typedef {object} ReportData
 * @property {number} reportVersion
 * @property {ReportIssue[]} errors
 * @property {ReportIssue[]} warnings
 * @property {ExactLocation[]} exactLocations
 * @property {ReportIssue[]} info
 */

/** Heading of the section that lists the posts that publish exact locations. */
export const EXACT_LOCATIONS_TITLE = 'Posts publishing exact locations';

/**
 * The section "Posts publishing exact locations" as text: the heading with the
 * number of posts, then one line per post with its image and track counts. With none, a
 * single line says so.
 *
 * @param {readonly ExactLocation[]} entries
 * @returns {string} Lines ending in a newline.
 */
export function formatExactLocations(entries) {
  if (entries.length === 0) return `${EXACT_LOCATIONS_TITLE}: none\n`;
  // Two sites can share content files, so the site is named when there are several.
  const several = new Set(entries.map((entry) => entry.site)).size > 1;
  const lines = entries.map((entry) => {
    /** @type {string[]} */
    const what = [];
    if (entry.images > 0 || !entry.tracks) what.push(`${entry.images} image(s)`);
    if (entry.tracks) what.push(`${entry.tracks} track(s)`);
    return `  ${several ? `${entry.site}: ` : ''}${entry.file}: ${what.join(', ')}`;
  });
  return `${EXACT_LOCATIONS_TITLE} (${entries.length})\n${lines.join('\n')}\n`;
}

/**
 * Raised at the end of a build that found errors. Every error is listed in
 * {@link ReportError#errors}, formatted as `file:line:column message`.
 */
export class ReportError extends Error {
  /**
   * @param {ReportIssue[]} issues The errors of the build.
   */
  constructor(issues) {
    const errors = issues.map(formatIssue);
    super(errors.join('\n'));
    this.name = 'ReportError';
    /** @type {string[]} */
    this.errors = errors;
    /** @type {ReportIssue[]} */
    this.issues = issues;
  }
}

/**
 * Formats a finding for people: `content/journal/foo/index.md:12:5 broken link '../bar/'`.
 * The column and the line are left out when unknown, and so is the file.
 *
 * @param {ReportIssue} issue
 * @returns {string}
 */
export function formatIssue(issue) {
  if (issue.file === undefined) return issue.message;
  const place = [issue.file, issue.line, issue.line === undefined ? undefined : issue.column]
    .filter((part) => part !== undefined)
    .join(':');
  return `${place} ${issue.message}`;
}

/**
 * Collects the findings of a build. Later steps add their own through the same
 * three sections.
 */
export class Report {
  constructor() {
    /** @type {ReportIssue[]} */
    this.errors = [];
    /** @type {ReportIssue[]} */
    this.warnings = [];
    /** @type {ReportIssue[]} */
    this.info = [];
    /** @type {ExactLocation[]} */
    this.exactLocations = [];
  }

  /**
   * @param {ExactLocation} entry A post that publishes exact locations.
   * @returns {this}
   */
  addExactLocation(entry) {
    this.exactLocations.push({ ...entry });
    return this;
  }

  /**
   * @param {string | ReportIssue} issue A message, or a finding with its location.
   * @returns {this}
   */
  addError(issue) {
    this.errors.push(toIssue(issue));
    return this;
  }

  /**
   * @param {string | ReportIssue} issue
   * @returns {this}
   */
  addWarning(issue) {
    this.warnings.push(toIssue(issue));
    return this;
  }

  /**
   * @param {string | ReportIssue} issue
   * @returns {this}
   */
  addInfo(issue) {
    this.info.push(toIssue(issue));
    return this;
  }

  /** True when nothing was reported as an error. */
  get ok() {
    return this.errors.length === 0;
  }

  /**
   * The report as plain data, ready to be written as JSON.
   *
   * @returns {ReportData}
   */
  toJSON() {
    return {
      reportVersion: REPORT_VERSION,
      errors: this.errors,
      warnings: this.warnings,
      exactLocations: this.exactLocations,
      info: this.info,
    };
  }

  /**
   * The report as text for people: a heading per non-empty section, one line per finding.
   *
   * @returns {string}
   */
  format() {
    /** @type {string[]} */
    const lines = [];
    /** @param {string} title @param {ReportIssue[]} issues */
    const addSection = (title, issues) => {
      if (issues.length === 0) return;
      if (lines.length > 0) lines.push('');
      lines.push(`${title} (${issues.length})`);
      for (const issue of issues) lines.push(`  ${formatIssue(issue)}`);
    };
    addSection('Errors', this.errors);
    addSection('Warnings', this.warnings);
    if (this.exactLocations.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(...formatExactLocations(this.exactLocations).trimEnd().split('\n'));
    }
    addSection('Info', this.info);
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  /**
   * Throws a {@link ReportError} when the report holds errors.
   *
   * @throws {ReportError}
   */
  throwIfFailed() {
    if (!this.ok) throw new ReportError(this.errors);
  }
}

/**
 * @param {string | ReportIssue} issue
 * @returns {ReportIssue}
 */
function toIssue(issue) {
  return typeof issue === 'string' ? { message: issue } : { ...issue };
}

/**
 * Writes the report as JSON, creating the folder when needed. The file is
 * meant to live outside the site's output, so deployments never carry it.
 *
 * @param {Report} report
 * @param {string} file Absolute path of the report file.
 */
export function writeReport(report, file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report.toJSON(), null, 2)}\n`);
}
