/**
 * @aerolith/pdf — document generation with no dependencies.
 *
 * Deliberately not a headless browser. Rendering HTML to PDF means shipping
 * Chromium to the deployment target, which on the free-tier VM this is designed
 * for costs more memory than the database. A payment certificate is text, rules
 * and a table; that does not need a browser.
 */
export {
  A4,
  Page,
  encodeText,
  isRenderable,
  renderPdf,
  truncate,
  widthOf,
  type DocumentInfo,
  type FontName,
  type TextOptions,
} from './document';

export { Layout, MARGINS, type Column, type Margins } from './layout';
