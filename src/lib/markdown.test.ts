import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, safeVideoUrl } from "./markdown";

const render = (text: string) => renderToStaticMarkup(createElement("article", null, renderMarkdown(text)));

test("training content retains headings, paragraphs, lists, and inline formatting", () => {
  assert.equal(render("# Heading\r\n\n## Second\n### Third\n\nFirst line\nsecond line.\n\n- **bold**\n- *italic*\n\n1. `code`\n2. [Guide](https://example.com?a=1&b=2)"),
    '<article><h1>Heading</h1><h2>Second</h2><h3>Third</h3><p>First line second line.</p><ul><li><strong>bold</strong></li><li><em>italic</em></li></ul><ol><li><code>code</code></li><li><a href="https://example.com?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Guide</a></li></ol></article>');
});

test("author-supplied HTML and HTML entities stay text, including inside links", () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[<svg/onload=alert(1)>](https://example.com)\n\n&lt;script&gt;');
  assert.doesNotMatch(html, /<(script|img|svg)\b/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;svg\/onload=alert\(1\)&gt;<\/a>/);
  assert.match(html, /&amp;lt;script&amp;gt;/);
});

test("only HTTP and HTTPS links are rendered", () => {
  for (const url of ["javascript:alert", "data:text/html,test", "//example.com", "java&#x73;cript:alert", "javascript\u0000:alert"]) {
    assert.doesNotMatch(render(`[click](${url})`), /<a\b/);
  }
  assert.match(render("[Guide](http://example.com)"), /href="http:\/\/example.com"/);
});

test("formatting never becomes HTML inside a link URL or inline code", () => {
  assert.equal(render('[**Guide**](https://example.com/**path**?x="&y=`code`)'),
    '<article><p><a href="https://example.com/**path**?x=&quot;&amp;y=`code`" target="_blank" rel="noopener noreferrer"><strong>Guide</strong></a></p></article>');
  assert.equal(render('`[link](https://example.com) <img> **literal**`'),
    '<article><p><code>[link](https://example.com) &lt;img&gt; **literal**</code></p></article>');
});

test("video URLs retain HTTPS embeds and reject executable schemes", () => {
  assert.equal(safeVideoUrl("https://www.youtube.com/embed/example"), "https://www.youtube.com/embed/example");
  for (const url of [null, undefined, "", "javascript:alert(1)", "data:text/html,test", "http://example.com", "https://example.com\nscript"]) {
    assert.equal(safeVideoUrl(url), null);
  }
});
