// intercom-receipt: Apex chrome for pi-intercom (`intercom` and
// `contact_supervisor` tools plus inbound `intercom_message` notices).
//
// pi-intercom owns execute and registers its own renderCall/renderResult. Apex
// cannot import that extension. Tool receipts arrive through the shared
// headless wrap with overrideOwned; the inbound notice arrives through a
// message renderer. Apex loads before npm packages and Pi resolves duplicate
// message renderers first-in-load-order, so this registration wins over the
// owner's `intercom_message` renderer while Apex presentation is enabled.
//
// PI_APEX_UI=0 skips both, leaving pi-intercom's own presentation intact.
// Model-facing content is never touched: only TUI display is reskinned.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  safeTruncateToWidth,
  safeVisibleWidth,
  wrapPlainText,
} from "./safe-text-layout.ts";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { WidthText, cleanInline, fitLine } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";
import {
  buildTreeLines,
  metaText,
  noteRow,
  safeLine,
  type StatusTheme,
  type TreeRow,
} from "./receipt-tree.ts";

export const INTERCOM_TOOL = "intercom";
export const CONTACT_SUPERVISOR_TOOL = "contact_supervisor";

export type IntercomArgs = {
  action?: string;
  to?: string;
  message?: string;
  attachments?: unknown[];
  messageId?: string;
  cwd?: string;
};

export type ContactSupervisorArgs = {
  reason?: string;
  message?: string;
  interview?: { title?: unknown };
};

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

function shortId(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 8) : "";
}

/**
 * Compact header: `ask -> worker` / `send -> worker +2 files` /
 * `list` / `list-cwd @ ./rel` / `cancel a1b2c3d4` / `reply hello ...`.
 * The message itself stays in the preview/body; the header carries only a
 * short fragment so the running call row still reads usefully.
 */
export function intercomReceiptArg(
  args: IntercomArgs | undefined,
  budget: number,
): string {
  const cap = Math.max(8, budget);
  const action = cleanInline(args?.action, 16) || "intercom";
  if (action === "cancel") {
    const id = shortId((args as { messageId?: unknown } | undefined)?.messageId);
    return cleanInline(
      id ? `cancel ${id}` : "cancel",
      cap,
    );
  }
  const parts: string[] = [action];
  const target = cleanInline(args?.to, 40);
  if (target) parts.push(`-> ${target}`);
  const cwd = cleanInline(args?.cwd, 60);
  if (cwd) parts.push(`@ ${cwd}`);
  if (Array.isArray(args?.attachments) && args.attachments.length > 0) {
    const count = args.attachments.length;
    parts.push(`+${count} file${count === 1 ? "" : "s"}`);
  }
  if (
    (action === "send" || action === "ask" || action === "reply") &&
    typeof args?.message === "string"
  ) {
    const fragment = cleanInline(args.message, 80);
    if (fragment) parts.push(fragment);
  }
  return cleanInline(parts.join(" "), cap);
}

/**
 * Compact header: `need_decision` / `progress_update` /
 * `interview_request title + message fragment`.
 */
export function contactSupervisorReceiptArg(
  args: ContactSupervisorArgs | undefined,
  budget: number,
): string {
  const cap = Math.max(8, budget);
  const reason = cleanInline(args?.reason, 24) || "contact";
  const parts: string[] = [reason];
  const interview = args?.interview;
  if (interview && typeof interview === "object") {
    const title =
      typeof interview.title === "string"
        ? cleanInline(interview.title, 60)
        : "";
    if (title) parts.push(title);
  }
  if (typeof args?.message === "string") {
    const fragment = cleanInline(args.message, 80);
    if (fragment) parts.push(fragment);
  }
  return cleanInline(parts.join(" "), cap);
}

/** Owner-reported structured-reply parse warning; empty when none. */
function supervisorParseWarning(result: any): string {
  const raw = detailsOf(result).structuredReplyParseError;
  return typeof raw === "string" && raw.trim()
    ? cleanInline(raw, 200)
    : "";
}

/** Short delivery id for the right-of-arg slot; empty when nothing to show. */
function deliveryStats(result: any): string {
  const details = detailsOf(result);
  if (details.error === true || details.delivered === false) return "";
  const id = shortId(details.messageId);
  if (id) return id;
  if (details.delivered === true) return "sent";
  return "";
}

export const intercomReceiptRenderers = toolRenderers<IntercomArgs>({
  surface: INTERCOM_TOOL,
  title: INTERCOM_TOOL,
  arg: intercomReceiptArg,
  stats: deliveryStats,
  preview(output) {
    return output ? boundedOutput(output, 4, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

export const contactSupervisorReceiptRenderers =
  toolRenderers<ContactSupervisorArgs>({
    surface: CONTACT_SUPERVISOR_TOOL,
    title: CONTACT_SUPERVISOR_TOOL,
    arg: contactSupervisorReceiptArg,
    stats: deliveryStats,
    expandWhen: (result) => Boolean(supervisorParseWarning(result)),
    preview(output, result) {
      const warning = supervisorParseWarning(result);
      if (!warning) return output ? boundedOutput(output, 4, 1200) : [];
      // boundedOutput can append a truncation-suffix row beyond the line
      // budget; slice first so the warning always lands in the engine's
      // 4-row preview window instead of the suffix pushing it out.
      const base = output ? boundedOutput(output, 3, 1200).slice(0, 3) : [];
      return [...base, `Parse issue: ${warning}`];
    },
    body(output, result) {
      const warning = supervisorParseWarning(result);
      if (!warning) return output ? boundedOutput(output, 80) : [];
      const base = output ? boundedOutput(output, 79).slice(0, 79) : [];
      return [...base, `Parse issue: ${warning}`];
    },
  });

/** Attach Apex receipts to intercom and contact_supervisor. */
export function installIntercomReceipts(pi: ExtensionAPI): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(INTERCOM_TOOL, intercomReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(
    CONTACT_SUPERVISOR_TOOL,
    contactSupervisorReceiptRenderers,
    { overrideOwned: true },
  );
  installHeadlessReceipts();
  pi.registerMessageRenderer<IntercomMessageDetails>(
    INTERCOM_MESSAGE_TYPE,
    (message, options, theme) =>
      intercomMessageComponent(theme, message.details, {
        expanded: options.expanded,
        pad: options.outputPad,
      }),
  );
}

/* ------------------------------------------------------------------ */
/* Inbound `intercom_message` notice                                   */
/* ------------------------------------------------------------------ */

export const INTERCOM_MESSAGE_TYPE = "intercom_message";

/** Structural subset of the details pi-intercom attaches to inbound notices. */
export interface IntercomMessageDetails {
  from?: {
    id?: unknown;
    name?: unknown;
    cwd?: unknown;
    model?: unknown;
    status?: unknown;
  };
  message?: {
    id?: unknown;
    content?: { text?: unknown; attachments?: unknown };
    expectsReply?: unknown;
    replyTo?: unknown;
    provenance?: { type?: unknown; extensionName?: unknown };
  };
  replyCommand?: unknown;
  bodyText?: unknown;
}

/** Parsed inbound notice, ready for layout. */
export interface IntercomMessageView {
  senderName: string;
  senderId: string;
  cwd: string;
  model: string;
  status: string;
  expectsReply: boolean;
  replyTo: string;
  attachmentCount: number;
  via: string;
  rawBody: string;
  replyCommand: string;
}

export interface IntercomMessageViewOptions {
  expanded: boolean;
  pad?: number;
}

const MESSAGE_BODY_COLLAPSED = 4;
const MESSAGE_BODY_EXPANDED = 80;
const MESSAGE_BODY_CHARS = 8000;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Structural read of an inbound notice. Returns undefined when there is
 * nothing renderable, letting Pi fall back to its default presentation.
 */
export function parseIntercomMessage(
  details: IntercomMessageDetails | undefined,
): IntercomMessageView | undefined {
  const from = recordOf(details?.from);
  const msg = recordOf(details?.message);
  const content = recordOf(msg?.content);
  const provenance = recordOf(msg?.provenance);
  const senderId = typeof from?.id === "string" ? from.id : "";
  const senderName =
    safeLine(from?.name, 40) || (senderId ? senderId.slice(0, 8) : "");
  const bodyText =
    typeof details?.bodyText === "string" && details.bodyText.trim()
      ? details.bodyText
      : typeof content?.text === "string"
        ? content.text
        : "";
  if (!senderName && !bodyText.trim()) return undefined;
  const attachments = Array.isArray(content?.attachments)
    ? content.attachments
    : [];
  return {
    senderName,
    senderId,
    cwd: safeLine(from?.cwd, 100),
    model: safeLine(from?.model, 40),
    status: safeLine(from?.status, 24),
    expectsReply: msg?.expectsReply === true,
    replyTo: shortId(msg?.replyTo),
    attachmentCount: attachments.length,
    via:
      provenance?.type === "extension_outbox"
        ? safeLine(provenance.extensionName, 40)
        : "",
    rawBody: bodyText,
    replyCommand: safeLine(details?.replyCommand, 300),
  };
}

/**
 * Wrap a message body onto bounded rows, preserving paragraph breaks.
 * Appends a truncation note when the char or line budget gives way.
 */
export function messageBodyRows(
  rawText: string,
  width: number,
  maxLines: number,
  maxChars: number,
): string[] {
  const raw = rawText.length > maxChars ? rawText.slice(0, maxChars) : rawText;
  let truncated = raw.length < rawText.length;
  const paragraphs = raw.split(/\r?\n/);
  const rows: string[] = [];
  let consumed = 0;
  for (; consumed < paragraphs.length; consumed++) {
    if (rows.length >= maxLines) break;
    const paragraph = paragraphs[consumed] ?? "";
    if (!paragraph.trim()) {
      rows.push("");
      continue;
    }
    // Request one row beyond the remaining budget: the wrapper silently caps,
    // so overflow inside a single paragraph must be detected, not inferred.
    const room = maxLines - rows.length;
    const wrapped = wrapPlainText(paragraph, width, { maxLines: room + 1 });
    if (wrapped.length > room) {
      rows.push(...wrapped.slice(0, room));
      truncated = true;
      consumed++;
      break;
    }
    rows.push(...wrapped);
  }
  if (consumed < paragraphs.length) truncated = true;
  let end = rows.length;
  while (end > 0 && !rows[end - 1]!.trim()) end--;
  const shown = rows.slice(0, end);
  if (truncated) shown.push("... more not shown");
  return shown;
}

/**
 * Greedily pack metadata parts into full-width rows. Every part appears;
 * later parts wrap onto further rows instead of being pushed out by earlier
 * long ones sharing a single truncated row.
 */
export function metaPackRows(parts: string[], width: number): string[] {
  const rows: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current ? `${current} \u00b7 ${part}` : part;
    if (current && safeVisibleWidth(candidate) > width) {
      rows.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) rows.push(current);
  return rows;
}

/**
 * The one inbound-message shape:
 *
 *   ● message  intercom  from worker · expects reply          inbound
 *   ├─ ● worker (a1b2c3d4)
 *   │  body line
 *   ├─ /repo · model · 2 attachments
 *   ╰─ To reply: intercom({ action: "reply", message: "..." })
 *
 * Metadata gets dedicated rows so a long cwd can never push reply
 * threading, attachment, or provenance parts out of view.
 *
 * A notice that needs a reply carries the warning tone; an FYI carries the
 * success tone. The `inbound` tag is what separates this from a user turn.
 */
export function intercomMessageLines(
  theme: StatusTheme,
  width: number,
  view: IntercomMessageView,
  options: IntercomMessageViewOptions,
): string[] {
  const tone = view.expectsReply ? "warning" : "success";
  const pad = Math.max(0, Math.min(options.pad ?? 0, 8));
  const inner = Math.max(8, width - pad);
  const inset = " ".repeat(pad);
  const previewWidth = Math.max(8, inner - 3);

  const summary =
    metaText([
      view.senderName ? `from ${view.senderName}` : undefined,
      view.expectsReply ? "expects reply" : undefined,
    ]) || "message";

  const headerLeft = [
    theme.fg(tone, "\u25cf"),
    theme.fg("customMessageLabel", "message"),
    inner >= 44 ? theme.fg("muted", "intercom") : "",
    theme.fg(view.expectsReply ? "warning" : "text", summary),
  ]
    .filter(Boolean)
    .join(" ");
  const header =
    inner >= 56
      ? fitLine(headerLeft, theme.fg("dim", "inbound"), inner)
      : safeTruncateToWidth(headerLeft, inner);

  const bodyMax = options.expanded
    ? MESSAGE_BODY_EXPANDED
    : MESSAGE_BODY_COLLAPSED;
  const treeRows: TreeRow[] = [
    {
      line: (rail) => {
        const cells = [theme.fg("dim", rail), theme.fg(tone, "\u25cf")];
        if (view.senderName) {
          cells.push(theme.fg("accent", safeLine(view.senderName, 40)));
        }
        if (view.senderId) {
          cells.push(theme.fg("muted", `(${view.senderId.slice(0, 8)})`));
        }
        return safeTruncateToWidth(cells.join(" "), inner);
      },
      continuation: view.rawBody.trim()
        ? messageBodyRows(
            view.rawBody,
            previewWidth,
            bodyMax,
            MESSAGE_BODY_CHARS,
          )
        : undefined,
      continuationToken: "toolOutput",
    },
  ];
  const metaLines = metaPackRows(
    [
      view.cwd,
      view.model,
      view.status,
      view.replyTo && !view.expectsReply
        ? `reply to ${view.replyTo}`
        : "",
      view.attachmentCount > 0
        ? `${view.attachmentCount} attachment${view.attachmentCount === 1 ? "" : "s"}`
        : "",
      view.via ? `via ${view.via}` : "",
    ].filter(Boolean),
    previewWidth,
  );
  if (metaLines.length) {
    treeRows.push({
      line: (rail) =>
        safeTruncateToWidth(
          `${theme.fg("dim", rail)} ${theme.fg("dim", metaLines[0])}`,
          inner,
        ),
      continuation: metaLines.slice(1),
      continuationToken: "dim",
    });
  }
  // Only the owner's reply command is shown: when reply hints are disabled
  // upstream, no command is synthesized. The header still flags expects reply.
  const replyHint = view.replyCommand
    ? `To reply: ${view.replyCommand}`
    : "";
  if (replyHint) {
    const hintLines = wrapPlainText(safeLine(replyHint, 300), previewWidth, {
      maxLines: 3,
    }).filter(Boolean);
    if (hintLines.length) {
      const hintRow = noteRow(theme, inner, hintLines[0] ?? "", "muted");
      hintRow.continuation = hintLines.slice(1);
      hintRow.continuationToken = "muted";
      treeRows.push(hintRow);
    }
  }

  return buildTreeLines(theme, inner, header, treeRows).map((line) =>
    inset ? safeTruncateToWidth(`${inset}${line}`, width) : line,
  );
}

/** Message renderer body: undefined falls through to Pi's default rendering. */
export function intercomMessageComponent(
  theme: StatusTheme,
  details: IntercomMessageDetails | undefined,
  options: IntercomMessageViewOptions,
): Component | undefined {
  const view = parseIntercomMessage(details);
  if (!view) return undefined;
  return new WidthText(
    (width) => intercomMessageLines(theme, width, view, options),
    "[message display unavailable]",
  );
}
