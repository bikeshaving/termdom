import {TermDOM} from "../src/termdom.js";
import {renderer} from "@b9g/crank/dom";

const termDOM = new TermDOM();

function *Timer() {
  let seconds = 0;
  const interval = setInterval(() => this.refresh(() => seconds++), 1000);
  for ({} of this) {
    yield <div>{seconds} second{seconds !== 1 && "s"}</div>;
  }

  clearInterval(interval);
}

const document = termDOM.document;
globalThis.Node = termDOM.window.Node;
globalThis.document = termDOM.document;
renderer.render(<Timer />, document.body);
