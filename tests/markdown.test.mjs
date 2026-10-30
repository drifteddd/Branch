import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, safeUrl } from "../app/ui/shared/markdown.js";

test("html in descriptions is escaped, never run", () => {
  const html = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)> <iframe src="https://x"></iframe>');
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<iframe"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("only http and https links become links", () => {
  assert.match(renderMarkdown("[ok](https://github.com/x)"), /<a href="https:\/\/github.com\/x"/);
  assert.ok(!renderMarkdown("[bad](javascript:alert(1))").includes("<a"));
  assert.ok(!renderMarkdown("[bad](data:text/html,hi)").includes("<a"));
  assert.ok(!renderMarkdown('[q](https://x.com/"onmouseover="alert(1))').includes('"onmouseover'));
  assert.equal(safeUrl("file:///c:/windows"), null);
  assert.equal(safeUrl("https://user:pw@x.com"), null);
});

test("basic formatting works", () => {
  const html = renderMarkdown("# Title\n\n**bold** and *italic* and `code`\n\n- one\n- two\n\n1. a\n2. b\n\n```\n<b>raw</b>\n```");
  assert.ok(html.includes("<h3>Title</h3>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>italic</em>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes("<ul><li>one</li><li>two</li></ul>"));
  assert.ok(html.includes("<ol><li>a</li><li>b</li></ol>"));
  assert.ok(html.includes("<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>"));
});

test("empty input gives empty output", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
});

test("tables render with escaped cells", () => {
  const html = renderMarkdown("| a | b |\n| --- | --- |\n| <i>x</i> | **y** |");
  assert.ok(html.startsWith("<table><thead><tr><th>a</th><th>b</th></tr></thead>"));
  assert.ok(html.includes("<td>&lt;i&gt;x&lt;/i&gt;</td>"));
  assert.ok(html.includes("<td><strong>y</strong></td>"));
});