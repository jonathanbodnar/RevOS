/**
 * Tiny Markdown → React renderer for eLearning content.
 *
 * Author content stays in React text nodes and attributes; we never construct
 * HTML strings. Links are restricted to http(s), and their URLs are never
 * reparsed as formatting. Supports: # / ## / ### headings, **bold**,
 * *italic*, `code`, [text](url), - and 1. lists, and paragraphs.
 */
import { createElement, type ReactNode } from "react";

function inline(text: string, allowLinks = true): ReactNode[] {
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  const out: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    if (start > end) out.push(text.slice(end, start));
    const [, code, label, url, bold, italic] = match;
    const key = start;
    if (code !== undefined) {
      out.push(createElement("code", { key }, code));
    } else if (label !== undefined) {
      out.push(allowLinks
        ? createElement("a", { key, href: url, target: "_blank", rel: "noopener noreferrer" }, inline(label, false))
        : match[0]);
    } else if (bold !== undefined) {
      out.push(createElement("strong", { key }, inline(bold, allowLinks)));
    } else {
      out.push(createElement("em", { key }, inline(italic, allowLinks)));
    }
    end = start + match[0].length;
  }
  if (end < text.length) out.push(text.slice(end));
  return out;
}

export function renderMarkdown(md: string): ReactNode[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let listType: "ul" | "ol" | null = null;
  let listItems: ReactNode[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(createElement("p", { key: out.length }, inline(para.join(" "))));
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(createElement(listType, { key: out.length }, listItems));
      listType = null;
      listItems = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);

    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      out.push(createElement(`h${level}`, { key: out.length }, inline(heading[2])));
    } else if (ul || ol) {
      flushPara();
      const want = ul ? "ul" : "ol";
      if (listType !== want) {
        closeList();
        listType = want;
      }
      listItems.push(createElement("li", { key: listItems.length }, inline((ul ?? ol)![1])));
    } else if (line.trim() === "") {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return out;
}

/** Only allow http(s) video URLs; returns null otherwise. */
export function safeVideoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https:\/\/[^\s]+$/.test(url) ? url : null;
}
