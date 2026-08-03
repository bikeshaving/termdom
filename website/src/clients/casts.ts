/**
 * Mounts the asciinema player into every `.cast-player` box on the page.
 *
 * The player and its stylesheet are only fetched when a page actually has a
 * recording on it, and each player is only created once its box scrolls into
 * view -- a landing page with three recordings should not decode three
 * terminal sessions before the reader has seen the first one.
 */
const boxes = Array.from(
	document.querySelectorAll<HTMLElement>(".cast-player[data-cast-src]"),
);

if (boxes.length > 0) {
	const playerModule = import("asciinema-player");
	import("asciinema-player/dist/bundle/asciinema-player.css");

	const mount = async (box: HTMLElement): Promise<void> => {
		const player = await playerModule;
		const src = box.dataset.castSrc!;
		player.create(src, box, {
			cols: Number(box.dataset.castCols) || undefined,
			rows: Number(box.dataset.castRows) || undefined,
			autoPlay: box.dataset.castAutoplay === "1",
			loop: box.dataset.castLoop === "1",
			idleTimeLimit: Number(box.dataset.castIdle) || undefined,
			preload: true,
			fit: "width",
			terminalFontFamily: "inherit",
		});
	};

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					observer.unobserve(entry.target);
					void mount(entry.target as HTMLElement);
				}
			}
		},
		{rootMargin: "200px"},
	);

	for (const box of boxes) {
		observer.observe(box);
	}
}
