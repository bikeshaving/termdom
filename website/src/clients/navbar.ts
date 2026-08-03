import {jsx} from "@b9g/crank/standalone";
import {renderer} from "@b9g/crank/dom";

import {Navbar} from "../components/navbar.js";

renderer.hydrate(
	jsx`<${Navbar} url=${new URL(window.location.href).pathname} />`,
	document.getElementById("navbar-root")!,
);
