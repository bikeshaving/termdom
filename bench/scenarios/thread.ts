/**
 * A discussion thread laid out the way Hacker News lays one out: no
 * doctype, so quirks mode, and every comment a table nested in a row of
 * the page's table, indented by a spacer image. Thousands of nested
 * tables make the first layout size columns at every level, and the
 * text is made up, so the page can live in the repository.
 */
import {cpuMs, MockProcess, nextFrame, report, TermDOM} from "../harness.ts";

const COMMENTS = 1800;

const WORDS = (
	"the of a to in is that it for on with as was be this are by not or at " +
	"from but have an they which one you were all we there can been has more " +
	"if will would about some what when out up into so no time could them " +
	"than other then its only also after first even new because any these " +
	"most well work way should people layout terminal browser render cache"
).split(" ");

let seed = 1;

function next(): number {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
}

function sentence(): string {
	const length = 6 + Math.floor(next() * 18);
	const words = Array.from({length}, () => WORDS[Math.floor(
		next() * WORDS.length,
	)]);
	if (next() < 0.2) {
		words[Math.floor(next() * length)] =
			`<a href="https://example.com/${Math.floor(next() * 1e6)}">link</a>`;
	}
	if (next() < 0.15) {
		words[Math.floor(next() * length)] = "<i>this</i>";
	}
	return words.join(" ") + ".";
}

function paragraph(): string {
	const count = 1 + Math.floor(next() * 4);
	return Array.from({length: count}, sentence).join(" ");
}

function comment(id: number, depth: number): string {
	const paragraphs = 1 + Math.floor(next() * 3);
	const [first, ...rest] = Array.from({length: paragraphs}, paragraph);
	return `<tr class="athing comtr" id="${id}"><td><table border="0"><tr>
<td class="ind" indent="${depth}"><img src="s.gif" height="1" width="${depth * 40}"></td>
<td valign="top" class="votelinks"><center><a id="up_${id}" href="vote?id=${id}&amp;how=up"><div class="votearrow" title="upvote"></div></a></center></td>
<td class="default"><div style="margin-top:2px; margin-bottom:-10px;"><span class="comhead">
<a href="user?id=u${id % 97}" class="hnuser">user${id % 97}</a> <span class="age" title="2026-10-16"><a href="item?id=${id}">${1 + (id % 23)} hours ago</a></span> <span id="unv_${id}"></span><span class="navs"> | <a href="#${id - 1}" class="clicky">prev</a> | <a href="#${id + 1}" class="clicky">next</a> <a class="togg clicky" id="${id}" n="1" href="javascript:void(0)">[–]</a></span></span></div><br>
<div class="comment"><div class="commtext c00">${first}${rest.map((text) => `<p>${text}</p>`).join("")}</div>
<div class="reply"><p><font size="1"><u><a href="reply?id=${id}" rel="nofollow">reply</a></u></font></p></div></div></td></tr></table></td></tr>`;
}

const comments: string[] = [];
let depth = 0;
for (let id = 1; id <= COMMENTS; id++) {
	comments.push(comment(id, depth));
	const step = next();
	depth = step < 0.45
		? depth + 1
		: step < 0.75 ? depth : Math.max(0, depth - 1 - Math.floor(next() * 3));
	depth = Math.min(depth, 12);
}

const html = `<html lang="en" op="item"><head><style>
body { font-family: Verdana, Geneva, sans-serif; font-size: 10pt; color: #828282; }
td { font-family: Verdana, Geneva, sans-serif; font-size: 10pt; color: #828282; }
a:link { color: #000000; text-decoration: none; }
a:visited { color: #828282; text-decoration: none; }
.default { font-family: Verdana, Geneva, sans-serif; font-size: 10pt; color: #828282; }
.title { font-family: Verdana, Geneva, sans-serif; font-size: 10pt; color: #828282; overflow: hidden; }
.subtext { font-family: Verdana, Geneva, sans-serif; font-size: 7pt; color: #828282; }
.comment { font-family: Verdana, Geneva, sans-serif; font-size: 9pt; }
.comhead { font-family: Verdana, Geneva, sans-serif; font-size: 8pt; color: #828282; }
.comhead a:link, .subtext a, .subline a { color: #828282; }
.hnuser { color: #3c963c; }
.c00, .c00 a:link { color: #000000; }
.commtext p { margin-top: 6px; margin-bottom: 0; }
.votearrow { width: 10px; height: 10px; border: 0px; margin: 3px 2px 6px; }
.noshow { display: none; }
.nosee { visibility: hidden; pointer-events: none; cursor: default; }
.reply { font-size: 8pt; }
#hnmain { min-width: 796px; }
</style><title>A thread</title></head><body><center>
<table id="hnmain" border="0" cellpadding="0" cellspacing="0" width="85%" bgcolor="#f6f6ef">
<tr><td bgcolor="#ff6600"><table border="0" cellpadding="0" cellspacing="0" width="100%" style="padding:2px"><tr>
<td style="width:18px;padding-right:4px"><a href="/"><img src="y18.svg" width="18" height="18"></a></td>
<td style="line-height:12pt; height:10px;"><span class="pagetop"><b class="hnname"><a href="news">Hacker News</a></b>
<a href="newest">new</a> | <a href="front">past</a> | <a href="newcomments">comments</a> | <a href="ask">ask</a></span></td>
<td style="text-align:right;padding-right:4px;"><span class="pagetop"><a href="login">login</a></span></td>
</tr></table></td></tr>
<tr id="bigbox"><td><table class="fatitem" border="0"><tr class="athing submission" id="0">
<td align="right" valign="top" class="title"><span class="rank"></span></td>
<td class="title"><span class="titleline"><a href="https://example.com/">A long discussion</a></span></td></tr>
<tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score">812 points</span> by <a href="user?id=op" class="hnuser">op</a> | <a href="item?id=0">${COMMENTS} comments</a></span></td></tr>
</table><br><br><table border="0" class="comment-tree">${comments.join("\n")}</table><br><br></td></tr>
</table></center></body></html>`;

const times: number[] = [];
for (let i = 0; i < 3; i++) {
	const proc = new MockProcess({cols: 100, rows: 50});
	const start = cpuMs();
	const dom = new TermDOM({
		html,
		transport: proc.transport,
		cellSize: {width: 8, height: 16},
	});
	dom.attach();
	await nextFrame(dom);
	if (i >= 1) {
		times.push(cpuMs() - start);
	}
	dom.dispose();
}
report(`thread: ${COMMENTS} nested comment tables to first frame`, times);
