/**
 * A program in a box: <embed type="application/x-pty"> runs its src in a
 * pseudo-terminal and draws its screen in the embed. The embed has focus,
 * so keys go to the program, Ctrl+C included. Ctrl+Q quits. The command
 * is the first argument, top by default. Bun has a pseudo-terminal of its
 * own. Elsewhere the embed fires error and the status line says so.
 */
import {TermDOM} from "@b9g/termdom";

const command = process.argv[2] ?? "top";
const term = new TermDOM({ptyEmbeds: "auto"});
term.attach();
const {document} = term;

document.body.innerHTML = `
  <style>
    body { display: flex; flex-direction: column; height: 100vh; }
    header, footer { padding: 0 1ch; background: #303030; color: #d0d0d0; }
    embed { flex: 1; min-height: 0; }
  </style>
  <header><b></b></header>
  <embed type="application/x-pty">
  <footer>starting · Ctrl+Q quits</footer>
`;

const embed = document.querySelector("embed")!;
const footer = document.querySelector("footer")!;
document.querySelector("b")!.textContent = command;

function status(text: string): void {
  footer.textContent = `${text} · Ctrl+Q quits`;
}

embed.addEventListener("load", () => status("running"));
embed.addEventListener("close", () => status("exited"));
embed.addEventListener("error", (event) =>
  status((event as ErrorEvent).message),
);
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "q") {
    event.preventDefault();
    void term.dispose();
  }
});
embed.setAttribute("src", command);
embed.focus();
