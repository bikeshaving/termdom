// A menu bar built on the Popover API
//
//   node examples/popover.ts
//
//   The menus are declarative popovers: each menu-bar button carries
//   popovertarget, so opening, toggling, light dismiss and Escape are the
//   platform's. The only JavaScript here is what the menu items do.
//
//   Tab    moves through the menu buttons and the editor
//   Enter  opens the focused menu, activates the focused item
//   Escape closes the open menu; clicking anywhere else does too
//   The saved toast is popover="manual": clicks and Escape cannot
//   dismiss it, and it hides itself.
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	.menubar { display: flex; flex-direction: row; background-color: #1d3557; }
	.menubar button { border: none; padding: 0 1ch; background-color: inherit;
	                  color: #cfe8d8; }
	.menubar button::before, .menubar button::after,
	.menu button::before, .menu button::after { content: ""; }
	.menubar button:focus { background-color: #5fafff; color: black; }
	.menu { position: fixed; inset: auto; top: 1px; margin: 0; padding: 0;
	        border: 1px solid #5fafff; background-color: #0b2135; }
	.menu button { display: block; border: none; background-color: inherit;
	               color: #cfe8d8; padding: 0 1ch; width: 16ch;
	               text-align: left; }
	.menu button:focus { background-color: #5fafff; color: black; }
	#file-menu { left: 0; }
	#edit-menu { left: 7ch; }
	#help-menu { left: 14ch; }
	#about { padding: 1px 2ch; border-color: #ffd75f; }
	#about .title { color: #ffd75f; font-weight: bold; }
	#saved { position: fixed; inset: auto; top: 1px; right: 1ch; margin: 0;
	         border-color: #87d787; color: #87d787; padding: 0 1ch; }
	textarea { border: none; padding: 1px 1ch; width: 100%; height: 12px; }
	.status { color: #666666; }
`;
document.head.appendChild(style);

document.body.innerHTML = `
	<div class="menubar">
		<button popovertarget="file-menu">File</button>
		<button popovertarget="edit-menu">Edit</button>
		<button popovertarget="help-menu">Help</button>
	</div>
	<div id="file-menu" class="menu" popover>
		<button data-action="new">New</button>
		<button data-action="save">Save</button>
		<button data-action="quit">Quit</button>
	</div>
	<div id="edit-menu" class="menu" popover>
		<button data-action="upper">Uppercase</button>
		<button data-action="lower">Lowercase</button>
		<button data-action="clear">Clear</button>
	</div>
	<div id="help-menu" class="menu" popover>
		<button popovertarget="about">About</button>
	</div>
	<div id="about" popover>
		<div class="title">popover.ts</div>
		<div>Menus, a toast and this box are popovers.</div>
		<div>This one stacked on the Help menu.</div>
	</div>
	<div id="saved" popover="manual">Saved.</div>
	<textarea placeholder="type here, then explore the menus…"></textarea>
	<div class="status"> Tab to the menu bar · Enter opens · Escape or a click closes</div>
`;

const editor = document.querySelector("textarea") as HTMLTextAreaElement;
const saved = document.getElementById("saved")!;

// The menus open, close, stack and dismiss on their own. Actions are the
// one thing left to write.
document.addEventListener("click", (event) => {
	const item = (event.target as Element | null)?.closest?.("[data-action]");
	if (!item) {
		return;
	}
	(item.closest("[popover]") as HTMLElement).hidePopover();
	switch (item.getAttribute("data-action")) {
		case "new":
			editor.value = "";
			break;
		case "save":
			saved.showPopover();
			setTimeout(() => saved.hidePopover(), 1500);
			break;
		case "quit":
			term.window.close();
			break;
		case "upper":
			editor.value = editor.value.toUpperCase();
			break;
		case "lower":
			editor.value = editor.value.toLowerCase();
			break;
		case "clear":
			editor.value = "";
			break;
	}
	editor.focus();
});

editor.focus();
