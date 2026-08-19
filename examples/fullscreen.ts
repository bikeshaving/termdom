import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
  .page { padding: 1 2ch; }
  h2 { color: cyan; }
  .hint { color: #666; }
  .stage.fs {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    background-color: #001133; color: white;
  }
  .stage.fs .big { color: cyan; font-weight: bold; }
  .stage.fs .clock { color: yellow; }
  .stage.fs .spinner { color: lightgreen; }
  .stage.fs .hint { color: #557; }
`;
document.head.appendChild(style);

const page = document.createElement("div");
page.className = "page";
page.innerHTML = `
  <h2>Fullscreen demo</h2>
  <div class="stage"><div class="big">This element goes fullscreen.</div><div class="clock"></div><div class="spinner"></div><div class="hint">press f</div></div>
  <div class="hint">f toggles fullscreen · q quits</div>
`;
document.body.appendChild(page);

const stage = page.querySelector(".stage") as HTMLElement;
const clock = stage.querySelector(".clock") as HTMLElement;
const spinner = stage.querySelector(".spinner") as HTMLElement;
const hint = stage.querySelector(".stage .hint") as HTMLElement;

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let tick = 0;
setInterval(() => {
	tick++;
	clock.textContent = new Date().toLocaleTimeString();
	spinner.textContent = `${frames[tick % frames.length]} live while fullscreen ${frames[tick % frames.length]}`;
}, 100);

document.addEventListener("fullscreenchange", () => {
	const fullscreen = document.fullscreenElement === stage;
	stage.classList.toggle("fs", fullscreen);
	hint.textContent = fullscreen ? "f returns · q quits" : "press f";
});

// Keyboard events land on the focused element (or body) and bubble up to
// the document -- never DOWN into children, so listen here.
document.addEventListener("keydown", async (event: KeyboardEvent) => {
	if (event.key === "q") {
		term.window.close();
	}
	if (event.key === "f") {
		if (document.fullscreenElement) {
			await document.exitFullscreen();
		} else {
			await stage.requestFullscreen();
		}
	}
});
