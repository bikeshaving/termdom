// Emoji-presentation clusters (base + U+FE0F) mixed with ASCII, and a token
// after them that changes once the row is on screen. The width tables call
// every one of these two cells; a terminal decides for itself, per glyph, and
// where it decides otherwise the repaint lands in the wrong columns and eats
// the sentinel that follows.
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

term.attach();
term.document.body.innerHTML =
	"<div>☀️☁️\u{1F324}️⛅️❤️ " + "<span id=\"token\">AAAA</span> end</div>";

setTimeout(() => {
	term.document.getElementById("token")!.textContent = "BBBB";
}, 1500);
